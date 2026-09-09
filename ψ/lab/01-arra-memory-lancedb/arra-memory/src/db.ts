import * as lancedb from "@lancedb/lancedb";
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  List,
  Schema,
  Utf8,
} from "apache-arrow";
import { mkdirSync, writeFileSync } from "node:fs";
import { setting } from "./config";

/**
 * One LanceDB directory holds everything: the memory corpus, the key/value
 * store that replaces Cloudflare KV, the OAuth tables and the search log. Each
 * is its own Lance table — a directory of columnar fragments with a version
 * manifest, no server, no network, no account.
 *
 * What changes against the libSQL original, and why it matters:
 *
 *   - Vectors are a real column type (FixedSizeList<Float32>), so semantic
 *     search is native rather than an extension, and the same file can be
 *     opened by the Python and Rust LanceDB clients — or by DuckDB via the
 *     lance extension — without this add-on in the loop.
 *   - There is no SQL. Filters are DataFusion expressions in a WHERE string
 *     (`kind IN ('learn') AND array_has(tags, 'thor')`); everything else —
 *     ordering, grouping, joins — is done in the process, on top of a scan that
 *     selects only the columns it needs. At the scale a personal corpus lives
 *     at that is a handful of milliseconds and it keeps every statement
 *     readable; the two-phase helper below is what keeps it from reading
 *     12KB bodies just to sort by date.
 *   - Full-text search is a tantivy-backed inverted index. The tokenizer is
 *     ngram(3,3), for the same reason the original chose trigram FTS5: Thai
 *     writes without spaces, and a word-boundary tokenizer swallows a whole
 *     sentence as one token. Rows written after the index was built are still
 *     searched (a flat pass over the unindexed tail), and `optimize()` folds
 *     them in during housekeeping.
 *
 * LANCEDB_URI may be a directory or an object store (`s3://bucket/prefix`,
 * `gs://`, `az://`). Lance reads the usual AWS_* / GOOGLE_* / AZURE_* variables
 * for credentials, so pointing the corpus at R2 is a URI and four env vars —
 * that is the whole replacement for the Turso replica the libSQL version had.
 */

/** Where the corpus lives. /data is the only path Supervisor persists AND backs up. */
export function storageUri(): string {
  return process.env.LANCEDB_URI?.trim() || "/data/lancedb";
}

/** Object-store URIs are anything with a scheme that is not a local file. */
export function isRemoteUri(uri: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) && !uri.startsWith("file://");
}

/** The vector width. Fixed at table creation; a change means a rebuild (see below). */
export function embeddingDimensions(): number {
  return Number(setting("embedding_dimensions")) || 1024;
}

// ── schemas ──────────────────────────────────────────────────────────────────

const utf8 = (name: string, nullable = false) => new Field(name, new Utf8(), nullable);
const int32 = (name: string) => new Field(name, new Int32(), false);
/** Unix seconds as a double: an Int64 would arrive in JavaScript as a bigint. */
const seconds = (name: string, nullable: boolean) => new Field(name, new Float64(), nullable);
/**
 * Nullable, and NULL means "no tags". An UPDATE cannot write an empty list —
 * the engine builds the literal with make_array() and refuses zero arguments
 * ("concat requires input of at least one array") — so the empty case is
 * stored as NULL and read back as []. See `listValue` in memory.ts.
 */
const stringList = (name: string) =>
  new Field(name, new List(new Field("item", new Utf8(), true)), true);

export function memoriesSchema(dims: number): Schema {
  return new Schema([
    utf8("id"),
    utf8("title"),
    utf8("content"),
    utf8("kind"),
    stringList("tags"),
    utf8("source"),
    int32("importance"),
    // Provenance. workspace is the tier ABOVE project: one workspace holds
    // many projects. There is no workspaces table — the hierarchy is derived
    // from the distinct values here, so a workspace exists exactly as long as
    // a memory names it. Empty means UNSET and matches every filter.
    utf8("workspace"),
    utf8("project"),
    utf8("url"),
    utf8("created_by"),
    utf8("created_at"),
    utf8("updated_at"),
    // title + content + tags, joined — the one column the full-text index
    // covers. Maintained on every write by memory.ts; never read back as data.
    utf8("fts_text"),
    // NULL until the embedding side-car has answered. A missing vector means
    // "not indexed yet", never "unrelated", and vector search skips it.
    new Field("embedding", new FixedSizeList(dims, new Field("item", new Float32(), true)), true),
    utf8("embedding_model"),
  ]);
}

const KV_SCHEMA = new Schema([utf8("key"), utf8("value"), seconds("expires_at", true)]);

const OAUTH_CLIENTS_SCHEMA = new Schema([
  utf8("client_id"),
  utf8("client_name", true),
  utf8("redirect_uris"), // JSON array
  utf8("created_at"),
]);

const OAUTH_CODES_SCHEMA = new Schema([
  utf8("code"),
  utf8("client_id"),
  utf8("redirect_uri"),
  utf8("code_challenge"),
  utf8("code_challenge_method"),
  utf8("scope"),
  seconds("expires_at", false),
]);

const OAUTH_TOKENS_SCHEMA = new Schema([
  utf8("token"),
  utf8("client_id"),
  utf8("scope"),
  utf8("created_at"),
  seconds("expires_at", true),
]);

// The search log stores QUERY TEXT and result IDS — a deliberate, costed choice
// explained in searchlog.ts. Result content is never copied here.
const SEARCH_LOG_SCHEMA = new Schema([
  utf8("id"),
  utf8("query"),
  utf8("mode"),
  utf8("kind"),
  utf8("workspace"),
  utf8("project"),
  utf8("tag"),
  int32("result_count"),
  utf8("result_ids"), // JSON array
  int32("duration_ms"),
  utf8("source"),
  utf8("created_at"),
]);

export type TableName =
  | "memories"
  | "kv"
  | "oauth_clients"
  | "oauth_codes"
  | "oauth_tokens"
  | "search_log";

const FIXED_SCHEMAS: Record<Exclude<TableName, "memories">, Schema> = {
  kv: KV_SCHEMA,
  oauth_clients: OAUTH_CLIENTS_SCHEMA,
  oauth_codes: OAUTH_CODES_SCHEMA,
  oauth_tokens: OAUTH_TOKENS_SCHEMA,
  search_log: SEARCH_LOG_SCHEMA,
};

/** The full-text index over memories.fts_text. */
export const FTS_INDEX = "fts_text_idx";
export const FTS_COLUMN = "fts_text";

// ── connection ───────────────────────────────────────────────────────────────

let connection: lancedb.Connection | null = null;
const tables = new Map<TableName, lancedb.Table>();
let schemaReady: Promise<void> | null = null;
let lastError: string | null = null;

export function storageStatus(): {
  uri: string;
  remote: boolean;
  ready: boolean;
  error: string | null;
  dimensions: number;
} {
  const uri = storageUri();
  return {
    uri,
    remote: isRemoteUri(uri),
    ready: tables.size === 6,
    error: lastError,
    dimensions: embeddingDimensions(),
  };
}

async function connect(): Promise<lancedb.Connection> {
  if (connection) return connection;
  const uri = storageUri();
  if (!isRemoteUri(uri)) mkdirSync(uri, { recursive: true });
  connection = await lancedb.connect(uri);
  return connection;
}

/** A table, after the schema has been applied. */
export async function table(name: TableName): Promise<lancedb.Table> {
  await ensureSchema();
  const t = tables.get(name);
  if (!t) throw new Error(`table ${name} is not open`);
  return t;
}

/**
 * Applies the schema once per process.
 *
 * Memoized on the promise rather than guarded by a boolean: concurrent first
 * requests would each see `false` and race to create the same tables. Every
 * caller awaits the one migration instead.
 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = migrate().catch((error) => {
      // Clear the memo so the next request retries rather than inheriting a
      // permanently rejected promise and wedging the add-on.
      schemaReady = null;
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });
  }
  return schemaReady;
}

async function openOrCreate(
  db: lancedb.Connection,
  name: TableName,
  schema: Schema,
): Promise<lancedb.Table> {
  const existing = await db.tableNames();
  if (existing.includes(name)) return db.openTable(name);
  return db.createEmptyTable(name, schema);
}

/** The width of the embedding column as it exists on disk, or null if absent. */
function storedDimensions(schema: Schema): number | null {
  const field = schema.fields.find((f) => f.name === "embedding");
  if (!field) return null;
  const type = field.type as { listSize?: number };
  return typeof type.listSize === "number" ? type.listSize : null;
}

/**
 * Rebuilds `memories` with a different vector width.
 *
 * The column width is fixed when the table is created, and changing the
 * embedding model to one with different dimensions means every stored vector
 * is unreadable for the new one. The libSQL version said "new column and a
 * re-embed, not an edit here" and left it at that; this does the re-embed
 * set-up automatically: every row is carried across with its vector dropped
 * and `embedding_model` cleared, so `backfillEmbeddings` picks all of them up.
 *
 * Nothing is deleted without a copy: the rows are written to a JSON snapshot
 * beside the database first, and the previous table versions stay on disk
 * until housekeeping prunes them.
 */
async function rebuildMemories(
  db: lancedb.Connection,
  current: lancedb.Table,
  from: number | null,
  to: number,
): Promise<lancedb.Table> {
  const rows = (await current.query().toArray()).map((r) => {
    const row = plain<Record<string, unknown>>(r);
    delete row.embedding;
    return { ...row, embedding: null, embedding_model: "" };
  });

  const uri = storageUri();
  if (!isRemoteUri(uri)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshot = `${uri}/memories-before-rebuild-${stamp}.json`;
    writeFileSync(snapshot, JSON.stringify(rows), { mode: 0o600 });
    console.log(`[arra-memory] snapshot of ${rows.length} memories → ${snapshot}`);
  }

  console.error(
    `[arra-memory] embedding width changed ${from ?? "none"} → ${to}: rebuilding ` +
      `memories with vectors cleared. Every memory will be re-embedded by backfill.`,
  );
  return db.createTable("memories", rows, {
    mode: "overwrite",
    schema: memoriesSchema(to),
  });
}

async function migrate(): Promise<void> {
  const db = await connect();

  const dims = embeddingDimensions();
  let memories = await openOrCreate(db, "memories", memoriesSchema(dims));
  const stored = storedDimensions(await memories.schema());
  if (stored !== dims) {
    memories = await rebuildMemories(db, memories, stored, dims);
  }
  tables.set("memories", memories);

  for (const [name, schema] of Object.entries(FIXED_SCHEMAS) as [TableName, Schema][]) {
    tables.set(name, await openOrCreate(db, name, schema));
  }

  // The inverted index. Creating it on an empty table works, and rows added
  // afterwards are still found — LanceDB scans the unindexed tail on every
  // query and merges it in on optimize(). So it is built exactly once.
  const indices = await memories.listIndices();
  if (!indices.some((i) => i.name === FTS_INDEX)) {
    await memories.createIndex(FTS_COLUMN, {
      config: lancedb.Index.fts({
        // ngram(3,3): every 3-character sequence, so no word boundaries are
        // needed — the one tokenizer that finds a Thai word inside a Thai
        // sentence. Measured on the libSQL original with the same choice:
        // "ความจำ" inside "ระบบความจำสำหรับผู้ช่วยเอไอ" → 0 rows under a
        // word tokenizer, 1 under trigram.
        baseTokenizer: "ngram",
        ngramMinLength: 3,
        ngramMaxLength: 3,
        lowercase: true,
        asciiFolding: true,
        // Both default ON and both wrong for substring search: the stop-word
        // list would make "are" and "the" unfindable, and a stemmer on
        // trigrams mangles them into tokens the query never produces.
        removeStopWords: false,
        stem: false,
        withPosition: false,
      }),
    });
  }

  lastError = null;
  startHousekeeping();
}

// ── housekeeping ─────────────────────────────────────────────────────────────

/**
 * Every write is a new table version and a new fragment. Compaction folds the
 * fragments back together, merges the unindexed FTS tail into the index, and
 * prunes versions older than a day so the directory does not grow without
 * bound. Ten minutes is far more often than a personal corpus needs and far
 * less often than would matter.
 */
const HOUSEKEEPING_MS = 10 * 60 * 1000;
const KEEP_VERSIONS_MS = 24 * 60 * 60 * 1000;
let housekeeping: ReturnType<typeof setInterval> | null = null;

export async function optimizeAll(): Promise<void> {
  for (const t of tables.values()) {
    try {
      await t.optimize({ cleanupOlderThan: new Date(Date.now() - KEEP_VERSIONS_MS) });
    } catch (error) {
      console.error(
        `[arra-memory] optimize failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function startHousekeeping(): void {
  if (housekeeping || process.env.NODE_ENV === "test") return;
  housekeeping = setInterval(() => void optimizeAll(), HOUSEKEEPING_MS);
  // Never keep the process alive on its own account.
  housekeeping.unref?.();
}

/** Closes everything. Tests use it so a temp directory can be removed. */
export async function closeDb(): Promise<void> {
  if (housekeeping) clearInterval(housekeeping);
  housekeeping = null;
  for (const t of tables.values()) t.close();
  tables.clear();
  connection?.close();
  connection = null;
  schemaReady = null;
}

// ── filter building ──────────────────────────────────────────────────────────

/**
 * A string as a DataFusion literal. The only escape SQL has is doubling the
 * quote; backslashes are ordinary characters. Every value that reaches a WHERE
 * string goes through here — there is no interpolation of raw input anywhere.
 */
export function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `(‘a’, ‘b’)` — the caller guarantees the list is non-empty. */
export function inList(values: string[]): string {
  return `(${values.map(lit).join(", ")})`;
}

/** `%needle%` for LIKE, with LIKE's own wildcards neutralised. */
export function likePattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Joins the defined clauses with AND; undefined when there are none. */
export function andWhere(
  ...clauses: Array<string | undefined | false | "" | 0>
): string | undefined {
  const kept = clauses.filter((c): c is string => Boolean(c));
  return kept.length ? kept.map((c) => `(${c})`).join(" AND ") : undefined;
}

// ── rows ─────────────────────────────────────────────────────────────────────

/**
 * A result row as a plain object.
 *
 * Arrow hands list columns back as `Vector` objects, which serialise fine but
 * are not arrays — `.includes` and `.map` exist, `Array.isArray` says no. Every
 * read goes through here so the rest of the code sees ordinary arrays, and so
 * a FixedSizeList<Float32> becomes a number[] rather than a typed view over a
 * shared buffer.
 */
export function plain<T>(row: unknown): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] =
      value && typeof value === "object" && typeof (value as { toArray?: unknown }).toArray === "function"
        ? Array.from((value as { toArray: () => ArrayLike<unknown> }).toArray())
        : value;
  }
  return out as T;
}

/** Every row a filter matches, as plain objects. No ordering is implied. */
export async function scan<T>(
  t: lancedb.Table,
  opts: { where?: string; columns?: string[]; limit?: number } = {},
): Promise<T[]> {
  let q = t.query();
  if (opts.where) q = q.where(opts.where);
  if (opts.columns) q = q.select(opts.columns);
  // Lance applies no limit to a plain scan, which is what "every row" needs;
  // callers that want the top N pass one.
  if (opts.limit !== undefined) q = q.limit(opts.limit);
  return (await q.toArray()).map((r) => plain<T>(r));
}

/**
 * The top `limit` rows by an ordering the database cannot express.
 *
 * Lance scans have no ORDER BY. Rather than pull every 12KB body to sort by
 * date, this reads only the id and the sort keys, orders them here, and then
 * fetches just the winners in full. Two round trips, but the first one is a
 * few bytes per row.
 */
export async function topRows<T extends { id: string }>(
  t: lancedb.Table,
  opts: {
    where?: string;
    sortColumns: string[];
    compare: (a: Record<string, unknown>, b: Record<string, unknown>) => number;
    limit: number;
    idColumn?: string;
  },
): Promise<T[]> {
  const idColumn = opts.idColumn ?? "id";
  const keys = await scan<Record<string, unknown>>(t, {
    where: opts.where,
    columns: [idColumn, ...opts.sortColumns],
  });
  keys.sort(opts.compare);
  const winners = keys.slice(0, opts.limit).map((k) => String(k[idColumn]));
  if (!winners.length) return [];
  const rows = await scan<T>(t, { where: `${idColumn} IN ${inList(winners)}` });
  // The IN fetch returns rows in storage order; restore the ranking.
  const rank = new Map(winners.map((id, i) => [id, i]));
  return rows.sort(
    (a, b) =>
      (rank.get(String((a as Record<string, unknown>)[idColumn])) ?? 0) -
      (rank.get(String((b as Record<string, unknown>)[idColumn])) ?? 0),
  );
}

/** Newest first by `column`, ties broken by importance when present. */
export const byNewest =
  (column: string) =>
  (a: Record<string, unknown>, b: Record<string, unknown>): number =>
    String(b[column]).localeCompare(String(a[column])) ||
    Number(b.importance ?? 0) - Number(a.importance ?? 0);
