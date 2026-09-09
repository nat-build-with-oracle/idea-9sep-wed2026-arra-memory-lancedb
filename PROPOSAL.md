# Proposal — arra-memory-lancedb

born 15:41 +07 from nat-build-with-oracle/9sep-wed2026-oracle · status: **built, lab-proven (2026-09-09)**

## The idea

Port the memory add-on that runs as `thor-memory` — the real one is
[Soul-Brews-Studio/arra-memory-haos](https://github.com/Soul-Brews-Studio/arra-memory-haos),
v0.27.1, libSQL-backed — from libSQL to **LanceDB**, keeping the web UI, the MCP
surface, the OAuth server and the fleet layer byte-for-byte the same. Only the
storage layer changes: vectors become a native column, full-text search becomes a
tantivy ngram index, and the corpus becomes a directory any LanceDB client
(Python, Rust, DuckDB) can open without the add-on in the loop.

Two things were asked and answered on the way in:

- **Is `arra-memory-cloudflare-template` thor-memory?** No. That template
  (2026-08-22, Turso + Cloudflare Workers, six fixed kinds, no workspace/project)
  is the *ancestor*. thor-memory is `arra-memory-haos`: `<memory-host>`
  serves its `public/index.html` verbatim, `?v=0.27.1`, the version in its
  `config.yaml`. The Workers template also cannot run LanceDB at all — the
  binding is native (napi), and Workers have no native modules.
- **Same UI as `<ha-host>/cd2339cc_arra_memory`?** Yes, by
  construction: `src/ui/**`, `public/index.html`, `pages.tsx` are untouched
  copies of arra-memory-haos at commit `ecb1c37`.

## Why now

Pulse [#200](https://github.com/laris-co/pulse-oracle/discussions/200) mapped the
digger family this morning: arra-memory-haos is the root of the shared auth
plumbing and the only member NOT on LanceDB (libSQL), while digger-wiki and
hook-lance each carry a Python LanceDB sidecar. thor-memory itself spent
2026-09-04 → 09-09 behind a Cloudflare 1033 because the `thor` KVM guest
crash-loops. A corpus that is one Lance directory — copyable to R2 with a URI —
is the survival story that outage asked for.

## What it took

- [x] Locate thor-memory's source and prove the identity (HTML byte match, v0.27.1).
- [x] Prove `@lancedb/lancedb` 0.38 runs under Bun 1.3 on macOS: FTS ngram
      finds Thai inside Thai, prefilters work with FTS and vector search,
      `mergeInsert` upserts, `update` returns `rowsUpdated`, unindexed rows are
      still searched. Pin `apache-arrow@18.1.0` — 21.x breaks schema marshalling.
- [x] Rewrite the storage layer: `db.ts` (schemas, open/create, FTS index,
      housekeeping, filter helpers), `memory.ts`, `kv.ts`, `oauth.ts`,
      `searchlog.ts`, `graph.ts`. Delete `sql.ts`. Drop the Turso settings.
- [x] Keep every exported function signature so `server.ts`, `mcp.ts`,
      `fleet.ts`, `digest.ts` and the whole UI compile unchanged (`tsc` clean).
- [x] Tests: the 3 upstream data tests ported + a 21-case `store.test.ts`
      covering Thai FTS, substring semantics, quote/backslash/wildcard safety,
      scope filters, tag case-insensitivity, id prefix, facets, merges, ranges,
      kv expiry, OAuth PKCE single-use, search log. 43/43 pass.
- [x] Run it: `bun src/server.ts` on :8097 with local Ollama `bge-m3` —
      English query "moving the memory store to a vector database" recalls the
      Thai memory first by hybrid; graph draws 4 nodes with one written
      `[[link]]`; MCP `remember` → `recall_memories` → `digest` round-trips.
- [ ] HAOS image: the Dockerfile's bun download step fails under Docker on this
      Mac (curl exit 23 inside the Alpine base) — a fetch problem, not a
      LanceDB one; `@lancedb/lancedb-linux-{x64,arm64}-musl` exist on npm.
- [ ] Deploy beside `arra_memory` on a HAOS guest (slug `arra_memory_lancedb`,
      LAN port 8098) and migrate a real corpus with a one-shot importer.

## Done when

`<ha-host>/03926c4d_arra_memory_lancedb` opens the same UI over a
`/data/lancedb` directory, claude.ai connects over OAuth, and `list_search_log`
shows searches that ran against Lance. Until then: `ψ/lab/01-arra-memory-lancedb`
runs locally, and the tests are the contract.

## Notes

- Lab: `ψ/lab/01-arra-memory-lancedb/` — the add-on lives in `arra-memory/`,
  `UPSTREAM_COMMIT` names the arra-memory-haos commit it was cut from.
- What LanceDB cannot express and where it went: ORDER BY / GROUP BY → in
  process after a narrow-column scan (`topRows`, `facetRows`); an empty list in
  `UPDATE` → stored as NULL, read as `[]`; field-weighted BM25 → title/tag
  boost applied to the index score; phrase MATCH → candidate set from the
  index, membership by substring.
- Changing `embedding_dimensions` rebuilds `memories` with vectors cleared and
  writes a JSON snapshot beside the directory first; backfill re-embeds.
