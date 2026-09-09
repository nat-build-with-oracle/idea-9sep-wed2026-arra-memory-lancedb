# Arra Memory on LanceDB — Home Assistant add-on

The memory add-on that runs as `thor-memory`, ported from libSQL to
[LanceDB](https://lancedb.com). Same sidebar UI, same MCP tools, same OAuth
server, same fleet layer — cut from
[Soul-Brews-Studio/arra-memory-haos](https://github.com/Soul-Brews-Studio/arra-memory-haos)
at the commit in `UPSTREAM_COMMIT` (v0.27.1, the build serving
`<ha-host>/cd2339cc_arra_memory`). Only the storage layer is new.

What that buys:

- **Vectors are a column.** `embedding` is a `FixedSizeList<Float32>[1024]`;
  nearest-neighbour search is native, filterable, and needs no extension.
- **Full-text search finds Thai inside Thai.** A tantivy inverted index over
  3-character ngrams — the same reasoning as the trigram FTS5 the original chose.
- **The corpus is a directory.** `/data/lancedb/` opens from Python, Rust, or
  DuckDB without this add-on running. Point `LANCEDB_URI` at `s3://…` and the
  same code runs against R2 — that is the whole replacement for the Turso replica.

## Layout

```
arra-memory/            the add-on (Supervisor reads config.yaml here)
  src/db.ts             LanceDB connection, table schemas, FTS index, housekeeping
  src/memory.ts         the corpus: CRUD, keyword / semantic / hybrid recall, facets, merges
  src/kv.ts oauth.ts searchlog.ts graph.ts    the other tables, same contracts as upstream
  src/server.ts mcp.ts fleet.ts digest.ts ui/  UNCHANGED from upstream
  src/store.test.ts     the storage contract, 21 cases
repository.yaml         so the folder can be added as an add-on repository
UPSTREAM_COMMIT         arra-memory-haos commit this was cut from
```

## Run it locally

```bash
cd arra-memory
bun install
bun run build:ui                       # public/main.js + public/app.css
OWNER_PASSPHRASE=change-me \
LANCEDB_URI=./.data/lancedb \
OLLAMA_URL=http://127.0.0.1:11434 \    # optional — bge-m3 for semantic search
SEARCH_LOG=true PORT=8097 \
bun src/server.ts
```

Then open http://127.0.0.1:8097 — the lock screen takes the passphrase. Every
option in `config.yaml` has an environment variable of the same name upper-cased;
`run.sh` is what maps Supervisor's options onto them on HAOS.

```bash
bun run typecheck && bun run test     # one process per test file, on purpose
```

## Install on Home Assistant

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add this
   repository's URL (it must be reachable by the HA host — a public GitHub repo,
   or a local folder copied to `/addons`).
2. Install **Arra Memory (LanceDB)**. It is slug `arra_memory_lancedb` on LAN
   port **8098**, so it can run beside the libSQL `arra_memory` on 8099.
3. Set `owner_passphrase` (`openssl rand -base64 32`) in the Configuration tab
   and start it. The sidebar gains a **Memory** panel.

There is no prebuilt image yet, so Supervisor builds the container on the host
from `arra-memory/Dockerfile` (Alpine base + Bun; `@lancedb/lancedb` ships
`linux-x64-musl` and `linux-arm64-musl` binaries).

Everything about connecting Claude Code, Codex and claude.ai — OAuth discovery,
`claude mcp add … --transport http`, the `--header` ordering trap, tunnels and
`public_url` — is unchanged from upstream and documented in
[arra-memory-haos/README.md](https://github.com/Soul-Brews-Studio/arra-memory-haos/blob/main/README.md).

## What changed under the hood

| libSQL version | This port |
|---|---|
| `sql.ts`: every statement, `?`-parameterised | no SQL; WHERE strings built only through `lit()` / `likePattern()` / `inList()` |
| `ORDER BY`, `GROUP BY`, `COUNT(DISTINCT)` | in process, after a scan of the sort/group columns only (`topRows`, `facetRows`) |
| FTS5 trigram, `MATCH "phrase"`, `bm25(3,1,2)` | ngram(3,3) inverted index for candidates, substring test for membership, title ×3 / tags ×2 boost on the index score |
| `tags` as a JSON string, `json_each` | `tags` as `List<Utf8>`; empty stored as NULL because `UPDATE` cannot write `[]` |
| `F32_BLOB(1024)` + `libsql_vector_idx` | `FixedSizeList<Float32>`; `vectorSearch().distanceType("cosine")` with a prefilter |
| `ALTER TABLE ADD COLUMN` migrations | schema is fixed at create; a changed `embedding_dimensions` rebuilds `memories` with vectors cleared (JSON snapshot first) and backfill re-embeds |
| Turso embedded replica | `LANCEDB_URI=s3://…` with the usual `AWS_*` variables |
| FTS triggers keep the index in step | rows written after the index are still searched; `optimize()` folds them in every 10 minutes |

Two LanceDB facts that shaped the code and are worth knowing before touching it:

- `apache-arrow` must be **18.1.0** (lancedb's peer range is `>=15 <=18.1`);
  21.x installs fine and then fails to marshal every schema.
- The FTS tokenizer defaults `removeStopWords: true` and `stem: true`, which
  silently makes "are" and "the" unfindable and mangles trigrams. Both are off.

## Status

Lab-proven on 2026-09-09: 43 tests green, a local instance with `bge-m3`
recalls a Thai memory from an English question, MCP `remember → recall → digest`
round-trips, the atlas draws written `[[links]]`. Not yet deployed on a HAOS
guest. See `../../../PROPOSAL.md` for the punch list.
