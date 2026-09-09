import { searchInRange, type Memory, type MemoryScope } from "./memory";
import { resolveRange, RELATIVE_RANGES } from "./timerange";

/**
 * The corpus for a time window, as something you can hand to a model.
 *
 * This exists because "what did we work out this week" is a question the archive
 * can answer with rows but not with an answer. Rows are the wrong shape for
 * that: a JSON array of memory objects spends most of its tokens on ids,
 * timestamps and repeated field names, and arrives with no structure a model can
 * lean on. Markdown grouped by kind arrives already organised — and the grouping
 * is the summary's outline before a model writes a word of it.
 *
 * Deliberately NOT a summary. This server does not call an LLM; it assembles the
 * material and hands it over. Summarising here would mean an opinion baked into
 * the corpus, and a dependency on a model being reachable to read your own
 * memories.
 */

export interface DigestInput extends MemoryScope {
  /** A relative window (`today`, `last_7days`) or a month (`2026_08`). */
  window: string;
  /** Only memories whose text contains this. */
  query?: string;
  limit?: number;
  /** Trim each memory's body to this. 0 means whole bodies. */
  excerpt?: number;
}

export interface Digest {
  window: string;
  label: string;
  fromIso: string;
  toIso: string;
  count: number;
  /** Counts per kind, so a caller can see the shape without reading the text. */
  byKind: Record<string, number>;
  memories: Memory[];
  markdown: string;
}

/** The windows a caller may name, for the error message and for discovery. */
export function digestWindows(): string[] {
  return Object.keys(RELATIVE_RANGES);
}

/**
 * Order the kinds appear in, most-reflective first.
 *
 * A summary reads better when it opens with what was understood and closes with
 * what was produced, rather than in whatever order the database returned rows.
 * Unknown kinds sort last rather than being dropped — a kind added later must
 * still show up.
 */
const KIND_ORDER = ["enlighten", "learn", "retro", "artifact"];

function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

/** `2026-08-28T09:14:02.123Z` → `2026-08-28 09:14`, which is what a reader wants. */
function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function scopeLine(input: DigestInput): string {
  const list = (v: unknown) =>
    v === undefined ? "" : (Array.isArray(v) ? v : [v]).filter(Boolean).join(", ");
  const parts = [
    list(input.workspace) && `workspace: ${list(input.workspace)}`,
    list(input.project) && `project: ${list(input.project)}`,
    list(input.createdBy) && `agent: ${list(input.createdBy)}`,
    list(input.kind) && `kind: ${list(input.kind)}`,
    input.query && `matching “${input.query}”`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "the whole corpus";
}

export async function buildDigest(input: DigestInput): Promise<Digest | null> {
  const range = resolveRange(input.window);
  if (!range) return null;

  const memories = await searchInRange({
    fromIso: range.fromIso,
    toIso: range.toIso,
    query: input.query,
    kind: input.kind,
    workspace: input.workspace,
    project: input.project,
    createdBy: input.createdBy,
    limit: input.limit ?? 100,
    label: range.label,
    source: "digest",
  });

  const byKind: Record<string, number> = {};
  for (const m of memories) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;

  const grouped = [...memories].sort(
    (a, b) =>
      kindRank(a.kind) - kindRank(b.kind) ||
      b.importance - a.importance ||
      a.createdAt.localeCompare(b.createdAt),
  );

  const lines: string[] = [];
  lines.push(`# Memory digest — ${range.label}`);
  lines.push("");
  // The scope is stated in the document, not only in the request that produced
  // it. A digest gets pasted somewhere else and read out of context; without
  // this, "3 memories" reads as "the team did almost nothing" rather than
  // "one workspace, filtered to one kind, did three things".
  lines.push(`Scope: ${scopeLine(input)}`);
  lines.push(`Window: ${stamp(range.fromIso)} → now`);
  lines.push(
    `${memories.length} ${memories.length === 1 ? "memory" : "memories"}` +
      (Object.keys(byKind).length
        ? ` — ${Object.entries(byKind)
            .sort((a, b) => kindRank(a[0]) - kindRank(b[0]))
            .map(([k, n]) => `${n} ${k}`)
            .join(", ")}`
        : ""),
  );

  if (!memories.length) {
    lines.push("");
    lines.push(
      "Nothing was written in this window. That is a fact about the window, not " +
        "an error — do not infer inactivity elsewhere from it.",
    );
    return { ...range, window: input.window, count: 0, byKind, memories, markdown: lines.join("\n") };
  }

  let lastKind = "";
  for (const m of grouped) {
    if (m.kind !== lastKind) {
      lines.push("");
      lines.push(`## ${m.kind}`);
      lastKind = m.kind;
    }
    lines.push("");
    lines.push(`### ${m.title}`);
    const meta = [
      stamp(m.createdAt),
      m.workspace && `workspace ${m.workspace}`,
      m.project && `project ${m.project}`,
      m.createdBy && `by ${m.createdBy}`,
      `importance ${m.importance}/5`,
      m.tags.length ? m.tags.map((t) => `#${t}`).join(" ") : "",
    ].filter(Boolean);
    lines.push(`*${meta.join(" · ")}*`);
    lines.push("");
    const body =
      input.excerpt && m.content.length > input.excerpt
        ? `${m.content.slice(0, input.excerpt).trimEnd()}…`
        : m.content;
    lines.push(body);
  }

  return {
    window: input.window,
    label: range.label,
    fromIso: range.fromIso,
    toIso: range.toIso,
    count: memories.length,
    byKind,
    memories,
    markdown: lines.join("\n"),
  };
}
