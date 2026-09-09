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

## Bring an existing corpus across

The libSQL add-on keeps everything in one file at `/data/arra-memory.db`. Take it
from a Home Assistant backup (or copy it off the guest) and:

```bash
cd arra-memory
LANCEDB_URI=/data/lancedb bun scripts/import-libsql.ts /path/to/arra-memory.db
#                                                       --dry-run to look first
```

It opens the source **read-only** and moves every table, not just the memories:
the search log, the `kv` table that remembers which MCP tools you switched off,
and the OAuth tables — so the claude.ai connector keeps working instead of
needing re-approval. Vectors come across decoded from `F32_BLOB`, so semantic
search works immediately with no re-embed. Upserts by primary key, so a re-run
after a partial import fills the gaps rather than doubling the corpus.

If the source's vectors are a different width than this instance's
`embedding_dimensions`, it stops and says so; `--force` imports the text with
vectors cleared and leaves `POST /api/index/backfill` to rebuild them.

`src/import.test.ts` proves all of the above against a database built with
upstream's shipped schema.

Everything about connecting Claude Code, Codex and claude.ai — OAuth discovery,
`claude mcp add … --transport http`, the `--header` ordering trap, tunnels and
`public_url` — is unchanged from upstream and documented in
[arra-memory-haos/README.md](https://github.com/Soul-Brews-Studio/arra-memory-haos/blob/main/README.md).

## What changed under the hood

| libSQL version | This port |
|---|---|
| `sql.ts`: every statement, `?`-parameterised | no SQL; WHERE strings built only through `lit()` / `likePattern()` / `inList()` |
| `ORDER BY`, `GROUP BY`, `COUNT(DISTINCT)` | in process, after a scan of the sort/group columns only (`topRows`, `facetRows`) |
| FTS5 trigram, `MATCH "phrase"`, `bm25(3,1,2)` | ngram(3,3) inverted index **ranks**, a pushed-down `LIKE` decides **membership**, title ×3 / tags ×2 boost on the index score |
| `UPDATE … json_group_array(…)` for a tag merge | one `update` with `valuesSql`, deriving `fts_text` from the live `title`/`content` |
| `tags` as a JSON string, `json_each` | `tags` as `List<Utf8>`; empty stored as NULL because `UPDATE` cannot write `[]` |
| `F32_BLOB(1024)` + `libsql_vector_idx` | `FixedSizeList<Float32>`; `vectorSearch().distanceType("cosine")` with a prefilter |
| `ALTER TABLE ADD COLUMN` migrations | schema is fixed at create; a changed `embedding_dimensions` rebuilds `memories` with vectors cleared (JSON snapshot first) and backfill re-embeds |
| Turso embedded replica | `LANCEDB_URI=s3://…` with the usual `AWS_*` variables |
| FTS triggers keep the index in step | rows written after the index are still searched; `optimize()` folds them in every 10 minutes |

LanceDB facts that shaped the code and are worth knowing before touching it:

- `apache-arrow` must be **18.1.0** (lancedb's peer range is `>=15 <=18.1`);
  21.x installs fine and then fails to marshal every schema.
- The FTS tokenizer defaults `removeStopWords: true` and `stem: true`, which
  silently makes "are" and "the" unfindable and mangles trigrams. Both are off.
- **Membership belongs in the WHERE, never after the limit.** The ngram index
  ORs the query's trigrams, so rows that merely share trigrams compete for the
  same slots as rows that contain the query. Filtering after a fixed candidate
  pool made the same query return three rows at limit 100 and nothing at the
  default limit of 30. Thai makes that ordinary rather than adversarial.
- **There is no unique constraint.** `mergeInsert` is not an upsert under
  concurrency: two writers each read the same table version, each find no
  match, and each insert. `kv.ts` serialises per key to restore what a PRIMARY
  KEY used to give.
- **A lone UTF-16 surrogate truncates a filter string** at that byte, silently
  dropping every clause after it — including an expiry check. `lit()` and
  `likePattern()` call `toWellFormed()` for that reason.
- Facet tie-breaks use byte order, not `localeCompare`, because that is what
  SQLite's BINARY collation gave and the chip rows are compared against it.

Each of those has a test in `src/regressions.test.ts` that fails without the
fix — they were all found by an adversarial audit of this port against the
libSQL original, and every one of them returned a plausible wrong answer rather
than an error.

## Measured (m5, Apple Silicon, Bun 1.3.14, no embedder)

The in-process ordering and grouping is the design decision most worth
checking, so here it is at two corpus sizes — synthetic rows with 480-char
bodies, warm process, single run:

| operation | 3,000 memories | 30,000 memories |
|---|---|---|
| list newest 30 (`topRows`) | 10 ms | 39 ms |
| list newest 30, one workspace | 4 ms | 10 ms |
| FTS "ความจำ" | 5 ms | 22 ms |
| FTS, scoped to 2 workspaces + kind | 4 ms | 21 ms |
| 2-char query (substring scan) | 41 ms | 361 ms |
| tag filter (full scan, as upstream) | 25 ms | 221 ms |
| `listFacets` (every chip row) | 13 ms | 99 ms |
| range search, last 24h | 6 ms | 6 ms |
| create / get / update | 3 / 2 / 4 ms | 3 / 3 / 5 ms |
| merge a facet across the corpus | 5 ms | 23 ms |
| insert 3k / 30k rows in 500-row batches | 69 ms | 422 ms |

The slow rows at 30k are the paths that read every body: queries shorter than a
trigram, and a tag filter — which stays on the scan on purpose, because a tag is
matched case-insensitively against a case-preserving list and no filter
expression can say that. If a corpus ever gets there, a lowercased `tags_lc`
column would turn the tag path into a server-side `array_has`.

## Status

Lab-proven on 2026-09-09:

- **55 tests green on macOS**, and the 51 that do not need a broker re-run green
  inside `ghcr.io/home-assistant/aarch64-base:3.22` — the actual HAOS runtime,
  Alpine musl aarch64, with the `linux-arm64-musl` binding. That is the answer
  to "will the native dependency work on a Home Assistant guest": measured, not
  assumed. (The four `fleet.test.ts` cases stand up an MQTT broker and report
  nothing in that throwaway container; `fleet.ts` is byte-identical to upstream.)
- An **adversarial audit against the libSQL original** (44 agents, eight
  dimensions, every finding attacked by two independent skeptics) confirmed
  nine defects and refuted nine. All nine are fixed, each with a regression
  test proven to fail without its fix.
- A local instance with Ollama `bge-m3` recalls a Thai memory from an English
  question, MCP `remember → recall → digest` round-trips, the atlas draws
  written `[[links]]`, and a libSQL corpus imports with its vectors and its
  claude.ai connector intact.

Not yet deployed on a HAOS guest, and the `docker build` of the add-on image has
not completed **on this Mac** — the colima VM's 20GB disk is 96% full with other
projects' images, so the build dies in the export step. That is an environment
limit, not a code one; the runtime it would package is the one proven above, and
`.github/workflows/builder.yml` builds it on CI where disk is not the issue.

See `../../../PROPOSAL.md` for the punch list.
