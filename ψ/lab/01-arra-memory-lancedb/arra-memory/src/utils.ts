/**
 * Shared helpers. No database access, no HTTP — everything here is pure enough
 * to test without a running add-on.
 */

// ── time ──────────────────────────────────────────────────────────────────────

/** Unix seconds. Every expiry column in sql.ts is measured in these. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** ISO-8601 UTC. Every created_at / updated_at column stores one of these. */
export const nowIso = (): string => new Date().toISOString();

// ── memory field normalisation ────────────────────────────────────────────────

/**
 * What a memory IS. Free text, like workspace and project.
 *
 * This was a closed enum for eleven versions, and it was the ONLY closed set in
 * the schema — workspace, project and tags were all free text, so `kind` was the
 * one facet where the vocabulary had been chosen in v0.1 by someone who could
 * not know what the corpus would become. Every argument about it was really an
 * argument about that: whether `decision` earns a slot, where a handoff goes,
 * whether `resonance` is a category. None of those are answerable in advance,
 * and none of them need to be.
 *
 * Free text answers all of them at once: write the word when you need it.
 *
 * What it keeps that tags cannot give: kind is ALWAYS PRESENT and SINGLE, so
 * anything can group by it — which is what makes a digest have an outline. A
 * memory can have zero tags; it cannot have zero kind.
 *
 * The suggested vocabulary, offered in the UI and not enforced anywhere:
 *
 *   learn      a thing now known — about my system or someone else's
 *   enlighten  a reframe that changes how you JUDGE, naming no system
 *   retro      what happened, and the record of it
 *   artifact   a thing produced for someone to read
 *
 * The cost is drift — `retro` and `Retro` and `retros` are three kinds. That is
 * why writes normalise to lowercase, why the chip row shows counts (a stray
 * `retros (1)` sits visibly beside `retro (14)`), and why merge exists.
 */
export const SUGGESTED_KINDS = [
  "learn",
  "enlighten",
  "retro",
  "artifact",
] as const;

/** Anything, once normalised. The type is a string because the data is. */
export type MemoryKind = string;


/**
 * Up to ten tags, deduplicated case-insensitively but preserving the casing the
 * caller chose for the first occurrence — "Turso" and "turso" are one tag, and
 * it stays spelled the way it was first written.
 */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const unique = new Map<string, string>();
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, tag);
    if (unique.size === 10) break;
  }
  return [...unique.values()];
}

/** First meaningful line, markdown heading marks stripped, capped for the column. */
export function makeMemoryTitle(content: string): string {
  const first = content
    .split(/\r?\n/, 1)[0]
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!first) return "Untitled memory";
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

export function normalizeText(value: string, name: string, max: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > max) throw new Error(`${name} must be ${max} characters or fewer`);
  return text;
}

/**
 * A kind, normalised.
 *
 * Lowercased and space-collapsed for the same reason workspace is: a kind exists
 * only because memories agree on how it is spelled, and `Retro` arriving as a
 * second kind would split a category in half with nothing to reconcile them.
 *
 * Never throws. It is used on both the write and the read path, and a stored row
 * must never fail to load — the previous version validated against an enum on
 * every read, which meant retiring a value would have made the rows carrying it
 * unreadable rather than merely unwritable. Same shape as an index over a
 * migrated column in the create batch: a fresh install passes, real data breaks.
 */
export function normalizeKind(value: string | undefined): MemoryKind {
  const kind = (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase().slice(0, 40);
  return kind || "learn";
}

/** Reading is the same operation as writing now. Kept as its own name because
 *  call sites read better, and because the two were genuinely different before. */
export const readKind = normalizeKind;

export function normalizeImportance(value: number | undefined): number {
  const importance = value ?? 3;
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new Error("importance must be an integer from 1 to 5");
  }
  return importance;
}

export function normalizeSource(value: string | undefined): string {
  const source = value?.trim() || "web";
  if (source.length > 64) throw new Error("source must be 64 characters or fewer");
  return source;
}

/**
 * A project identifier. Free-form, but normalised so the same project written
 * two ways groups as one — this column is what the dynamic MCP tools are
 * generated from, so drift here shows up as duplicate tools.
 */
export function normalizeProject(value: string | undefined): string {
  const project = value?.trim().replace(/\s+/g, " ").slice(0, 120) ?? "";
  return project;
}

/**
 * A workspace identifier — the tier above project.
 *
 * Normalised identically to project, and for a sharper reason: there is no
 * workspaces table, so a workspace exists purely because memories agree on how
 * it is spelled. "haos oracle" and "haos  oracle" arriving as two workspaces
 * would split a team's corpus in half with nothing to reconcile them.
 *
 * Empty is legal and means UNSET. It is not a workspace named "none".
 */
export function normalizeWorkspace(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ").slice(0, 120) ?? "";
}

/**
 * A reference URL. Only http(s) is accepted — a memory is stored data that a
 * UI will render as a link, and `javascript:` there is a scripting hole.
 * An unparseable value is rejected rather than silently dropped.
 */
export function normalizeUrl(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  if (raw.length > 2048) throw new Error("url must be 2048 characters or fewer");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("url must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
  return parsed.toString();
}

/** Who or what produced this memory — "claude", "web", an oracle name. */
export function normalizeCreatedBy(value: string | undefined): string {
  return value?.trim().slice(0, 64) ?? "";
}

/** A project name reduced to something usable inside a generated tool name. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function clampLimit(value: number | undefined, fallback = 30): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

/** Tags round-trip through the column as JSON; a corrupt value degrades to none. */
export function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

// ── encoding ──────────────────────────────────────────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** Escapes the five characters that can break out of HTML text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── secrets ───────────────────────────────────────────────────────────────────

/**
 * Compares two strings in time that does not depend on where they first differ.
 *
 * A plain `===` returns as soon as it finds a mismatched byte, and the time it
 * took is a measurable hint about how much of the secret was right — enough to
 * recover a passphrase one character at a time over many attempts. Comparing
 * digests of equal length removes both the early exit and the length leak.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
  return diff === 0;
}

/** A URL-safe random token. 32 bytes is the floor for anything bearer-shaped. */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256: the verifier's SHA-256, base64url, unpadded. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

// ── cookies ───────────────────────────────────────────────────────────────────

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}
