/**
 * Every write path embeds what it writes.
 *
 * These two tests exist because both failures were live in production on
 * 2026-08-28 and neither announced itself:
 *
 *   1. MCP `remember` called createMemory and nothing else, so every memory
 *      written by claude.ai or Claude Code went in without a vector. The map
 *      read "7 ยังไม่มีเวกเตอร์" and semantic search silently had nothing to
 *      match. Only the REST handler happened to call indexMemory.
 *
 *   2. Revising a memory left the OLD vector in place. That one could not heal:
 *      backfill finds rows whose embedding is missing or from another model,
 *      and a revised row is neither — so backfill skips it forever and the
 *      vector goes on describing text that no longer exists.
 *
 * The fix moved indexing into createMemory/updateMemory so a call site cannot
 * forget. These tests hold that line: they assert on the DATABASE, not on the
 * return value, because both bugs returned a perfectly correct object.
 *
 * A fake embedding server keeps this hermetic — no Ollama, no network.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arra-index-test-"));

/** Counts calls so a test can prove an embed did NOT happen. */
let embedCalls = 0;
let lastEmbedded: string[] = [];

const embedder = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { input: string[] };
    embedCalls++;
    lastEmbedded = body.input;
    // 1024 dims to match EMBEDDING_DIMENSIONS; the values only need to be
    // finite and distinct enough that a wrong vector is a different vector.
    const embeddings = body.input.map((text) =>
      Array.from({ length: 1024 }, (_, i) => ((text.length + i) % 97) / 97),
    );
    return Response.json({ model: "test-model", embeddings });
  },
});

process.env.LANCEDB_URI = join(dir, "lancedb");
process.env.OLLAMA_URL = `http://localhost:${embedder.port}`;
process.env.EMBEDDING_MODEL = "test-model";
process.env.EMBEDDING_DIMENSIONS = "1024";

// Imported AFTER the env is set: providerFromEnv() resolves once and caches.
const { createMemory, updateMemory } = await import("./memory");
const { table, closeDb, lit } = await import("./db");

/** The vector as stored. Reading the DB is the point — the API lies here. */
async function storedVector(id: string): Promise<{ embedded: boolean; model: string | null }> {
  const t = await table("memories");
  const embedded = await t.countRows(`id = ${lit(id)} AND embedding IS NOT NULL`);
  const rows = await t.query().where(`id = ${lit(id)}`).select(["embedding_model"]).toArray();
  return { embedded: embedded > 0, model: rows[0]?.embedding_model ?? null };
}

/**
 * Indexing is fire-and-forget by contract, so a write returns before the vector
 * lands. Poll rather than sleep a fixed amount: fast when it works, and it
 * fails loudly instead of flaking when it does not.
 */
async function waitForVector(id: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await storedVector(id)).embedded) return true;
    await Bun.sleep(25);
  }
  return false;
}

beforeAll(async () => {
  // Touch the DB once so the schema exists before the first assertion, and
  // let its own embed FINISH. Indexing is fire-and-forget, so a warmup left in
  // flight lands mid-test and overwrites what the test captured.
  const warmup = await createMemory({ content: "schema warmup" });
  await waitForVector(warmup.id);
});

beforeEach(() => {
  embedCalls = 0;
  lastEmbedded = [];
});

afterAll(async () => {
  embedder.stop(true);
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("a created memory is embedded without the caller asking", async () => {
  // No indexMemory() call here on purpose — this is exactly what MCP `remember`
  // did, and it is what used to leave the corpus unvectorised.
  const memory = await createMemory({
    title: "the clean room",
    content: "thor proves the add-on installs from nothing",
  });

  expect(await waitForVector(memory.id)).toBe(true);
  const stored = await storedVector(memory.id);
  expect(stored.model).toBe("test-model");

  // Title and content are embedded together — a title carries meaning the body
  // assumes, and embedding them apart loses the connection.
  expect(lastEmbedded[0]).toBe("the clean room\n\nthor proves the add-on installs from nothing");
});

test("revising the content re-embeds it, so the vector cannot go stale", async () => {
  const memory = await createMemory({ title: "before", content: "the original text" });
  expect(await waitForVector(memory.id)).toBe(true);

  embedCalls = 0;
  await updateMemory(memory.id, { content: "completely different text" });

  // Poll on the CALL, not on the vector: the row already has one, so
  // waitForVector would pass instantly whether or not a re-embed happened —
  // which is precisely how this bug stayed invisible.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && embedCalls === 0) await Bun.sleep(25);

  expect(embedCalls).toBe(1);
  expect(lastEmbedded[0]).toBe("before\n\ncompletely different text");
});

test("revising only metadata does not pay for an embed", async () => {
  const memory = await createMemory({ title: "steady", content: "unchanged body" });
  expect(await waitForVector(memory.id)).toBe(true);

  embedCalls = 0;
  await updateMemory(memory.id, { tags: ["thor"], importance: 5, project: "haos-oracle" });

  // Give a stray embed time to show up before declaring none happened.
  await Bun.sleep(300);
  expect(embedCalls).toBe(0);
});
