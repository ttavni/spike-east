// How often a caller may try something. Pure, so it's tested directly; src/lib/auth/rateLimit.ts
// does the counting in Postgres (serverless instances share nothing else).
//
// A try is counted BEFORE it's judged, in one atomic upsert, and refused if that pushed its
// bucket over the limit. Checking first and counting after would let a burst of parallel
// guesses all read "0 so far" and all get through before any of them was counted.
//
// A code try counts against two buckets: the caller's IP, which stops one person grinding
// through codes, and the whole league, which stops a crowd of IPs doing it together. The
// league's bucket only counts tries the IP's let through, so one IP can't spend it alone. A
// refused try is never checked, so a locked-out guesser learns nothing. A right code clears its
// IP's bucket and hands its try back to the league's, so only wrong guesses fill that one up.
//
// The league-wide cap is what makes the code's length matter: at 30 wrong guesses per
// 15 minutes a 4-digit code still falls in about a day of patient guessing, a 6-digit one takes
// months, 8 digits decades. The cost is that a flood of wrong guesses can pause *new* sign-ins
// for everyone for 15 minutes; anyone already signed in (sessions last 60 days) is unaffected.
//
// Writes by signed-in players (logging a game, planning a night) are capped per IP only, far
// above a real night (five courts log ~25 games an hour, often all from one venue's WiFi). A
// league-wide cap there would let one person with the code stop everyone logging.

export type LimitPolicy = { windowMs: number; max: number };

const MIN = 60_000;
const HOUR = 60 * MIN;

export const LIMITS = {
  codeIp: { windowMs: 15 * MIN, max: 5 },
  codeAll: { windowMs: 15 * MIN, max: 30 },
  adminIp: { windowMs: HOUR, max: 5 },
  adminAll: { windowMs: HOUR, max: 20 },
  logIp: { windowMs: HOUR, max: 60 },
  planIp: { windowMs: 10 * MIN, max: 30 },
} satisfies Record<string, LimitPolicy>;

/** A bucket as the upsert left it: `hits` already includes the try being judged. */
export type Bucket = { hits: number; windowStart: number };

/** 0 if the try just counted into `row` is within the limit; otherwise how long (ms, at least 1)
 *  until its window reopens. A window that has run out starts again at 1 in the upsert, so a
 *  refusal never outlasts the window it was counted in. */
export function refusedFor(row: Bucket, policy: LimitPolicy, now: number): number {
  if (row.hits <= policy.max) return 0;
  return Math.max(1, row.windowStart + policy.windowMs - now);
}

/** "Too many tries" with a wait people can act on, rounded up to whole minutes. */
export function tooManyMessage(waitMs: number, what = "tries"): string {
  const min = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Too many ${what}. Try again in ${min} minute${min === 1 ? "" : "s"}.`;
}
