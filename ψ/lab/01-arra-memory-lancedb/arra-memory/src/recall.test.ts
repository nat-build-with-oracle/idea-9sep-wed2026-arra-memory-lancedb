/**
 * Recall searches by meaning, not only by literal words — on every surface.
 *
 * These tests exist because the capability was real and one caller could not
 * reach it. The fusion lived inside the HTTP route handler, so `recall_memories`
 * over MCP ran a literal keyword scan and answered "No memories matched" for
 * questions the corpus could answer perfectly well. Measured 2026-08-29 against
 * a live 25-memory corpus: "how do I build a brand new virtual machine from
 * scratch" returned 0 hits by keyword and the right runbook first by hybrid.
 *
 * That mattered more than an ordinary bug because MCP is not a secondary
 * surface — claude.ai cannot make an HTTP call at all, so the only door it has
 * was the one missing the feature. And an empty result is indistinguishable
 * from a true "nothing here", so nothing ever reported it.
 *
 * The fake embedder below is deliberately NOT semantic. It maps exact strings to
 * hand-placed vectors, which lets a test assert that a query with ZERO words in
 * common with a memory still finds it — the property that distinguishes recall
 * by meaning from recall by keyword. A real model would make the test depend on
 * that model's behaviour instead of on ours.
 *
 * ⚠️ Run test FILES in separate processes (`bun run test`, not `bun test`).
 * `table()` and `embeddings()` each cache a module-level singleton, so two test
 * files in one process share ONE database and ONE embedder no matter what their
 * env vars say — the second file's LANCEDB_URI is silently ignored, and the
 * first file's cleanup deletes the directory the other is still using. The
 * package script loops one `bun test` per file for exactly this reason.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arra-recall-test-"));

const DIMS = 1024;

/** A unit vector pointing along one axis — orthogonal texts, controlled geometry. */
function axis(n: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[n % DIMS] = 1;
  return v;
}

/**
 * Texts sharing a "meaning group" get the same vector. Group 0 is the default,
 * so anything unlisted is far from everything listed.
 */
const MEANING: Record<string, number> = {
  // the memory, and a question about it that shares no words at all
  "Provisioning a guest\n\nvirt-install with a preseed file": 1,
  "standing up a fresh box from nothing": 1,
};

let embedCalls = 0;
let embedderDown = false;

const embedder = Bun.serve({
  port: 0,
  async fetch(request) {
    if (embedderDown) return new Response("nope", { status: 503 });
    const body = (await request.json()) as { input: string[] };
    embedCalls++;
    return Response.json({
      model: "test-model",
      embeddings: body.input.map((t) => axis(MEANING[t] ?? 7)),
    });
  },
});

process.env.LANCEDB_URI = join(dir, "lancedb");
process.env.OLLAMA_URL = `http://localhost:${embedder.port}`;
process.env.EMBEDDING_MODEL = "test-model";
process.env.EMBEDDING_DIMENSIONS = String(DIMS);

// Imported after the env is set: providerFromEnv() resolves once and caches.
const { createMemory, recallMemories } = await import("./memory");
const { table, closeDb, lit } = await import("./db");

async function waitForVector(id: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await table("memories");
    if ((await t.countRows(`id = ${lit(id)} AND embedding IS NOT NULL`)) > 0) return true;
    await Bun.sleep(25);
  }
  return false;
}

let guestId = "";

beforeAll(async () => {
  const guest = await createMemory({
    title: "Provisioning a guest",
    content: "virt-install with a preseed file",
  });
  guestId = guest.id;
  expect(await waitForVector(guest.id)).toBe(true);

  // A decoy that DOES share words with the semantic query, so a hybrid hit
  // cannot be explained away as keyword luck.
  const decoy = await createMemory({
    title: "Unrelated",
    content: "a fresh coat of paint on the standing desk",
  });
  expect(await waitForVector(decoy.id)).toBe(true);
});

beforeEach(() => {
  embedCalls = 0;
  embedderDown = false;
});

afterAll(async () => {
  embedder.stop(true);
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("keyword mode cannot find a memory phrased differently — the bug", async () => {
  const r = await recallMemories({
    query: "standing up a fresh box from nothing",
    mode: "keyword",
  });
  expect(r.effectiveMode).toBe("keyword");
  // The decoy may match on words; the guest memory shares none of them.
  expect(r.memories.map((m) => m.id)).not.toContain(guestId);
});

test("hybrid finds it anyway, by meaning", async () => {
  const r = await recallMemories({
    query: "standing up a fresh box from nothing",
    mode: "hybrid",
  });
  expect(r.effectiveMode).toBe("hybrid");
  expect(r.fallback).toBeNull();
  expect(r.memories.map((m) => m.id)).toContain(guestId);
});

test("hybrid is the DEFAULT — an omitted mode must not silently be keyword", async () => {
  // This is the assertion that would have caught the original bug: the caller
  // asked for nothing in particular and should still get recall by meaning.
  const r = await recallMemories({ query: "standing up a fresh box from nothing" });
  expect(r.requestedMode).toBe("hybrid");
  expect(r.memories.map((m) => m.id)).toContain(guestId);
});

test("with the embedder down, hybrid degrades to keyword AND says why", async () => {
  embedderDown = true;
  const r = await recallMemories({
    query: "standing up a fresh box from nothing",
    mode: "hybrid",
  });
  // Degradation is reported, never silent — a caller must never believe a
  // keyword scan searched by meaning.
  expect(r.effectiveMode).toBe("keyword");
  expect(r.fallback?.used).toBe(true);
  expect(r.fallback?.reason).toBeTruthy();
});

test("explicit semantic FAILS rather than quietly degrading", async () => {
  embedderDown = true;
  // Someone who asked for meaning specifically deserves to know it did not
  // happen, rather than receive keyword results wearing a semantic label.
  await expect(
    recallMemories({ query: "standing up a fresh box from nothing", mode: "semantic" }),
  ).rejects.toThrow();
});

test("an empty query does not pay for an embed", async () => {
  const r = await recallMemories({ query: "" });
  expect(r.effectiveMode).toBe("keyword");
  await Bun.sleep(200);
  expect(embedCalls).toBe(0);
});
