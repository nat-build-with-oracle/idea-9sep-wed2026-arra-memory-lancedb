/**
 * A real corpus survives the crossing from libSQL.
 *
 * The migration is the only part of this port that touches data someone
 * already has, so it is the part that has to be proven rather than reasoned
 * about. This builds a database with the SHIPPED libSQL schema — the exact
 * CREATE TABLE text from upstream's sql.ts, F32_BLOB vectors and all — fills it
 * with the awkward cases, runs scripts/import-libsql.ts as a subprocess the way
 * a person would, and then asks the LanceDB side questions through its own
 * public API.
 *
 * The awkward cases are the point:
 *   - a Thai memory, so the ngram index is exercised on text a word tokenizer
 *     cannot split
 *   - a real 1024-float vector, so semantic search must work with NO re-embed
 *   - a memory with no vector, which must arrive and be findable anyway
 *   - empty tags, which cannot be stored as an empty list in Lance
 *   - a title with quotes and a backslash, which reach a filter string later
 *   - the three tables that are NOT the corpus (kv, oauth, search_log), because
 *     upstream's own Turso seeding shipped a version that copied only the
 *     memories and silently reset the connector and the search history
 *
 * ⚠️ One test file per process — see recall.test.ts for why.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arra-import-test-"));
const sourceDb = join(dir, "arra-memory.db");
const DIMS = 1024;

process.env.LANCEDB_URI = join(dir, "lancedb");
process.env.EMBEDDING_DIMENSIONS = String(DIMS);
delete process.env.OLLAMA_URL;

/** The vector for a memory, as libSQL stored it: packed little-endian float32. */
function blob(seed: number): Buffer {
  const v = new Float32Array(DIMS);
  // One axis per seed — orthogonal vectors, so a nearest-neighbour assertion is
  // about the plumbing rather than about an embedding model's judgement.
  v[seed % DIMS] = 1;
  return Buffer.from(v.buffer);
}

const NOW = "2026-09-08T12:00:00.000Z";

let ids: Record<string, string> = {};

beforeAll(async () => {
  const db = new Database(sourceDb);
  // Upstream's schema, verbatim in shape: the columns the importer reads and
  // the types it has to decode. F32_BLOB is a BLOB as far as SQLite cares.
  db.run(`CREATE TABLE memories (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'note', tags TEXT NOT NULL DEFAULT '[]',
     source TEXT NOT NULL DEFAULT 'web', importance INTEGER NOT NULL DEFAULT 3,
     workspace TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
     url TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     embedding BLOB, embedding_model TEXT NOT NULL DEFAULT '')`);
  db.run(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`);
  db.run(`CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_name TEXT,
     redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE oauth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL,
     redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
     code_challenge_method TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
     expires_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE oauth_tokens (token TEXT PRIMARY KEY, client_id TEXT NOT NULL,
     scope TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at INTEGER)`);
  db.run(`CREATE TABLE search_log (id TEXT PRIMARY KEY, query TEXT NOT NULL DEFAULT '',
     mode TEXT NOT NULL DEFAULT 'keyword', kind TEXT NOT NULL DEFAULT '',
     workspace TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
     tag TEXT NOT NULL DEFAULT '', result_count INTEGER NOT NULL DEFAULT 0,
     result_ids TEXT NOT NULL DEFAULT '[]', duration_ms INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);

  ids = {
    thai: "11111111-1111-4111-8111-111111111111",
    bare: "22222222-2222-4222-8222-222222222222",
    quoted: "33333333-3333-4333-8333-333333333333",
  };

  const insert = db.prepare(`INSERT INTO memories
    (id,title,content,kind,tags,source,importance,workspace,project,url,created_by,created_at,updated_at,embedding,embedding_model)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(ids.thai, "ระบบความจำ", "ระบบความจำสำหรับผู้ช่วยเอไอ บน libSQL",
    "learn", '["thai","libsql"]', "mcp", 5, "fleet", "thor", "https://example.com/x",
    "9sep-oracle", NOW, NOW, blob(7), "bge-m3");
  insert.run(ids.bare, "No vector here", "this memory was never embedded",
    "retro", "[]", "web", 3, "", "", "", "", NOW, NOW, null, "");
  insert.run(ids.quoted, "it's a \"quoted\" C:\\path", "100% of the time",
    "Enlighten", '["edge case"]', "web", 4, "fleet", "thor", "", "nat", NOW, NOW, blob(9), "bge-m3");

  db.run(`INSERT INTO kv VALUES ('disabled-tools','["remember"]',NULL)`);
  db.run(`INSERT INTO kv VALUES ('owner-session:abc','1757000000',4102444800)`);
  db.run(`INSERT INTO oauth_clients VALUES ('client-1','claude.ai','["https://claude.ai/cb"]','${NOW}')`);
  db.run(`INSERT INTO oauth_tokens VALUES ('token-1','client-1','memory:read memory:write','${NOW}',4102444800)`);
  db.run(`INSERT INTO oauth_codes VALUES ('code-1','client-1','https://claude.ai/cb','chal','S256','memory:read',4102444800)`);
  db.run(`INSERT INTO search_log VALUES ('log-1','ความจำ','keyword','','fleet','thor','',1,'["${ids.thai}"]',12,'web','${NOW}')`);
  db.close();

  const proc = Bun.spawn([process.execPath, "scripts/import-libsql.ts", sourceDb], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`importer exited ${code}\n${out}\n${err}`);
});

afterAll(async () => {
  const { closeDb } = await import("./db");
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("every memory crossed, with its provenance intact", async () => {
  const memory = await import("./memory");
  const m = await memory.getMemory(ids.thai);
  expect(m).toMatchObject({
    title: "ระบบความจำ",
    kind: "learn",
    tags: ["thai", "libsql"],
    source: "mcp",
    importance: 5,
    workspace: "fleet",
    project: "thor",
    url: "https://example.com/x",
    createdBy: "9sep-oracle",
    createdAt: NOW,
    updatedAt: NOW,
  });
  // Kind is normalised on the way in, exactly as a write would normalise it.
  expect((await memory.getMemory(ids.quoted))?.kind).toBe("enlighten");
  // An empty tags array is stored as NULL and must read back as [], not null.
  expect((await memory.getMemory(ids.bare))?.tags).toEqual([]);
  expect((await memory.getMemoryStats()).total).toBe(3);
});

test("the imported corpus is searchable — including Thai inside Thai", async () => {
  const memory = await import("./memory");
  // fts_text is DERIVED by the importer; upstream had no such column. If it
  // were missing or wrong, this returns nothing and nothing else would say so.
  expect((await memory.searchMemoriesNoLog({ query: "ความจำ" })).map((m) => m.id)).toEqual([ids.thai]);
  expect((await memory.searchMemoriesNoLog({ query: "never embedded" })).map((m) => m.id)).toEqual([ids.bare]);
  expect((await memory.searchMemoriesNoLog({ tag: "LIBSQL" })).map((m) => m.id)).toEqual([ids.thai]);
  // The quote/backslash title reaches a filter string on the id-prefix path.
  expect((await memory.searchMemoriesNoLog({ query: "100%" })).map((m) => m.id)).toEqual([ids.quoted]);
  expect((await memory.searchMemoriesNoLog({ workspace: "fleet" })).length).toBe(2);
});

test("vectors survive the crossing, so semantic search needs no re-embed", async () => {
  const { table } = await import("./db");
  const t = await table("memories");
  expect(await t.countRows("embedding IS NOT NULL")).toBe(2);

  // The decoded vector must be the one libSQL held, not a reinterpretation of
  // its bytes: axis 7 was the Thai memory's, axis 9 the quoted one's.
  const near = await t.vectorSearch(Array.from({ length: DIMS }, (_, i) => (i === 7 ? 1 : 0)))
    .distanceType("cosine").limit(1).toArray();
  expect(String(near[0].id)).toBe(ids.thai);

  const coverage = await (await import("./memory")).embeddingCoverage();
  expect(coverage).toMatchObject({ total: 3, embedded: 2, model: "bge-m3" });
});

test("what is NOT the corpus crossed too — the connector and the search history", async () => {
  const kv = await import("./kv");
  const oauth = await import("./oauth");
  const searchlog = await import("./searchlog");

  // Which MCP tools the owner had switched off.
  expect(await kv.kvGet("disabled-tools")).toBe('["remember"]');
  // A live owner session stays live; expiry is still decided in the filter.
  expect(await kv.kvGet("owner-session:abc")).toBe("1757000000");

  // The claude.ai connector still works without re-approving it.
  expect(await oauth.verifyBearer("Bearer token-1")).toMatchObject({
    clientId: "client-1",
    scope: "memory:read memory:write",
  });
  expect(await oauth.getClient("client-1")).toMatchObject({
    clientName: "claude.ai",
    redirectUris: ["https://claude.ai/cb"],
  });
  expect((await oauth.listClients())[0]).toMatchObject({ clientId: "client-1", activeTokens: 1 });

  const log = await searchlog.listSearchLog(50);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    query: "ความจำ",
    workspace: "fleet",
    project: "thor",
    resultIds: [ids.thai],
    resultCount: 1,
  });
});

test("re-running the import is a no-op, not a duplication", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/import-libsql.ts", sourceDb], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  expect(code).toBe(0);

  const memory = await import("./memory");
  // Lance has no unique constraint — a non-idempotent importer would silently
  // double the corpus here, and every count in the UI with it.
  expect((await memory.getMemoryStats()).total).toBe(3);
  expect((await memory.searchMemoriesNoLog({ query: "ความจำ" })).length).toBe(1);
  expect((await (await import("./searchlog")).listSearchLog(50)).length).toBe(1);
  expect((await (await import("./oauth")).listClients()).length).toBe(1);
});

test("a dimension mismatch refuses rather than corrupting the index", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/import-libsql.ts", sourceDb], {
    cwd: import.meta.dir + "/..",
    // 768 is nomic-embed-text; the source holds 1024-wide bge-m3 vectors.
    env: { ...process.env, NODE_ENV: "test", EMBEDDING_DIMENSIONS: "768", LANCEDB_URI: join(dir, "lancedb-768") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(1);
  expect(err).toContain("--force");

  // With --force the text still crosses; only the vectors are dropped, and
  // backfill is what puts them back.
  const forced = Bun.spawn([process.execPath, "scripts/import-libsql.ts", sourceDb, "--force"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, NODE_ENV: "test", EMBEDDING_DIMENSIONS: "768", LANCEDB_URI: join(dir, "lancedb-768") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await forced.exited).toBe(0);
});
