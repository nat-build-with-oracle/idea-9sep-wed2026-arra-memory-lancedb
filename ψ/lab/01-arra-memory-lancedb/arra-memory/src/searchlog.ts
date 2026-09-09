import { setting } from "./config";
import { byNewest, likePattern, lit, scan, table, topRows } from "./db";
import { nowIso } from "./utils";

/**
 * A record of what was searched for, and what came back.
 *
 * This stores query text. That is a deliberate choice with a real cost: a
 * search log is often more revealing than the corpus it searches, because what
 * someone looked for says more than what they wrote down. It exists because
 * "what was I searching for last week" is a question worth answering, and it is
 * switchable off for exactly the same reason — see `search_log` in config.yaml.
 *
 * Result IDs are stored, result CONTENT is not. The memories live in the table
 * next door; copying their text here would double the blast radius of a leak
 * and add nothing you could not get by reading them back.
 *
 * Recording never blocks or fails a search. A log that can break the thing it
 * observes is worse than no log.
 */

export interface SearchLogEntry {
  id: string;
  query: string;
  mode: string;
  kind: string;
  workspace: string;
  project: string;
  tag: string;
  resultCount: number;
  resultIds: string[];
  durationMs: number;
  source: string;
  createdAt: string;
}

interface SearchLogRow {
  id: string;
  query: string;
  mode: string;
  kind: string;
  workspace: string;
  project: string;
  tag: string;
  result_count: number;
  result_ids: string;
  duration_ms: number;
  source: string;
  created_at: string;
}

function toEntry(row: SearchLogRow): SearchLogEntry {
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(row.result_ids);
    if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    ids = [];
  }
  return {
    id: row.id,
    query: row.query,
    mode: row.mode,
    kind: row.kind ?? "",
    workspace: row.workspace ?? "",
    project: row.project ?? "",
    tag: row.tag ?? "",
    resultCount: Number(row.result_count),
    resultIds: ids,
    durationMs: Number(row.duration_ms),
    source: row.source ?? "",
    createdAt: row.created_at,
  };
}

/** Off unless explicitly enabled — logging queries is opt-in, not a default. */
export function searchLogEnabled(): boolean {
  return setting("search_log").toLowerCase() === "true";
}

/**
 * Records one search. Never throws — a failure here is swallowed on purpose,
 * because the caller has already produced results the user is waiting for.
 */
export async function recordSearch(entry: {
  query?: string;
  mode?: string;
  kind?: string;
  workspace?: string;
  project?: string;
  tag?: string;
  resultIds: string[];
  durationMs: number;
  source?: string;
}): Promise<void> {
  if (!searchLogEnabled()) return;
  try {
    const t = await table("search_log");
    await t.add([
      {
        id: crypto.randomUUID(),
        query: (entry.query ?? "").slice(0, 240),
        mode: entry.mode ?? "keyword",
        kind: entry.kind ?? "",
        workspace: entry.workspace ?? "",
        project: entry.project ?? "",
        tag: entry.tag ?? "",
        result_count: entry.resultIds.length,
        result_ids: JSON.stringify(entry.resultIds.slice(0, 50)),
        duration_ms: Math.round(entry.durationMs),
        source: entry.source ?? "",
        created_at: nowIso(),
      },
    ]);
  } catch {
    // Observability must never cost the thing it observes.
  }
}

export async function listSearchLog(limit = 50, query?: string): Promise<SearchLogEntry[]> {
  const t = await table("search_log");
  const needle = (query ?? "").trim().toLocaleLowerCase();
  const capped = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
  const rows = await topRows<SearchLogRow>(t, {
    where: needle ? `lower(query) LIKE ${lit(likePattern(needle))}` : undefined,
    sortColumns: ["created_at"],
    compare: byNewest("created_at"),
    limit: capped,
  });
  return rows.map(toEntry);
}

export async function deleteSearchLogEntry(id: string): Promise<boolean> {
  const t = await table("search_log");
  const r = await t.delete(`id = ${lit(id)}`);
  return Number(r.numDeletedRows ?? 0) > 0;
}

/** Everything. The caller is responsible for having meant it. */
export async function clearSearchLog(): Promise<number> {
  const t = await table("search_log");
  const r = await t.delete("id IS NOT NULL");
  return Number(r.numDeletedRows ?? 0);
}

/** Drops entries older than `days`. The default retention people expect. */
export async function pruneSearchLog(days = 30): Promise<{ removed: number; cutoff: string }> {
  const t = await table("search_log");
  const safeDays = Math.max(0, Math.trunc(days));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const r = await t.delete(`created_at < ${lit(cutoff)}`);
  return { removed: Number(r.numDeletedRows ?? 0), cutoff };
}

export async function searchLogStats(): Promise<{
  enabled: boolean;
  total: number;
  oldest: string | null;
  newest: string | null;
}> {
  try {
    const t = await table("search_log");
    const stamps = await scan<{ created_at: string }>(t, { columns: ["created_at"] });
    let oldest: string | null = null;
    let newest: string | null = null;
    for (const { created_at } of stamps) {
      if (oldest === null || created_at < oldest) oldest = created_at;
      if (newest === null || created_at > newest) newest = created_at;
    }
    return { enabled: searchLogEnabled(), total: stamps.length, oldest, newest };
  } catch {
    return { enabled: searchLogEnabled(), total: 0, oldest: null, newest: null };
  }
}
