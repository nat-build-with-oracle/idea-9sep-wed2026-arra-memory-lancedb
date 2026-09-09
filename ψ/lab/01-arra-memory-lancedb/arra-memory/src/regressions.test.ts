/**
 * The defects an adversarial audit of this port actually found, each pinned by
 * the test that would have caught it.
 *
 * Every one of these passed review and passed the rest of the suite. They are
 * here because they share a shape: the wrong answer is a PLAUSIBLE answer. A
 * search that returns nothing looks exactly like a corpus that contains
 * nothing; a facet list in the wrong order looks like a facet list; a duplicate
 * key row is invisible until something reads the other one. Nothing throws,
 * nothing logs, and the only way to notice is to assert the invariant.
 *
 * ⚠️ One test file per process — see recall.test.ts for why.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arra-regress-"));
process.env.LANCEDB_URI = join(dir, "lancedb");
delete process.env.OLLAMA_URL;

const memory = await import("./memory");
const kv = await import("./kv");
const { table, closeDb, lit } = await import("./db");

/**
 * Rows written straight to the table.
 *
 * createMemory would be more faithful, but these corpora are hundreds of rows
 * and each createMemory is its own commit. The columns written here are exactly
 * the ones createMemory writes, fts_text included — the thing under test is the
 * READ path.
 */
async function seed(rows: Array<{
  id: string; title: string; content: string; tags?: string[];
  workspace?: string; project?: string; kind?: string; createdBy?: string; importance?: number;
}>): Promise<void> {
  const t = await table("memories");
  const full = rows.map((r, i) => {
    const tags = r.tags ?? [];
    return {
      id: r.id,
      title: r.title,
      content: r.content,
      kind: r.kind ?? "learn",
      tags: tags.length ? tags : null,
      source: "test",
      importance: r.importance ?? 3,
      workspace: r.workspace ?? "",
      project: r.project ?? "",
      url: "",
      created_by: r.createdBy ?? "",
      created_at: new Date(1757000000000 - i * 60_000).toISOString(),
      updated_at: new Date(1757000000000 - i * 60_000).toISOString(),
      fts_text: `${r.title}\n${r.content}\n${tags.join(" ")}`,
      embedding: null,
      embedding_model: "",
    };
  });
  for (let i = 0; i < full.length; i += 500) await t.add(full.slice(i, i + 500));
}

async function clearCorpus(): Promise<void> {
  const t = await table("memories");
  await t.delete("id IS NOT NULL");
}

beforeAll(async () => {
  await table("memories");
});

afterAll(async () => {
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("a keyword hit is not lost to rows that merely share its trigrams", async () => {
  await clearCorpus();
  // 400 notes that contain every trigram of "animals" — ani, nim, ima, mal —
  // without containing the word. The ngram index scores them, so they compete
  // for exactly the slots the real matches need.
  await seed([
    ...Array.from({ length: 400 }, (_, i) => ({
      id: `noise-${String(i).padStart(4, "0")}`,
      title: `animal alsatian ${i}`,
      content: `animal alsatian animal alsatian animal alsatian ${i}`,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `report-${i}`,
      title: `field report ${i}`,
      content: `we counted the animals in the reserve. ${"lorem ipsum dolor sit amet. ".repeat(40)}`,
    })),
  ]);

  // The default limit is the case that mattered: with the substring test
  // applied AFTER a fixed candidate pool this returned nothing at limit 30 and
  // all three only at limit 100 — the result depended on the page size.
  const found = await memory.searchMemoriesNoLog({ query: "animals" });
  expect(found.map((m) => m.id).sort()).toEqual(["report-0", "report-1", "report-2"]);

  for (const limit of [1, 3, 10, 30, 100]) {
    const page = await memory.searchMemoriesNoLog({ query: "animals", limit });
    expect(page.length).toBe(Math.min(limit, 3));
    expect(page.every((m) => m.id.startsWith("report-"))).toBe(true);
  }

  // A scope narrows the same query rather than replacing the membership test.
  await seed([{ id: "report-scoped", title: "field report scoped", content: "animals here", workspace: "quiet" }]);
  const scoped = await memory.searchMemoriesNoLog({ query: "animals", workspace: "quiet" });
  expect(scoped.map((m) => m.id)).toEqual(["report-scoped"]);
});

test("a tag filter plus a query still finds the memory that carries both", async () => {
  await clearCorpus();
  await seed([
    ...Array.from({ length: 400 }, (_, i) => ({
      id: `plain-${String(i).padStart(4, "0")}`,
      title: `a widget ${i}`,
      content: `a widget appears here ${i}`,
    })),
    {
      id: "tagged",
      title: "the rack inventory",
      content: `the widget lives in the rack. ${"padding sentence. ".repeat(30)}`,
      tags: ["Rare-Tag"],
    },
  ]);

  // Upstream routed a tagged query to the full scan precisely because a tag is
  // matched case-insensitively against a case-preserving list, which no filter
  // expression can express. Letting it take the indexed path made the tag a
  // post-filter over a truncated page, and the answer went silently empty.
  expect((await memory.searchMemoriesNoLog({ query: "widget", tag: "rare-tag" })).map((m) => m.id))
    .toEqual(["tagged"]);
  expect((await memory.searchMemoriesNoLog({ query: "widget", tag: "RARE-TAG" })).map((m) => m.id))
    .toEqual(["tagged"]);
  // A tag that nothing carries stays empty rather than falling back to the query.
  expect(await memory.searchMemoriesNoLog({ query: "widget", tag: "absent" })).toEqual([]);
});

test("a lone surrogate cannot delete the rest of a filter", async () => {
  await clearCorpus();
  await seed([
    { id: "pub", title: "Public", content: "public body", workspace: "public", kind: "learn" },
    { id: "sec", title: "Private", content: "secret body", workspace: "secret", kind: "learn" },
  ]);

  // A lone UTF-16 surrogate is legal in a JSON string and cannot be encoded as
  // UTF-8, so the filter string is truncated at that byte on its way into the
  // engine — taking every clause after it with it. Here the workspace clause
  // follows the kind clause.
  const lonely = "learn\uD800";
  let result: Awaited<ReturnType<typeof memory.searchMemoriesNoLog>> = [];
  await expect(
    (async () => {
      result = await memory.searchMemoriesNoLog({ kind: [lonely], workspace: ["public"] });
    })(),
  ).resolves.toBeUndefined();
  // Sanitised, the kind matches nothing. The one answer that must never happen
  // is the whole corpus coming back because the narrowing clauses vanished.
  expect(result).toEqual([]);

  // Same value in the query itself, where it reaches likePattern.
  expect(await memory.searchMemoriesNoLog({ query: `public\uD800` })).toEqual([]);
  expect((await memory.searchMemoriesNoLog({ query: "public" })).map((m) => m.id)).toEqual(["pub"]);

  // And the case with teeth: the clause after a kv key is the expiry check.
  // Losing it serves an expired owner session as a live one.
  await kv.kvPut("session\uD800", "should-not-be-readable", { expirationTtl: -1 });
  expect(await kv.kvGet("session\uD800")).toBeNull();
});

test("merging a tag leaves full-text search agreeing with the stored body", async () => {
  await clearCorpus();
  const N = 300;
  await seed(Array.from({ length: N }, (_, i) => ({
    id: `m-${String(i).padStart(4, "0")}`,
    title: `Note ${i}`,
    content: `original body ${i}`,
    tags: i === 0 ? ["oracle", "arra"] : ["oracle"],
  })));

  const victim = "m-0295";
  // A revision landing while the merge runs. The loop this replaced read every
  // row up front and wrote each one back later, so it stamped a stale fts_text
  // over the new content — the memory kept its new body and became unfindable
  // by the words in it, permanently and silently.
  const merging = memory.mergeFacet("tag", "oracle", "arra");
  await Bun.sleep(15);
  await memory.updateMemory(victim, { content: "BRAND NEW BODY that must be findable" });
  const merged = await merging;

  expect(merged.merged).toBeGreaterThan(0);
  expect((await memory.getMemory(victim))?.content).toBe("BRAND NEW BODY that must be findable");
  expect((await memory.searchMemoriesNoLog({ query: "BRAND NEW BODY" })).map((m) => m.id)).toEqual([victim]);

  // The invariant behind that assertion, checked across the whole corpus:
  // fts_text is a function of the stored title, content and tags.
  const t = await table("memories");
  const rows = await t.query().select(["id", "title", "content", "tags", "fts_text"]).toArray();
  expect(rows.length).toBe(N);
  for (const row of rows) {
    const tags: string[] = row.tags ? Array.from(row.tags.toArray ? row.tags.toArray() : row.tags) : [];
    expect(String(row.fts_text)).toBe(`${row.title}\n${row.content}\n${tags.join(" ")}`);
    // The memory that already carried both must not now carry the target twice.
    expect(tags).toEqual(["arra"]);
  }
  expect(await t.countRows(`array_has(tags, ${lit("oracle")})`)).toBe(0);
});

test("concurrent writes to one kv key leave one row, not several", async () => {
  // Upstream's kv.key was a PRIMARY KEY. mergeInsert does not replace that:
  // concurrent merges each read the same table version, each find no match, and
  // each insert — and Lance has no unique constraint to catch it, so the
  // duplicates are permanent. `toggle_tool` twice in one MCP batch is enough.
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => kv.kvPut("burst", `value-${i}`, { expirationTtl: 600 })),
  );
  const t = await table("kv");
  expect(await t.countRows(`key = ${lit("burst")}`)).toBe(1);

  await kv.kvPut("burst", "final", { expirationTtl: 600 });
  expect(await kv.kvGet("burst")).toBe("final");
  expect(await t.countRows(`key = ${lit("burst")}`)).toBe(1);

  // A rejected write must not wedge the chain for that key.
  await Promise.allSettled([
    kv.kvPut("burst", "x".repeat(10), { expirationTtl: 600 }),
    kv.kvPut("burst", "y", { expirationTtl: 600 }),
  ]);
  expect(await t.countRows(`key = ${lit("burst")}`)).toBe(1);
});

test("facet ties break by bytes, the way the SQL they replace broke them", async () => {
  await clearCorpus();
  // SQLite's default collation is BINARY, so `ORDER BY project ASC` puts Beta
  // before alpha — uppercase letters come first in ASCII. localeCompare says
  // the opposite, and says it differently depending on the host's ICU data, so
  // the chip rows and the generated MCP tool names came out in another order
  // and a different value survived a LIMIT.
  await seed([
    { id: "f1", project: "Beta", workspace: "Home", createdBy: "Nat", tags: ["Infra"], title: "one", content: "one" },
    { id: "f2", project: "Beta", workspace: "Home", createdBy: "nat", tags: ["Infra"], title: "two", content: "two" },
    { id: "f3", project: "alpha", workspace: "home", createdBy: "nat", tags: ["infra"], title: "three", content: "three" },
    { id: "f4", project: "alpha", workspace: "home", createdBy: "claude", tags: ["infra"], title: "four", content: "four" },
  ]);

  expect((await memory.listProjects(20)).map((p) => p.project)).toEqual(["Beta", "alpha"]);
  expect((await memory.listWorkspaces(50)).workspaces.map((w) => w.workspace)).toEqual(["Home", "home"]);
  expect((await memory.listTags(50)).map((t) => t.tag)).toEqual(["Infra", "infra"]);
  // Equal counts everywhere here, so every one of these is a pure tie-break.
  const facets = await memory.listFacets();
  expect(facets.projects.map((p) => p.project)).toEqual(["Beta", "alpha"]);
  expect(facets.tags.map((t) => t.tag)).toEqual(["Infra", "infra"]);
  // agents: nat 2, Nat 1, claude 1 — count leads, then bytes.
  expect(facets.agents.map((a) => a.agent)).toEqual(["nat", "Nat", "claude"]);
});
