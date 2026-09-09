/**
 * Time ranges, and the tool names that describe them.
 *
 * This is the other half of the dynamic tool surface. Rather than making a
 * model construct ISO timestamps for a `from`/`to` parameter — which it will
 * get wrong, and which reads as an API rather than a question — the corpus
 * offers the ranges people actually ask for as named tools:
 *
 *   search_today            search_last_7days       search_last_3weeks
 *   search_last_1month      search_2026_08          search_2026_07_to_2026_08
 *
 * Relative windows are always available. Calendar months are generated only for
 * months the corpus actually spans, so a model is never offered an empty one.
 *
 * Every range resolves to a pair of ISO-8601 strings, because created_at is
 * stored as ISO-8601 UTC and therefore sorts lexicographically — a range query
 * is a string BETWEEN with no date parsing in the database at all.
 */

export interface TimeRange {
  fromIso: string;
  toIso: string;
  label: string;
}

/** The far future, as a string that sorts after any real timestamp. */
const FOREVER = "9999-12-31T23:59:59.999Z";

const day = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * day).toISOString();
}

/** Midnight UTC today. "Today" means the calendar day, not the last 24 hours. */
function startOfTodayIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** The fixed relative windows, always offered regardless of corpus contents. */
export const RELATIVE_RANGES: Record<string, { label: string; from: () => string }> = {
  today: { label: "today", from: startOfTodayIso },
  yesterday: { label: "since yesterday", from: () => isoDaysAgo(2) },
  last_7days: { label: "the last 7 days", from: () => isoDaysAgo(7) },
  last_2weeks: { label: "the last 2 weeks", from: () => isoDaysAgo(14) },
  last_3weeks: { label: "the last 3 weeks", from: () => isoDaysAgo(21) },
  last_1month: { label: "the last month", from: () => isoDaysAgo(30) },
  last_3months: { label: "the last 3 months", from: () => isoDaysAgo(90) },
  last_6months: { label: "the last 6 months", from: () => isoDaysAgo(182) },
  last_1year: { label: "the last year", from: () => isoDaysAgo(365) },
};

/** `search_last_3weeks` → the range it names, or null if it names nothing. */
export function resolveRelative(key: string): TimeRange | null {
  const range = RELATIVE_RANGES[key];
  if (!range) return null;
  return { fromIso: range.from(), toIso: FOREVER, label: range.label };
}

/**
 * A calendar month, `YYYY_MM` or `YYYY-MM`.
 *
 * The upper bound is the first instant of the following month, expressed as a
 * string strictly below it — using `<=` against "next month minus nothing"
 * would silently include the first millisecond of the next month.
 */
export function resolveMonth(token: string): TimeRange | null {
  const match = /^(\d{4})[-_](\d{2})$/.exec(token);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;

  const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  // Last millisecond of the month, so the comparison can stay inclusive.
  const to = new Date(Date.UTC(year, month, 1) - 1).toISOString();

  return {
    fromIso: from,
    toIso: to,
    label: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}

/** `2026_07_to_2026_08` → July 1st through the end of August. */
export function resolveMonthSpan(token: string): TimeRange | null {
  const match = /^(\d{4}[-_]\d{2})_to_(\d{4}[-_]\d{2})$/.exec(token);
  if (!match) return null;

  const start = resolveMonth(match[1]);
  const end = resolveMonth(match[2]);
  if (!start || !end) return null;

  // A backwards span is a mistake worth reporting, not silently swapping —
  // silently correcting it would hide the caller's bug.
  if (start.fromIso > end.toIso) return null;

  return {
    fromIso: start.fromIso,
    toIso: end.toIso,
    label: `${start.label} to ${end.label}`,
  };
}

/** Resolves any `search_*` suffix to a range, whichever form it takes. */
export function resolveRange(token: string): TimeRange | null {
  return resolveRelative(token) ?? resolveMonthSpan(token) ?? resolveMonth(token);
}
