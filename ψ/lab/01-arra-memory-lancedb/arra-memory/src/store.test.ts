/**
 * The LanceDB storage layer, end to end, with no embedding server.
 *
 * The libSQL version's behaviour is the specification here: every rule the SQL
 * used to encode — trigram substring search that finds Thai inside Thai,
 * scope filters that narrow without ever hiding, tags matched case-insensitively,
 * an id prefix answered directly, merges that touch the vocabulary and not
 * updated_at, expiry decided in the query and never after it — is asserted
 * against the Lance tables so the port cannot quietly drift from it.
 *
 * Values with quotes, backslashes and LIKE wildcards are pushed through every
 * path on purpose: there is no parameter binding in a WHERE string, so `lit`
 * and `likePattern` are the whole defence and they had better hold.
 *
 * ⚠️ One test file per process — see recall.test.ts for why.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arra-store-test-"));
process.env.LANCEDB_URI = join(dir, "lancedb");
process.env.SEARCH_LOG = "true";
delete process.env.OLLAMA_URL;

const memory = await import("./memory");
const kv = await import("./kv");
const oauth = await import("./oauth");
const searchlog = await import("./searchlog");
const { closeDb, storageStatus, table } = await import("./db");

const ids: Record<string, string> = {};

beforeAll(async () => {
  const thai = await memory.createMemory({
    title: "ระบบความจำ",
    content: "ระบบความจำสำหรับผู้ช่วยเอไอ — it's a 'quoted' note with 100% certainty",
    kind: "learn",
    tags: ["Thai", "Turso"],
    workspace: "haos oracle",
    project: "arra-memory",
    createdBy: "claude",
    importance: 4,
  });
  const cats = await memory.createMemory({
    title: "Cats",
    content: "cats are cute animals",
    kind: "retro",
    tags: ["pets"],
    workspace: "home",
    project: "zoo",
    createdBy: "nat",
    importance: 5,
  });
  const dogs = await memory.createMemory({
    title: "Dogs",
    content: "dogs are loyal animals",
    kind: "Retro",
    tags: ["pets", "dogs"],
    workspace: "home",
    project: "zoo",
    createdBy: "claude",
  });
  const bare = await memory.createMemory({ content: "a bare memory with nothing else" });
  ids.thai = thai.id;
  ids.cats = cats.id;
  ids.dogs = dogs.id;
  ids.bare = bare.id;
});

afterAll(async () => {
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("the store opened where it was told to, with every table", () => {
  const s = storageStatus();
  expect(s.uri).toBe(join(dir, "lancedb"));
  expect(s.remote).toBe(false);
  expect(s.ready).toBe(true);
  expect(s.error).toBeNull();
});

test("a memory round-trips with tags as a real array and kind normalised", async () => {
  const m = await memory.getMemory(ids.dogs);
  expect(m?.tags).toEqual(["pets", "dogs"]);
  expect(m?.kind).toBe("retro");
  expect(m?.workspace).toBe("home");
  const b = await memory.getMemory(ids.bare);
  expect(b?.tags).toEqual([]);
  expect(b?.title).toBe("a bare memory with nothing else");
});

test("keyword search finds a Thai word inside a Thai sentence", async () => {
  const hits = await memory.searchMemoriesNoLog({ query: "ความจำ" });
  expect(hits.map((m) => m.id)).toEqual([ids.thai]);
});

test("keyword search is a substring test, not a bag of trigrams", async () => {
  // "cute animals" is in the cats row only; "loyal animals" shares "animals".
  const hits = await memory.searchMemoriesNoLog({ query: "cute animals" });
  expect(hits.map((m) => m.id)).toEqual([ids.cats]);
});

test("a title hit outranks a body hit", async () => {
  await memory.createMemory({ title: "About pets in general", content: "cats and dogs both" });
  const hits = await memory.searchMemoriesNoLog({ query: "cats" });
  expect(hits[0]?.id).toBe(ids.cats);
});

test("quotes, backslashes and LIKE wildcards are data, not syntax", async () => {
  expect((await memory.searchMemoriesNoLog({ query: "it's a 'quoted'" })).map((m) => m.id)).toEqual([ids.thai]);
  expect((await memory.searchMemoriesNoLog({ query: "100%" })).map((m) => m.id)).toEqual([ids.thai]);
  // Short queries take the LIKE path; a bare % must match only the row that
  // literally contains one, not everything.
  expect((await memory.searchMemoriesNoLog({ query: "%" })).map((m) => m.id)).toEqual([ids.thai]);
  expect((await memory.searchMemoriesNoLog({ query: "_" })).length).toBe(0);
  const slash = await memory.createMemory({ title: "back\\slash", content: "a C:\\path\\to\\file" });
  expect((await memory.searchMemoriesNoLog({ query: "\\path\\" })).map((m) => m.id)).toEqual([slash.id]);
  expect((await memory.searchMemoriesNoLog({ query: "\\p" })).map((m) => m.id)).toEqual([slash.id]);
});

test("a short query still searches, through the substring path", async () => {
  const hits = await memory.searchMemoriesNoLog({ query: "do" });
  expect(hits.map((m) => m.id)).toContain(ids.dogs);
});

test("an id prefix is answered directly", async () => {
  const hits = await memory.searchMemoriesNoLog({ query: ids.cats.slice(0, 8) });
  expect(hits.map((m) => m.id)).toEqual([ids.cats]);
});

test("scope narrows on every facet and is OR within, AND across", async () => {
  const home = await memory.searchMemoriesNoLog({ workspace: "home" });
  expect(new Set(home.map((m) => m.id))).toEqual(new Set([ids.cats, ids.dogs]));

  const claudeAtHome = await memory.searchMemoriesNoLog({ workspace: "home", createdBy: "claude" });
  expect(claudeAtHome.map((m) => m.id)).toEqual([ids.dogs]);

  const either = await memory.searchMemoriesNoLog({ project: ["zoo", "arra-memory"] });
  expect(new Set(either.map((m) => m.id))).toEqual(new Set([ids.cats, ids.dogs, ids.thai]));

  // Scope applies on the indexed path too.
  const scoped = await memory.searchMemoriesNoLog({ query: "animals", createdBy: "nat" });
  expect(scoped.map((m) => m.id)).toEqual([ids.cats]);

  // Kind is normalised on both sides: "Retro" was stored as "retro".
  const retro = await memory.searchMemoriesNoLog({ kind: "RETRO" });
  expect(new Set(retro.map((m) => m.id))).toEqual(new Set([ids.cats, ids.dogs]));
});

test("a tag filter is case-insensitive and exact", async () => {
  expect((await memory.searchMemoriesNoLog({ tag: "PETS" })).length).toBe(2);
  expect((await memory.searchMemoriesNoLog({ tag: "pet" })).length).toBe(0);
  expect((await memory.searchMemoriesNoLog({ tag: "turso" })).map((m) => m.id)).toEqual([ids.thai]);
  // A tag filter combined with a query stays on the indexed path.
  expect((await memory.searchMemoriesNoLog({ query: "loyal", tag: "dogs" })).map((m) => m.id)).toEqual([ids.dogs]);
});

test("listing is newest first and a revision moves a memory to the top", async () => {
  const before = await memory.searchMemoriesNoLog({});
  expect(before[0]?.id).not.toBe(ids.thai);
  await Bun.sleep(5);
  await memory.updateMemory(ids.thai, { importance: 2 });
  const after = await memory.searchMemoriesNoLog({});
  expect(after[0]?.id).toBe(ids.thai);
  const m = await memory.getMemory(ids.thai);
  expect(m?.importance).toBe(2);
  expect(m?.tags).toEqual(["Thai", "Turso"]);
});

test("a partial update never blanks a field, and can clear the tags", async () => {
  const updated = await memory.updateMemory(ids.dogs, { tags: [] });
  expect(updated?.tags).toEqual([]);
  expect(updated?.content).toBe("dogs are loyal animals");
  const stored = await memory.getMemory(ids.dogs);
  expect(stored?.tags).toEqual([]);
  expect(stored?.workspace).toBe("home");
  await memory.updateMemory(ids.dogs, { tags: ["pets", "dogs"] });
});

test("facets are counted across the corpus", async () => {
  const f = await memory.listFacets();
  expect(f.total).toBeGreaterThanOrEqual(4);
  expect(f.kinds.find((k) => k.kind === "retro")?.count).toBe(2);
  expect(f.workspaces.find((w) => w.workspace === "home")).toMatchObject({ count: 2, projects: 1, agents: 2 });
  expect(f.unassigned).toBeGreaterThanOrEqual(1);
  expect(f.tags.find((t) => t.tag === "pets")?.count).toBe(2);
  expect(f.agents.find((a) => a.agent === "claude")?.count).toBe(2);

  expect((await memory.listProjects(20, "home")).map((p) => p.project)).toEqual(["zoo"]);
  expect((await memory.listTags(50, "haos oracle")).map((t) => t.tag).sort()).toEqual(["Thai", "Turso"]);
  expect((await memory.listAgents(50, "home")).map((a) => a.agent).sort()).toEqual(["claude", "nat"]);
  const months = await memory.listMonths();
  expect(months[0]?.month).toBe(new Date().toISOString().slice(0, 7));
  const stats = await memory.getMemoryStats();
  expect(stats.total).toBe(f.total);
  expect(stats.latestUpdatedAt).toBeTruthy();
});

test("merging a facet renames without touching updated_at", async () => {
  const before = await memory.getMemory(ids.cats);
  const r = await memory.mergeFacet("workspace", "home", "house");
  expect(r.merged).toBe(2);
  const after = await memory.getMemory(ids.cats);
  expect(after?.workspace).toBe("house");
  expect(after?.updatedAt).toBe(before!.updatedAt);
  await memory.mergeFacet("workspace", "house", "home");
});

test("merging a tag rewrites inside the list and de-duplicates", async () => {
  const r = await memory.mergeFacet("tag", "dogs", "pets");
  expect(r.merged).toBe(1);
  expect((await memory.getMemory(ids.dogs))?.tags).toEqual(["pets"]);
  // The FTS column followed the rename: the old tag is no longer findable.
  expect((await memory.searchMemoriesNoLog({ tag: "dogs" })).length).toBe(0);
  await memory.updateMemory(ids.dogs, { tags: ["pets", "dogs"] });
});

test("a time range is a plain string comparison on created_at", async () => {
  const all = await memory.searchInRange({ fromIso: "2000-01-01T00:00:00.000Z", toIso: "9999-12-31T23:59:59.999Z", query: "animals" });
  expect(new Set(all.map((m) => m.id))).toEqual(new Set([ids.cats, ids.dogs]));
  const none = await memory.searchInRange({ fromIso: "2000-01-01T00:00:00.000Z", toIso: "2000-01-02T00:00:00.000Z" });
  expect(none.length).toBe(0);
});

test("semantic search reports that it is off rather than pretending", async () => {
  const c = await memory.embeddingCoverage();
  expect(c.enabled).toBe(false);
  expect(c.embedded).toBe(0);
  expect(c.total).toBeGreaterThan(0);
  await expect(memory.searchSemanticNoLog({ query: "anything" })).rejects.toThrow();
  const r = await memory.recallMemories({ query: "cute animals" });
  expect(r.effectiveMode).toBe("keyword");
  expect(r.fallback?.used).toBe(true);
});

test("delete reports whether anything was there", async () => {
  const gone = await memory.createMemory({ content: "temporary" });
  expect(await memory.deleteMemory(gone.id)).toBe(true);
  expect(await memory.deleteMemory(gone.id)).toBe(false);
  expect(await memory.getMemory(gone.id)).toBeNull();
});

test("kv expiry is decided in the query", async () => {
  await kv.kvPut("live", "1", { expirationTtl: 60 });
  await kv.kvPut("dead", "1", { expirationTtl: -1 });
  await kv.kvPut("forever", "it's \\ here");
  expect(await kv.kvGet("live")).toBe("1");
  expect(await kv.kvGet("dead")).toBeNull();
  expect(await kv.kvGet("forever")).toBe("it's \\ here");
  await kv.kvPut("live", "2", { expirationTtl: 60 });
  expect(await kv.kvGet("live")).toBe("2");
  expect((await table("kv")).countRows("key = 'live'")).resolves.toBe(1);
  expect(await kv.kvSweep()).toBe(1);
  await kv.kvDelete("forever");
  expect(await kv.kvGet("forever")).toBeNull();
});

test("the OAuth code exchange is single-use and PKCE-bound", async () => {
  const client = await oauth.registerClient({ client_name: "claude.ai", redirect_uris: ["https://claude.ai/cb"] });
  expect((await oauth.getClient(client.clientId))?.redirectUris).toEqual(["https://claude.ai/cb"]);
  expect(oauth.isRegisteredRedirect(client, "https://claude.ai/cb.evil")).toBe(false);

  const verifier = "verifier-" + "x".repeat(40);
  const { sha256Base64Url } = await import("./utils");
  const code = await oauth.issueCode({
    clientId: client.clientId,
    redirectUri: "https://claude.ai/cb",
    codeChallenge: await sha256Base64Url(verifier),
    codeChallengeMethod: "S256",
    scope: "memory:read memory:write",
  });
  await expect(
    oauth.exchangeCode({ code, clientId: client.clientId, redirectUri: "https://claude.ai/cb", codeVerifier: "wrong" }),
  ).rejects.toThrow("invalid_grant");
  // A failed exchange burned the code.
  await expect(
    oauth.exchangeCode({ code, clientId: client.clientId, redirectUri: "https://claude.ai/cb", codeVerifier: verifier }),
  ).rejects.toThrow("invalid_grant");

  const code2 = await oauth.issueCode({
    clientId: client.clientId,
    redirectUri: "https://claude.ai/cb",
    codeChallenge: await sha256Base64Url(verifier),
    codeChallengeMethod: "S256",
    scope: "memory:read",
  });
  const token = await oauth.exchangeCode({ code: code2, clientId: client.clientId, redirectUri: "https://claude.ai/cb", codeVerifier: verifier });
  expect(token.scope).toBe("memory:read");
  expect(await oauth.verifyBearer(`Bearer ${token.accessToken}`)).toMatchObject({ clientId: client.clientId });
  expect(await oauth.verifyBearer("Bearer nope")).toBeNull();

  const listed = await oauth.listClients();
  expect(listed.find((c) => c.clientId === client.clientId)).toMatchObject({ activeTokens: 1, scope: "memory:read" });
  await oauth.revokeClient(client.clientId);
  expect(await oauth.verifyBearer(`Bearer ${token.accessToken}`)).toBeNull();
  expect((await oauth.listClients()).find((c) => c.clientId === client.clientId)?.activeTokens).toBe(0);
});

test("the search log records queries, is searchable, and can be pruned", async () => {
  await memory.searchMemories({ query: "cute animals", source: "test" });
  await memory.searchMemories({ query: "ความจำ", workspace: "haos oracle", source: "test" });
  // Recording is fire-and-forget; give it a moment.
  await Bun.sleep(200);
  const entries = await searchlog.listSearchLog(50);
  expect(entries.length).toBeGreaterThanOrEqual(2);
  expect(entries[0]?.query).toBe("ความจำ");
  expect(entries[0]?.workspace).toBe("haos oracle");
  expect(entries[0]?.resultIds).toEqual([ids.thai]);
  // The hybrid fallback earlier in this file logged the same query once too.
  const cute = await searchlog.listSearchLog(50, "cute");
  expect(cute.length).toBeGreaterThanOrEqual(1);
  expect(cute.every((e) => e.query === "cute animals")).toBe(true);
  expect((await searchlog.listSearchLog(50, "%")).length).toBe(0);

  const stats = await searchlog.searchLogStats();
  expect(stats.enabled).toBe(true);
  expect(stats.total).toBe(entries.length);
  expect(await searchlog.deleteSearchLogEntry(entries[0]!.id)).toBe(true);
  expect((await searchlog.pruneSearchLog(0)).removed).toBe(entries.length - 1);
  expect((await searchlog.searchLogStats()).total).toBe(0);
});
