#!/usr/bin/env bun
/**
 * Carries a corpus from the libSQL add-on into this one.
 *
 *   bun scripts/import-libsql.ts /path/to/arra-memory.db [--dry-run] [--force]
 *
 * The source is the file the libSQL version keeps at /data/arra-memory.db —
 * take it from a Home Assistant backup, or copy it off the guest. It is opened
 * READ-ONLY and never written to: a migration that can damage the thing it is
 * migrating from is not a migration, it is a gamble.
 *
 * Read with `bun:sqlite` rather than @libsql/client, deliberately. libSQL's
 * on-disk format IS SQLite's, bun:sqlite is built in, and depending on the
 * library this port exists to remove would be an odd thing for the tool that
 * removes it. The one libSQL-specific type in the file is F32_BLOB, which is a
 * plain BLOB of little-endian float32s — decodeVector below is the whole of it.
 *
 * Every table moves, not just the memories. The libSQL version learned this the
 * hard way when its Turso seeding copied only the corpus and silently reset
 * three things nobody thinks of as the corpus: the search log (the entire
 * history of what had been looked for), the kv table (which MCP tools the owner
 * had switched off), and the oauth tables (so the claude.ai connector stops
 * working and has to be re-approved).
 *
 * Idempotent by primary key: every row is upserted, so a re-run after a partial
 * import fills the gaps rather than duplicating. That matters more here than it
 * did upstream, because Lance has no unique constraint to catch a double insert.
 */

import { Database } from "bun:sqlite";
import { embeddingDimensions, storageUri, table } from "../src/db";
import { makeMemoryTitle, normalizeKind, parseTags } from "../src/utils";

const [sourcePath, ...flags] = process.argv.slice(2);
const DRY_RUN = flags.includes("--dry-run");
const FORCE = flags.includes("--force");

if (!sourcePath) {
  console.error("usage: bun scripts/import-libsql.ts <arra-memory.db> [--dry-run] [--force]");
  process.exit(1);
}

/** One upsert batch. Large enough to be fast, small enough to keep memory flat. */
const BATCH = 500;

/**
 * F32_BLOB → number[].
 *
 * The blob is a packed little-endian float32 array. `.slice()` on the view's
 * buffer is not optional: a Uint8Array from SQLite may be a view into a larger
 * buffer at a non-zero offset, and handing that straight to Float32Array either
 * throws on alignment or reads the wrong bytes.
 */
function decodeVector(value: unknown): number[] | null {
  if (!value) return null;
  const bytes =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : null;
  if (!bytes || bytes.byteLength === 0) return null;
  if (bytes.byteLength % 4 !== 0) return null;
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const floats = Array.from(new Float32Array(copy));
  // A vector with a NaN in it poisons every distance computed against it, and
  // the failure surfaces as bad search results rather than an error.
  return floats.every((n) => Number.isFinite(n)) ? floats : null;
}

/** Reads a whole table, or [] when the source predates it. */
function readTable(db: Database, name: string): Array<Record<string, unknown>> {
  try {
    return db.query(`SELECT * FROM ${name}`).all() as Array<Record<string, unknown>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) {
      console.log(`  ${name}: absent in the source, skipped`);
      return [];
    }
    throw error;
  }
}

async function upsert(
  tableName: Parameters<typeof table>[0],
  key: string,
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  if (!rows.length || DRY_RUN) return rows.length;
  const t = await table(tableName);
  for (let i = 0; i < rows.length; i += BATCH) {
    await t
      .mergeInsert(key)
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows.slice(i, i + BATCH));
  }
  return rows.length;
}

const source = new Database(sourcePath, { readonly: true });

console.log(`source: ${sourcePath}`);
console.log(`target: ${storageUri()}${DRY_RUN ? "  (dry run — nothing will be written)" : ""}`);

// ── memories ─────────────────────────────────────────────────────────────────

const dims = embeddingDimensions();
const memoryRows = readTable(source, "memories");

let carried = 0;
let dropped = 0;
let unembedded = 0;

const memories = memoryRows.map((row) => {
  const title = String(row.title ?? "") || makeMemoryTitle(String(row.content ?? ""));
  const content = String(row.content ?? "");
  // parseTags, not JSON.parse: a corrupt tags value must cost the memory its
  // tags, never the memory itself.
  const tags = parseTags(String(row.tags ?? "[]"));

  let embedding = decodeVector(row.embedding);
  if (embedding && embedding.length !== dims) {
    // A vector of the wrong width cannot go in the column at all. Dropping it
    // costs one embed call at backfill; forcing it in would corrupt the index.
    dropped++;
    embedding = null;
  }
  if (!embedding) unembedded++;
  carried++;

  return {
    id: String(row.id),
    title,
    content,
    kind: normalizeKind(String(row.kind ?? "")),
    // Empty means NULL in this schema — see the note on stringList in db.ts.
    tags: tags.length ? tags : null,
    source: String(row.source ?? "web"),
    importance: Number(row.importance ?? 3),
    workspace: String(row.workspace ?? ""),
    project: String(row.project ?? ""),
    url: String(row.url ?? ""),
    created_by: String(row.created_by ?? ""),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    // Derived here rather than carried: upstream had no such column — its FTS5
    // table indexed title, content and tags directly through triggers.
    fts_text: `${title}\n${content}\n${tags.join(" ")}`,
    embedding,
    embedding_model: embedding ? String(row.embedding_model ?? "") : "",
  };
});

if (dropped && !FORCE) {
  console.error(
    `\n${dropped} of ${carried} memories carry ${
      memoryRows.find((r) => decodeVector(r.embedding))?.embedding
        ? decodeVector(memoryRows.find((r) => decodeVector(r.embedding))!.embedding)!.length
        : "?"
    }-dimension vectors, but this instance is configured for ${dims}.\n` +
      `Their text will import fine and every one of them will be re-embedded by\n` +
      `backfill — but that is a decision, not a detail. Set embedding_dimensions\n` +
      `to match the source model, or re-run with --force to accept the re-embed.`,
  );
  process.exit(1);
}

// ── everything that is not the corpus ────────────────────────────────────────

const kv = readTable(source, "kv").map((r) => ({
  key: String(r.key),
  value: String(r.value),
  expires_at: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
}));

const clients = readTable(source, "oauth_clients").map((r) => ({
  client_id: String(r.client_id),
  client_name: r.client_name === null || r.client_name === undefined ? null : String(r.client_name),
  redirect_uris: String(r.redirect_uris ?? "[]"),
  created_at: String(r.created_at),
}));

const codes = readTable(source, "oauth_codes").map((r) => ({
  code: String(r.code),
  client_id: String(r.client_id),
  redirect_uri: String(r.redirect_uri),
  code_challenge: String(r.code_challenge),
  code_challenge_method: String(r.code_challenge_method),
  scope: String(r.scope ?? ""),
  expires_at: Number(r.expires_at),
}));

const tokens = readTable(source, "oauth_tokens").map((r) => ({
  token: String(r.token),
  client_id: String(r.client_id),
  scope: String(r.scope ?? ""),
  created_at: String(r.created_at),
  expires_at: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
}));

const searchLog = readTable(source, "search_log").map((r) => ({
  id: String(r.id),
  query: String(r.query ?? ""),
  mode: String(r.mode ?? "keyword"),
  kind: String(r.kind ?? ""),
  workspace: String(r.workspace ?? ""),
  project: String(r.project ?? ""),
  tag: String(r.tag ?? ""),
  result_count: Number(r.result_count ?? 0),
  result_ids: String(r.result_ids ?? "[]"),
  duration_ms: Number(r.duration_ms ?? 0),
  source: String(r.source ?? ""),
  created_at: String(r.created_at),
}));

source.close();

// ── write ────────────────────────────────────────────────────────────────────

const counts = {
  memories: await upsert("memories", "id", memories),
  kv: await upsert("kv", "key", kv),
  oauth_clients: await upsert("oauth_clients", "client_id", clients),
  oauth_codes: await upsert("oauth_codes", "code", codes),
  oauth_tokens: await upsert("oauth_tokens", "token", tokens),
  search_log: await upsert("search_log", "id", searchLog),
};

console.log("");
for (const [name, n] of Object.entries(counts)) console.log(`  ${name.padEnd(14)} ${n}`);
console.log("");
console.log(`  ${unembedded} of ${carried} memories arrive without a vector`);
if (dropped) console.log(`  (${dropped} of those had a ${dims === 1024 ? "differently" : "differently"}-sized vector and were cleared)`);
console.log(
  unembedded
    ? `  Start the add-on and POST /api/index/backfill, or let it index them as they are revised.`
    : `  Every memory kept its vector — semantic search works immediately.`,
);

if (DRY_RUN) console.log("\nDry run: nothing was written.");

process.exit(0);
