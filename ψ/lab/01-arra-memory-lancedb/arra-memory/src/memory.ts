import {
  andWhere,
  byNewest,
  FTS_COLUMN,
  inList,
  likePattern,
  lit,
  plain,
  scan,
  table,
  topRows,
} from "./db";
import { recordSearch } from "./searchlog";
import {
  clampLimit,
  makeMemoryTitle,
  normalizeCreatedBy,
  normalizeImportance,
  normalizeKind,
  normalizeProject,
  normalizeSource,
  normalizeTags,
  normalizeText,
  normalizeUrl,
  normalizeWorkspace,
  nowIso,
  readKind,
  type MemoryKind,
} from "./utils";

/**
 * The memory corpus. Every read and write goes through the `memories` Lance
 * table opened in db.ts; this file owns validation, filter building, ranking,
 * and shaping rows into objects.
 *
 * Where the libSQL version put ORDER BY and GROUP BY in the database, this one
 * does them here, after a scan that selects only the columns it needs. At the
 * scale a personal corpus lives at that is the cheaper of the two — and every
 * ranking rule is then an ordinary comparator you can read.
 */

export interface Memory {
  id: string;
  title: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  source: string;
  importance: number;
  workspace: string;
  project: string;
  url: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  title?: string;
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  source?: string;
  importance?: number;
  /** The team-level namespace. One workspace holds many projects. */
  workspace?: string;
  project?: string;
  url?: string;
  createdBy?: string;
}

export type UpdateMemoryInput = Partial<CreateMemoryInput>;

/**
 * One filter value, or several.
 *
 * Every facet is optional and every omitted facet means "do not narrow on
 * this". That is the multi-agent contract: workspace and agent are FILTERS, not
 * boundaries — an unscoped search still sees the entire corpus, so nothing an
 * agent writes can be hidden from a human looking for it.
 *
 * A bare string is one value and stays the shape every MCP tool passes; an array
 * is "any of these", which is what a row of chips produces when more than one is
 * ticked. Undefined or empty means no filtering on that facet.
 */
export type ScopeValue = string | string[] | undefined;

export interface MemoryScope {
  kind?: MemoryKind | MemoryKind[];
  /** Workspace(s) — the tier above project. */
  workspace?: ScopeValue;
  /** Project(s) — the facet the dynamic MCP tools filter on. */
  project?: ScopeValue;
  /** Agent(s), against the `created_by` column. */
  createdBy?: ScopeValue;
}

export interface SearchMemoryInput extends MemoryScope {
  query?: string;
  /** Case-insensitive match against one of the memory's tags. */
  tag?: string;
  limit?: number;
  /** Where the search came from — "mcp", "web". Recorded in the log. */
  source?: string;
}

/**
 * A scope value as the list of values a filter should accept.
 *
 * Empty means "do not filter on this", which is the default and what every
 * omitted facet becomes — so an unscoped search still sees the whole corpus.
 * Blank entries are dropped rather than matched: a chip row with nothing ticked
 * and a chip row ticked to "" must not mean different things.
 */
function scopeSet(value: ScopeValue, normalize: (v: string | undefined) => string): string[] {
  const list = (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map((v) => normalize(v))
    .filter((v) => v !== "");
  return [...new Set(list)];
}

/**
 * The scope as a WHERE fragment, or undefined when nothing is narrowed.
 *
 * Within a facet it is OR (any of these workspaces); across facets it is AND
 * (that workspace AND that agent), which is what someone ticking boxes expects.
 * Every value goes through `lit`; nothing is interpolated raw.
 */
function scopeWhere(scope: MemoryScope): string | undefined {
  const kind = scopeSet(scope.kind as ScopeValue, (v) => (v ? normalizeKind(v) : ""));
  const workspace = scopeSet(scope.workspace, normalizeWorkspace);
  const project = scopeSet(scope.project, normalizeProject);
  const createdBy = scopeSet(scope.createdBy, normalizeCreatedBy);
  return andWhere(
    kind.length && `kind IN ${inList(kind)}`,
    workspace.length && `workspace IN ${inList(workspace)}`,
    project.length && `project IN ${inList(project)}`,
    createdBy.length && `created_by IN ${inList(createdBy)}`,
  );
}

/**
 * A scope value as one string, for the search log.
 *
 * The log has a single TEXT column per facet, and it is read by a human asking
 * "what was this search narrowed to" — so several ticked chips become
 * "a, b" rather than being truncated to the first or dropped entirely.
 */
function scopeLabel(value: ScopeValue): string {
  if (value === undefined) return "";
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join(", ");
}

export interface MemoryStats {
  total: number;
  kinds: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  latestUpdatedAt: string | null;
}

interface MemoryRow {
  id: string;
  title: string;
  content: string;
  kind: string;
  tags: string[];
  source: string;
  importance: number;
  workspace: string;
  project: string;
  url: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Everything a Memory needs — the vector and the FTS column stay on disk. */
const MEMORY_COLUMNS = [
  "id", "title", "content", "kind", "tags", "source", "importance",
  "workspace", "project", "url", "created_by", "created_at", "updated_at",
];

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    // readKind, not normalizeKind — a stored row must never fail to load.
    kind: readKind(row.kind),
    tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [],
    source: row.source,
    importance: Number(row.importance),
    workspace: row.workspace ?? "",
    project: row.project ?? "",
    url: row.url ?? "",
    createdBy: row.created_by ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The text the full-text index covers: title, body and tags, joined.
 *
 * Kept as its own column because the index can only cover one, and because a
 * substring test at query time must see exactly what the index saw. Written
 * on every insert and update; never read back as data.
 */
function ftsText(title: string, content: string, tags: string[]): string {
  return `${title}\n${content}\n${tags.join(" ")}`;
}

/**
 * A list as an UPDATE can store it. An empty list has to go in as NULL — the
 * engine cannot build an empty array literal — and comes back out as [] via
 * toMemory, so no caller ever sees the difference.
 */
const listValue = (values: string[]): string[] | null => (values.length ? values : null);

/** Newest first, importance breaking ties — the archive's default order. */
const newestFirst = (a: Memory, b: Memory) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.importance - a.importance;

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  const content = normalizeText(input.content, "content", 12_000);
  // A missing title is inferred rather than rejected: the MCP client usually
  // has content and no title, and refusing would make `remember` awkward.
  const title = normalizeText(
    input.title?.trim() || makeMemoryTitle(content),
    "title",
    160,
  );
  const kind = normalizeKind(input.kind);
  const tags = normalizeTags(input.tags);
  const source = normalizeSource(input.source);
  const importance = normalizeImportance(input.importance);
  const workspace = normalizeWorkspace(input.workspace);
  const project = normalizeProject(input.project);
  const url = normalizeUrl(input.url);
  const createdBy = normalizeCreatedBy(input.createdBy);
  const now = nowIso();
  const id = crypto.randomUUID();

  const t = await table("memories");
  await t.add([
    {
      id, title, content, kind, tags, source, importance,
      workspace, project, url, created_by: createdBy,
      created_at: now, updated_at: now,
      fts_text: ftsText(title, content, tags),
      embedding: null,
      embedding_model: "",
    },
  ]);

  const memory: Memory = {
    id, title, content, kind, tags, source, importance,
    workspace, project, url, createdBy, createdAt: now, updatedAt: now,
  };

  // Indexed HERE, not at the call sites. Every surface that writes a memory —
  // REST, MCP `remember`, anything added later — gets a vector without having
  // to remember to ask for one. It was a call-site concern until 2026-08-28,
  // and MCP was the call site that never asked: memories written by claude.ai
  // and Claude Code went in unembedded, the map stayed empty, and nothing
  // reported a fault. Fire-and-forget on purpose (see indexMemory): the row is
  // already durable, and a dead embedding server must never fail a write.
  void indexMemory(memory);

  return memory;
}

/** ngram(3,3)'s floor: a query shorter than this cannot use the FTS index. */
const TRIGRAM_MIN = 3;

/**
 * Every search records itself.
 *
 * The recording lives INSIDE the search functions, not at their call sites.
 * There are six ways to reach a search — recall_memories, each generated
 * project tool, every time-window tool, search_memories_between, the web API,
 * and hybrid recall — and a log wired up at call sites is one forgotten call
 * away from answering "what did I search for" with a confident, partial lie.
 *
 * Put it where the search actually happens and no caller can omit it.
 */
async function logged<T extends { id: string }>(
  run: () => Promise<T[]>,
  meta: {
    query?: string;
    mode: string;
    kind?: string;
    workspace?: string;
    project?: string;
    tag?: string;
    source?: string;
  },
): Promise<T[]> {
  const started = Date.now();
  const results = await run();

  // An empty query is a LISTING, not a search. The UI refetches the whole
  // archive on load and on every filter change, and recording those buries the
  // handful of entries anyone actually wants to read under a wall of
  // "(empty query) → 4 results". "What was I searching for" is the question;
  // scrolling a list is not an answer to it.
  if ((meta.query ?? "").trim()) {
    // Fire-and-forget. The caller already has its answer, and searchlog.ts
    // swallows every failure — observability must not cost the thing observed.
    void recordSearch({
      ...meta,
      resultIds: results.map((r) => r.id),
      durationMs: Date.now() - started,
      source: meta.source ?? "internal",
    });
  }
  return results;
}

export async function searchMemories(
  input: SearchMemoryInput = {},
): Promise<Memory[]> {
  return logged(() => searchMemoriesNoLog(input), {
    query: input.query,
    mode: "keyword",
    kind: scopeLabel(input.kind as ScopeValue),
    workspace: scopeLabel(input.workspace),
    project: scopeLabel(input.project),
    tag: input.tag,
    source: input.source,
  });
}

/** The tag filter, case-insensitive against the memory's own tags. */
function hasTag(memory: Memory, tag: string): boolean {
  return memory.tags.some((t) => t.toLocaleLowerCase() === tag);
}

/**
 * The same search without recording, for composing internally.
 *
 * Hybrid recall runs a keyword AND a semantic pass for ONE user action; if both
 * logged themselves the log would double-count every hybrid search. The caller
 * that composes them logs once, as "hybrid".
 */
export async function searchMemoriesNoLog(
  input: SearchMemoryInput = {},
): Promise<Memory[]> {
  const t = await table("memories");
  const query = (input.query ?? "").trim().slice(0, 240);
  const lower = query.toLocaleLowerCase();
  const tag = (input.tag ?? "").trim().toLocaleLowerCase();
  const limit = clampLimit(input.limit);
  const scope = scopeWhere(input);

  // An id, or the front of one, is answered directly.
  //
  // Checked BEFORE the text paths because neither can succeed: the FTS column
  // holds title, content and tags — an id is in none of them. Without this,
  // pasting an id returns "nothing matches", which is how the atlas's own
  // "open in Memory" button led to an empty list.
  //
  // Eight characters is the threshold: that is the short form shown throughout
  // the UI, and it is long enough that a real word will not collide with it.
  if (/^[0-9a-f]{8}[0-9a-f-]*$/i.test(query)) {
    const byId = await scan<MemoryRow>(t, {
      where: `id LIKE ${lit(likePattern(lower).slice(1))}`,
      columns: MEMORY_COLUMNS,
    });
    const found = byId.map(toMemory).sort(newestFirst).slice(0, limit);
    if (found.length) return found;
    // No match falls through rather than returning empty: a hex-looking string
    // might genuinely be text someone wrote.
  }

  // An empty query lists the archive: newest first, whatever the scope. Only
  // the sort keys are read for the ordering; the winners are fetched in full.
  if (!query && !tag) {
    const rows = await topRows<MemoryRow>(t, {
      where: scope,
      sortColumns: ["updated_at", "importance"],
      compare: byNewest("updated_at"),
      limit,
    });
    return rows.map(toMemory);
  }

  // The indexed path, when the query is long enough for a trigram.
  //
  // The inverted index ORs the query's trigrams, so a candidate may match on a
  // fragment ("bra" in "zebras" finds "brand"). The libSQL version's phrase
  // MATCH meant "contains this exact text", and that is kept by re-testing
  // every candidate against the text the index saw — so the index chooses the
  // order and the substring test chooses membership.
  if (query.length >= TRIGRAM_MIN) {
    try {
      const candidates = await t
        .search(query, "fts", FTS_COLUMN)
        .where(scope ?? "true")
        .select([...MEMORY_COLUMNS, "fts_text"])
        // Wide enough that the true substring matches are among them even
        // when many rows share a trigram or two with the query.
        .limit(Math.max(limit * 5, 200))
        .toArray();

      const ranked = candidates
        .map((r: unknown) => plain<MemoryRow & { fts_text: string; _score: number }>(r))
        .filter((r) => String(r.fts_text).toLocaleLowerCase().includes(lower))
        .map((r) => {
          const memory = toMemory(r);
          // The index cannot weight fields, so the weighting the original
          // gave BM25 — title 3×, tags 2×, content 1× — is applied here:
          // a query that matches a title outranks one buried in a paragraph.
          const inTitle = memory.title.toLocaleLowerCase().includes(lower);
          const inTags = memory.tags.some((x) => x.toLocaleLowerCase().includes(lower));
          const score = Number(r._score) * (1 + (inTitle ? 2 : 0) + (inTags ? 1 : 0));
          return { memory, score };
        })
        .filter((x) => !tag || hasTag(x.memory, tag))
        .sort((a, b) => b.score - a.score || newestFirst(a.memory, b.memory))
        .slice(0, limit)
        .map((x) => x.memory);
      return ranked;
    } catch {
      // An FTS failure must never mean "no results" — a missing or corrupt
      // index degrades to the scan below rather than lying about the corpus.
    }
  }

  // Honest substring search for what the index cannot serve: queries shorter
  // than a trigram, or a tag filter with no query. Ranked by how well the hit
  // matches rather than by relevance magic.
  const rows = await scan<MemoryRow>(t, {
    where: andWhere(
      query && `lower(${FTS_COLUMN}) LIKE ${lit(likePattern(lower))}`,
      scope,
    ),
    columns: MEMORY_COLUMNS,
  });

  const rank = (m: Memory): number => {
    if (!query) return 3;
    const title = m.title.toLocaleLowerCase();
    if (title === lower) return 0;
    if (title.includes(lower)) return 1;
    if (m.tags.some((x) => x.toLocaleLowerCase().includes(lower))) return 2;
    return 3;
  };

  return rows
    .map(toMemory)
    .filter((m) => !tag || hasTag(m, tag))
    // Newest first within a rank. Importance used to lead here, which meant
    // the archive opened on whatever had been marked important rather than on
    // what just happened — and "what did I write today" is the question a
    // memory list is actually opened with. Importance still breaks ties.
    .sort((a, b) => rank(a) - rank(b) || newestFirst(a, b))
    .slice(0, limit);
}

export async function getMemory(id: string): Promise<Memory | null> {
  const t = await table("memories");
  const [row] = await scan<MemoryRow>(t, {
    where: `id = ${lit(normalizeText(id, "id", 100))}`,
    columns: MEMORY_COLUMNS,
    limit: 1,
  });
  return row ? toMemory(row) : null;
}

export async function updateMemory(
  id: string,
  input: UpdateMemoryInput,
): Promise<Memory | null> {
  const existing = await getMemory(id);
  if (!existing) return null;

  // Every field falls back to what is already stored, so a partial update
  // never blanks a column the caller did not mention.
  const content =
    input.content === undefined
      ? existing.content
      : normalizeText(input.content, "content", 12_000);
  const title =
    input.title === undefined ? existing.title : normalizeText(input.title, "title", 160);
  const kind = input.kind === undefined ? existing.kind : normalizeKind(input.kind);
  const tags = input.tags === undefined ? existing.tags : normalizeTags(input.tags);
  const source =
    input.source === undefined ? existing.source : normalizeSource(input.source);
  const importance =
    input.importance === undefined
      ? existing.importance
      : normalizeImportance(input.importance);
  const workspace =
    input.workspace === undefined ? existing.workspace : normalizeWorkspace(input.workspace);
  const project =
    input.project === undefined ? existing.project : normalizeProject(input.project);
  const url = input.url === undefined ? existing.url : normalizeUrl(input.url);
  const createdBy =
    input.createdBy === undefined ? existing.createdBy : normalizeCreatedBy(input.createdBy);
  const updatedAt = nowIso();

  const t = await table("memories");
  await t.update({
    where: `id = ${lit(existing.id)}`,
    values: {
      title, content, kind, tags: listValue(tags), source, importance,
      workspace, project, url, created_by: createdBy, updated_at: updatedAt,
      fts_text: ftsText(title, content, tags),
    },
  });

  // createdAt is deliberately not touched: a revision is the same memory.
  const memory: Memory = {
    ...existing,
    title, content, kind, tags, source, importance,
    workspace, project, url, createdBy, updatedAt,
  };

  // Re-embed only when the embedded TEXT changed. indexMemory embeds
  // `title\n\ncontent`, so a tag, importance or project edit cannot move the
  // vector and must not pay for an embed call.
  //
  // This is the failure that could not heal itself: backfill finds rows whose
  // vector is missing or came from another model, so a revised memory —
  // vector present, model matching — is invisible to it forever. Its vector
  // goes on describing text that no longer exists, and semantic search keeps
  // matching the old words. An empty map announces itself; this one does not.
  if (title !== existing.title || content !== existing.content) {
    void indexMemory(memory);
  }

  return memory;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const t = await table("memories");
  const result = await t.delete(`id = ${lit(normalizeText(id, "id", 100))}`);
  return Number(result.numDeletedRows ?? 0) > 0;
}

// ── facets: one scan, every aggregate ────────────────────────────────────────

interface FacetRow {
  kind: string;
  workspace: string;
  project: string;
  created_by: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** The few narrow columns every GROUP BY below is computed from. */
async function facetRows(): Promise<FacetRow[]> {
  const t = await table("memories");
  return scan<FacetRow>(t, {
    columns: ["kind", "workspace", "project", "created_by", "tags", "created_at", "updated_at"],
  });
}

/** Count and latest timestamp per distinct value, busiest first, then A→Z. */
function tally(
  rows: FacetRow[],
  key: (r: FacetRow) => string,
): Array<{ value: string; count: number; latest: string }> {
  const out = new Map<string, { count: number; latest: string }>();
  for (const r of rows) {
    const v = key(r);
    if (!v) continue;
    const cur = out.get(v) ?? { count: 0, latest: "" };
    cur.count++;
    if (r.updated_at > cur.latest) cur.latest = r.updated_at;
    out.set(v, cur);
  }
  return [...out.entries()]
    .map(([value, { count, latest }]) => ({ value, count, latest }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function tallyTags(rows: FacetRow[]): Array<{ tag: string; count: number }> {
  const out = new Map<string, number>();
  for (const r of rows) for (const tag of r.tags ?? []) out.set(tag, (out.get(tag) ?? 0) + 1);
  return [...out.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

const inWorkspace = (rows: FacetRow[], workspace?: string) => {
  const ws = normalizeWorkspace(workspace);
  return ws ? rows.filter((r) => r.workspace === ws) : rows;
};

export async function getMemoryStats(): Promise<MemoryStats> {
  const rows = await facetRows();
  let latest: string | null = null;
  for (const r of rows) if (latest === null || r.updated_at > latest) latest = r.updated_at;
  return {
    total: rows.length,
    kinds: Object.fromEntries(tally(rows, (r) => r.kind).map((k) => [k.value, k.count])),
    topTags: tallyTags(rows).slice(0, 8),
    latestUpdatedAt: latest,
  };
}

export interface ProjectFacet {
  project: string;
  count: number;
  latest: string;
}

/**
 * Distinct projects in the corpus, busiest first.
 *
 * This is the query that makes `tools/list` dynamic: each project returned here
 * becomes its own recall tool, so a model sees `recall_haos_oracle` rather than
 * having to know that `project` is a parameter and guess its value.
 */
export async function listProjects(
  limit = 20,
  workspace?: string,
): Promise<ProjectFacet[]> {
  const rows = inWorkspace(await facetRows(), workspace);
  return tally(rows, (r) => r.project)
    .slice(0, clampLimit(limit, 20))
    .map(({ value, count, latest }) => ({ project: value, count, latest }));
}

/**
 * Every tag in the corpus with its use count, busiest first — optionally only
 * the tags actually used inside one workspace.
 *
 * A tag vocabulary is only useful if it is the vocabulary of the thing you are
 * looking at; the whole corpus's tag list is noise to an agent working in one
 * workspace, which is what makes this the "combo with tags" half of the design.
 */
export async function listTags(
  limit = 50,
  workspace?: string,
): Promise<Array<{ tag: string; count: number }>> {
  const rows = inWorkspace(await facetRows(), workspace);
  return tallyTags(rows).slice(0, clampLimit(limit, 50));
}

export interface WorkspaceFacet {
  workspace: string;
  count: number;
  /** Distinct non-empty projects filed under it. */
  projects: number;
  /** Distinct non-empty `created_by` values that have written to it. */
  agents: number;
  latest: string;
}

function tallyWorkspaces(rows: FacetRow[], limit: number): WorkspaceFacet[] {
  const out = new Map<
    string,
    { count: number; projects: Set<string>; agents: Set<string>; latest: string }
  >();
  for (const r of rows) {
    if (!r.workspace) continue;
    const cur = out.get(r.workspace) ?? {
      count: 0, projects: new Set(), agents: new Set(), latest: "",
    };
    cur.count++;
    if (r.project) cur.projects.add(r.project);
    if (r.created_by) cur.agents.add(r.created_by);
    if (r.updated_at > cur.latest) cur.latest = r.updated_at;
    out.set(r.workspace, cur);
  }
  return [...out.entries()]
    .map(([workspace, v]) => ({
      workspace, count: v.count, projects: v.projects.size, agents: v.agents.size, latest: v.latest,
    }))
    .sort((a, b) => b.count - a.count || a.workspace.localeCompare(b.workspace))
    .slice(0, limit);
}

/**
 * The workspaces, busiest first, plus how many memories name none.
 *
 * There is no workspaces table — this tally IS the list. A workspace comes into
 * existence the moment an agent writes into it and disappears when its last
 * memory leaves, which is why creating one needs no endpoint and no ceremony.
 *
 * `unassigned` is returned alongside because the list itself excludes the unset
 * bucket, and a page that showed only these rows would quietly account for less
 * than the whole corpus.
 */
export async function listWorkspaces(
  limit = 50,
): Promise<{ workspaces: WorkspaceFacet[]; unassigned: number }> {
  const rows = await facetRows();
  return {
    workspaces: tallyWorkspaces(rows, clampLimit(limit, 50)),
    unassigned: rows.filter((r) => !r.workspace).length,
  };
}

/**
 * Every chip row, in one round trip.
 *
 * The archive draws four rows of chips — kind, workspace, project, agent — plus
 * tags, and fetching each separately meant five requests to render one bar and
 * five chances for the rows to disagree about the corpus.
 *
 * Counts are corpus-wide and deliberately NOT recomputed against the current
 * filter. Chips that shrink and vanish as you tick them make the bar jump under
 * the cursor and hide the option you need to untick; a stable row you can read
 * once is worth more than counts that track the selection.
 */
export async function listFacets(): Promise<{
  kinds: Array<{ kind: string; count: number }>;
  workspaces: WorkspaceFacet[];
  unassigned: number;
  projects: ProjectFacet[];
  agents: AgentFacet[];
  tags: Array<{ tag: string; count: number }>;
  total: number;
}> {
  const rows = await facetRows();
  return {
    kinds: tally(rows, (r) => r.kind).map(({ value, count }) => ({ kind: value, count })),
    workspaces: tallyWorkspaces(rows, 50),
    unassigned: rows.filter((r) => !r.workspace).length,
    projects: tally(rows, (r) => r.project)
      .slice(0, 50)
      .map(({ value, count, latest }) => ({ project: value, count, latest })),
    agents: tally(rows, (r) => r.created_by)
      .slice(0, 50)
      .map(({ value, count, latest }) => ({ agent: value, count, latest })),
    tags: tallyTags(rows).slice(0, 50),
    total: rows.length,
  };
}

/** The facets a value can be merged within. */
export type Facet = "kind" | "workspace" | "project" | "agent" | "tag";

/**
 * Rename one facet value to another, everywhere.
 *
 * The repair for an open vocabulary. Nothing is deleted: every memory keeps its
 * place and simply files under a different word, so this is reversible by
 * merging back — which matters, because "merge retros into retro" is a judgement
 * and judgements get revised.
 *
 * updated_at is deliberately untouched — a merge is a change to the vocabulary,
 * not to the memory, and bumping it would reorder the whole archive by an act
 * of tidying. Returns how many rows changed, so a caller can tell "merged 14"
 * from a typo that matched nothing.
 */
export async function mergeFacet(
  facet: Facet,
  from: string,
  to: string,
): Promise<{ facet: Facet; from: string; to: string; merged: number }> {
  const normalize =
    facet === "kind" ? normalizeKind
    : facet === "workspace" ? normalizeWorkspace
    : facet === "project" ? normalizeProject
    : facet === "agent" ? normalizeCreatedBy
    : (v: string | undefined) => (v ?? "").trim();

  const source = normalize(from);
  const target = normalize(to);
  if (!source) throw new Error("from is required");
  if (!target) throw new Error("to is required");
  if (source === target) throw new Error("from and to are the same value");

  const t = await table("memories");

  if (facet !== "tag") {
    const column =
      facet === "kind" ? "kind"
      : facet === "workspace" ? "workspace"
      : facet === "project" ? "project"
      : "created_by";
    const result = await t.update({
      where: `${column} = ${lit(source)}`,
      values: { [column]: target },
    });
    return { facet, from: source, to: target, merged: Number(result.rowsUpdated ?? 0) };
  }

  // A tag lives inside a list, so the value is replaced within it and the
  // result de-duplicated — a memory already carrying both the source and the
  // target must not end up with the target twice. The FTS column follows.
  const rows = await scan<{ id: string; title: string; content: string; tags: string[] | null }>(t, {
    where: `array_has(tags, ${lit(source)})`,
    columns: ["id", "title", "content", "tags"],
  });
  let merged = 0;
  for (const row of rows) {
    const tags = [...new Set((row.tags ?? []).map((x) => (x === source ? target : x)))];
    await t.update({
      where: `id = ${lit(row.id)}`,
      values: { tags: listValue(tags), fts_text: ftsText(row.title, row.content, tags) },
    });
    merged++;
  }
  return { facet, from: source, to: target, merged };
}

/** Distinct kinds with counts. Free text now, so this IS the vocabulary. */
export async function listKinds(): Promise<Array<{ kind: string; count: number }>> {
  return tally(await facetRows(), (r) => r.kind).map(({ value, count }) => ({ kind: value, count }));
}

export interface AgentFacet {
  agent: string;
  count: number;
  latest: string;
}

/**
 * Who has written to the corpus, busiest first, optionally within one
 * workspace.
 *
 * `created_by` has been a stored column since the first release and was
 * filterable by nothing at all — so "two agents share this corpus and I cannot
 * tell who wrote what" was true even though the answer was on every row. This
 * is the facet that fixes it.
 */
export async function listAgents(
  limit = 50,
  workspace?: string,
): Promise<AgentFacet[]> {
  const rows = inWorkspace(await facetRows(), workspace);
  return tally(rows, (r) => r.created_by)
    .slice(0, clampLimit(limit, 50))
    .map(({ value, count, latest }) => ({ agent: value, count, latest }));
}

/** Distinct calendar months the corpus spans, newest first. */
export async function listMonths(limit = 24): Promise<Array<{ month: string; count: number }>> {
  const rows = await facetRows();
  const out = new Map<string, number>();
  for (const r of rows) {
    const month = r.created_at.slice(0, 7);
    out.set(month, (out.get(month) ?? 0) + 1);
  }
  return [...out.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, clampLimit(limit, 24));
}

/**
 * Memories created inside a time range, newest first.
 *
 * created_at is ISO-8601 UTC and therefore sorts lexicographically, so the
 * range is a plain string comparison — no date functions, no timezone maths in
 * the database. The caller (timerange.ts) owns what the boundaries mean.
 */
export async function searchInRange(
  input: MemoryScope & {
    fromIso: string;
    toIso: string;
    query?: string;
    limit?: number;
    /** What window this was, for the log — e.g. "the last 3 weeks". */
    label?: string;
    source?: string;
  },
): Promise<Memory[]> {
  return logged(() => searchInRangeUnlogged(input), {
    query: input.query,
    mode: input.label ? `window:${input.label}` : "range",
    kind: scopeLabel(input.kind as ScopeValue),
    workspace: scopeLabel(input.workspace),
    project: scopeLabel(input.project),
    source: input.source,
  });
}

async function searchInRangeUnlogged(
  input: MemoryScope & {
    fromIso: string;
    toIso: string;
    query?: string;
    limit?: number;
  },
): Promise<Memory[]> {
  const t = await table("memories");
  const query = (input.query ?? "").trim().slice(0, 240).toLocaleLowerCase();
  const rows = await topRows<MemoryRow>(t, {
    where: andWhere(
      `created_at >= ${lit(input.fromIso)} AND created_at <= ${lit(input.toIso)}`,
      query && `lower(${FTS_COLUMN}) LIKE ${lit(likePattern(query))}`,
      scopeWhere(input),
    ),
    sortColumns: ["created_at"],
    compare: byNewest("created_at"),
    limit: clampLimit(input.limit),
  });
  return rows.map(toMemory);
}

// ── semantic search ───────────────────────────────────────────────────────────

import { providerFromEnv, type EmbeddingProvider } from "./embedding";

let provider: EmbeddingProvider | null | undefined;

/** Resolved once. `null` means embeddings are switched off, not broken. */
export function embeddings(): EmbeddingProvider | null {
  if (provider === undefined) provider = providerFromEnv();
  return provider;
}

/**
 * Embeds one memory and stores the vector.
 *
 * Best-effort by contract: every failure is swallowed and reported as `false`.
 * The memory is already written by the time this runs, and a side-car being
 * down must never cost the corpus a memory.
 */
export async function indexMemory(memory: Pick<Memory, "id" | "title" | "content">): Promise<boolean> {
  const p = embeddings();
  if (!p) return false;
  try {
    // Title and content together: a title carries meaning the body often
    // assumes, and embedding them apart loses the connection.
    const [vector] = await p.embed([`${memory.title}\n\n${memory.content}`]);
    if (!vector) return false;
    const t = await table("memories");
    await t.update({
      where: `id = ${lit(memory.id)}`,
      values: { embedding: vector, embedding_model: p.model },
    });
    return true;
  } catch {
    return false;
  }
}

export interface SemanticResult {
  memories: Memory[];
  /** Cosine distance per memory id: 0 identical, 2 opposite. */
  distances: Record<string, number>;
}

/** Nearest neighbours. Throws only if embedding the QUERY fails. */
export async function searchSemantic(
  input: MemoryScope & { query: string; limit?: number; source?: string },
): Promise<SemanticResult> {
  const started = Date.now();
  const result = await searchSemanticNoLog(input);
  if (input.query.trim()) void recordSearch({
    query: input.query,
    mode: "semantic",
    kind: scopeLabel(input.kind as ScopeValue),
    workspace: scopeLabel(input.workspace),
    project: scopeLabel(input.project),
    resultIds: result.memories.map((m) => m.id),
    durationMs: Date.now() - started,
    source: input.source ?? "internal",
  });
  return result;
}

export async function searchSemanticNoLog(
  input: MemoryScope & { query: string; limit?: number },
): Promise<SemanticResult> {
  const p = embeddings();
  if (!p) throw new Error("embeddings are not configured");

  const [vector] = await p.embed([input.query]);
  if (!vector) throw new Error("query produced no embedding");

  // Nearest neighbours by cosine distance — 0 identical, 2 opposite, so the
  // engine sorts ascending. Rows with no vector are skipped rather than ranked
  // last: a missing vector is "not indexed yet", which is not the same as
  // "unrelated", and letting it score would be a quiet lie.
  const t = await table("memories");
  const found = (
    await t
      .vectorSearch(vector)
      .distanceType("cosine")
      .where(scopeWhere(input) ?? "true")
      .select(MEMORY_COLUMNS)
      .limit(clampLimit(input.limit))
      .toArray()
  ).map((r: unknown) => plain<MemoryRow & { _distance: number }>(r));

  return {
    memories: found.map(toMemory),
    distances: Object.fromEntries(found.map((r) => [r.id, Number(r._distance)])),
  };
}

// ── recall: one implementation for every caller ──────────────────────────────

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface RecallResult {
  requestedMode: SearchMode;
  /** What actually ran. Never assume this equals requestedMode. */
  effectiveMode: SearchMode;
  /** Non-null only when a richer mode was asked for and could not run. */
  fallback: { used: true; reason: string } | null;
  memories: Memory[];
  distances?: Record<string, number>;
  counts?: { keyword: number; semantic: number };
}

/**
 * Keyword, semantic, or both fused — for every surface that recalls memories.
 *
 * This lives here rather than in the HTTP route because it was in the route,
 * and the consequence was that MCP could not reach it. `recall_memories` ran a
 * literal keyword scan and answered "No memories matched" for questions the
 * corpus could answer perfectly well by meaning — invisible, because a
 * plausible empty result looks exactly like a true one. Measured 2026-08-29:
 * "how do I build a brand new virtual machine from scratch" returned 0 hits by
 * keyword and the right runbook first by hybrid.
 *
 * MCP is not a secondary surface. claude.ai cannot issue an HTTP call at all,
 * and an agent mid-task will not either — so a capability that exists only on
 * the REST route is invisible to every consumer that actually matters.
 *
 * Degradation is REPORTED, never silent. An explicit `semantic` request throws
 * when embeddings are unavailable; `hybrid` falls back to keyword and names the
 * reason, so a caller is never left believing a keyword scan searched by
 * meaning.
 */
export async function recallMemories(
  input: MemoryScope & {
    query: string;
    mode?: SearchMode;
    tag?: string;
    limit?: number;
    source?: string;
  },
): Promise<RecallResult> {
  const requestedMode: SearchMode = input.mode ?? "hybrid";
  const query = String(input.query ?? "");
  const source = input.source ?? "internal";

  // One scope object threaded through every branch, so the passes cannot drift
  // into filtering on different things — a hybrid whose halves disagreed on
  // workspace would silently fuse results from inside and outside it.
  const common = {
    kind: input.kind,
    workspace: input.workspace,
    project: input.project,
    createdBy: input.createdBy,
    limit: input.limit,
  } as MemoryScope & { limit?: number };

  // An empty query has nothing to embed; it means "most recent important",
  // which is a keyword-path concern.
  if (requestedMode === "keyword" || !query.trim()) {
    const memories = await searchMemories({ query, ...common, tag: input.tag, source });
    return { requestedMode, effectiveMode: "keyword", fallback: null, memories };
  }

  const started = Date.now();
  try {
    // NoLog variants: hybrid is ONE user action running two passes, and both
    // recording themselves would double-count every hybrid search.
    const semantic = await searchSemanticNoLog({ query, ...common });

    if (requestedMode === "semantic") {
      void recordSearch({
        query, mode: "semantic", kind: scopeLabel(input.kind as ScopeValue),
        workspace: scopeLabel(input.workspace), project: scopeLabel(input.project),
        resultIds: semantic.memories.map((m) => m.id),
        durationMs: Date.now() - started, source,
      });
      return {
        requestedMode, effectiveMode: "semantic", fallback: null,
        memories: semantic.memories, distances: semantic.distances,
      };
    }

    // Reciprocal rank fusion — ranks, not raw scores. BM25 and cosine distance
    // are not on comparable scales, and normalising them against each other
    // invents a precision neither one has.
    const keyword = await searchMemoriesNoLog({ query, ...common });
    const K = 60;
    const scores = new Map<string, number>();
    const byId = new Map<string, Memory>();
    keyword.forEach((m, i) => {
      scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (K + i + 1));
      byId.set(m.id, m);
    });
    semantic.memories.forEach((m, i) => {
      scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (K + i + 1));
      byId.set(m.id, m);
    });
    const merged = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, clampLimit(input.limit))
      .map(([id]) => byId.get(id)!)
      .filter(Boolean);

    void recordSearch({
      query, mode: "hybrid", kind: scopeLabel(input.kind as ScopeValue),
      workspace: scopeLabel(input.workspace), project: scopeLabel(input.project),
      resultIds: merged.map((m) => m.id),
      durationMs: Date.now() - started, source,
    });

    return {
      requestedMode, effectiveMode: "hybrid", fallback: null,
      memories: merged,
      counts: { keyword: keyword.length, semantic: semantic.memories.length },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "embedding failed";
    // An explicit semantic request FAILS rather than quietly becoming keyword:
    // a caller who asked for meaning deserves to know it did not happen.
    if (requestedMode === "semantic") throw new Error(reason);
    // Logged as keyword, because keyword is what actually ran. The reason
    // travels back in `fallback` for the caller to surface.
    const memories = await searchMemories({ query, ...common, tag: input.tag, source });
    return {
      requestedMode, effectiveMode: "keyword",
      fallback: { used: true, reason }, memories,
    };
  }
}

/** How much of the corpus carries a vector, and from which model. */
export async function embeddingCoverage(): Promise<{
  total: number;
  embedded: number;
  model: string | null;
  enabled: boolean;
}> {
  const p = embeddings();
  try {
    const t = await table("memories");
    const [total, embedded, sample] = await Promise.all([
      t.countRows(),
      t.countRows("embedding IS NOT NULL"),
      scan<{ embedding_model: string }>(t, {
        where: "embedding IS NOT NULL",
        columns: ["embedding_model"],
        limit: 1,
      }),
    ]);
    return {
      total,
      embedded,
      model: sample[0]?.embedding_model || null,
      enabled: Boolean(p),
    };
  } catch {
    return { total: 0, embedded: 0, model: null, enabled: Boolean(p) };
  }
}

/**
 * Embeds memories that have no vector yet, or whose vector came from a
 * different model. Returns how many were indexed.
 */
export async function backfillEmbeddings(limit = 50): Promise<number> {
  const p = embeddings();
  if (!p) return 0;
  const t = await table("memories");

  const pending = await topRows<{ id: string; title: string; content: string }>(t, {
    where: `embedding IS NULL OR embedding_model <> ${lit(p.model)}`,
    sortColumns: ["updated_at"],
    compare: byNewest("updated_at"),
    limit: clampLimit(limit),
  });

  let indexed = 0;
  for (const row of pending) {
    // One at a time rather than one big batch: a single oversized request that
    // fails loses the whole set, and this runs in the background anyway.
    const ok = await indexMemory({ id: row.id, title: row.title, content: row.content });
    if (ok) indexed++;
  }
  return indexed;
}
