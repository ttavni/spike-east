// Calendar-day helpers, in the league's timezone.
// Bucketing by calendar day has to give the same answer on the server (UTC) and on a
// phone in London, or a 23:30 BST game lands on a different cell in the SSR pass than
// the hydrated one. So the timezone is an explicit IANA zone, never the host's offset.
export const LEAGUE_TZ = "Europe/London";
export const DAY_MS = 86_400_000;

const dayFmtCache: Record<string, Intl.DateTimeFormat> = {};
function dayFmt(tz: string): Intl.DateTimeFormat {
  // en-CA formats as YYYY-MM-DD, which sorts lexicographically.
  return (dayFmtCache[tz] ??= new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }));
}

/** The calendar day an epoch falls on, in the league's timezone. "YYYY-MM-DD". */
export function dayKey(t: number, tz: string = LEAGUE_TZ): string {
  return dayFmt(tz).format(new Date(t));
}

/**
 * A day key as an integer day number. Arithmetic happens in this space (plain UTC
 * midnights) rather than on real timestamps, so stepping day to day can't be knocked
 * off by a DST transition.
 */
export function dayNum(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
export function numKey(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(n: number): number {
  return (new Date(n * DAY_MS).getUTCDay() + 6) % 7;
}

/**
 * The epoch at which a calendar day begins in the league's timezone: "2026-10-06" → midnight in
 * London that morning (23:00 UTC the night before, in summer). Midnight never falls inside a
 * DST jump in London (they happen at 01:00 and 02:00), so the offset at that instant is exact.
 */
export function dayStart(key: string, tz: string = LEAGUE_TZ): number {
  // The round trip rejects days that don't exist: "2026-02-30" would otherwise roll into March.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || numKey(dayNum(key)) !== key) throw new Error(`not a real YYYY-MM-DD day: ${key}`);
  const utcMidnight = dayNum(key) * DAY_MS;
  // The zone's offset at that moment: read the wall clock there and compare.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMidnight));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return utcMidnight - (wall - utcMidnight);
}
