import { lit, scan, table } from "./db";
import { nowSeconds } from "./utils";

/**
 * The Cloudflare KV replacement.
 *
 * The hosted version bound a `KVNamespace` and used exactly three of its
 * methods — get, put with an expirationTtl, and delete — to track which owner
 * sessions are still valid. None of that needs Cloudflare; it needs a table
 * with an expiry column, which is what the `kv` Lance table is.
 *
 * Expiry is enforced inside the filter rather than by a background job, so an
 * expired entry is invisible to `get` the instant it lapses whether or not
 * anything has swept it. A stale row is a storage detail, never an auth
 * decision. `sweep` exists only to stop the table growing.
 */

export async function kvGet(key: string): Promise<string | null> {
  const t = await table("kv");
  const rows = await scan<{ value: string }>(t, {
    where: `key = ${lit(key)} AND (expires_at IS NULL OR expires_at > ${nowSeconds()})`,
    columns: ["value"],
    limit: 1,
  });
  return rows[0] ? String(rows[0].value) : null;
}

export async function kvPut(
  key: string,
  value: string,
  options: { expirationTtl?: number } = {},
): Promise<void> {
  const t = await table("kv");
  const expiresAt = options.expirationTtl ? nowSeconds() + options.expirationTtl : null;
  // Upsert, so re-issuing a session with the same id refreshes its deadline
  // instead of leaving two rows behind.
  await t
    .mergeInsert("key")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute([{ key, value, expires_at: expiresAt }]);
}

export async function kvDelete(key: string): Promise<void> {
  const t = await table("kv");
  await t.delete(`key = ${lit(key)}`);
}

/** Drops rows already past their deadline. Housekeeping only — see the note above. */
export async function kvSweep(): Promise<number> {
  const t = await table("kv");
  const result = await t.delete(`expires_at IS NOT NULL AND expires_at <= ${nowSeconds()}`);
  return Number(result.numDeletedRows ?? 0);
}
