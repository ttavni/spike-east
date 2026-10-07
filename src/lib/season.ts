// Seasons: windows on the match list.
//
// A season is nothing but a start day. Season 1 is the league from its first game; every later
// season starts at midnight (London) on the day listed in SEASON_STARTS, and runs until the next
// one does. Matches don't belong to a season, they fall inside one, so moving a boundary (or
// deleting one) can't lose or duplicate anything — the ratings simply recompute.
//
// Every view of the league — a season or All time — is the same engine run on a different
// window: `computeStandings(players, scopeMatches(...))`. So a new season is a fresh league:
// everyone starts it on the display START (`fresh`: nobody is new to the league, so there's no
// late-joiner prior), everyone has PROV_N games to place, and All time keeps every game ever
// played. The opening season keeps the league's own priors, so its table is All time as it
// stood. A game's season is decided by when it was logged.
// Pure and deterministic; the server and the phones compute identical windows.

import { dayStart } from "./day";

/** What Season 1's games were played to. */
export const FIRST_SEASON_TO = 21;

/**
 * When each season after the first begins — midnight in London on `day` — and what its games are
 * played to. THIS is how a season starts: a reviewed one-line change, not a button, because the
 * sign-in code is shared and anyone signed in can do anything an admin can. A day still in the
 * future does nothing until it arrives, so a season can be merged and deployed ahead of time.
 * Oldest first.
 */
export const SEASON_STARTS: { day: string; to: number }[] = [
  { day: "2026-10-06", to: 17 }, // Season 2: games to 17
];

export type Season = {
  n: number; // 1, 2, 3…
  start: number; // epoch ms, inclusive; 0 for Season 1, which runs from the very first game
  end: number | null; // epoch ms, exclusive; null for the season in progress
  to: number; // points its games are played to, win by 2
};

/** A view of the league: All time, or one season by number. */
export type Scope = "all" | number;

/**
 * Seasons from the start of every season after the first (a time, or a time and what it's played
 * to — 21 if unsaid), in any order. Season 1 has no start of its own: it's everything before
 * Season 2, played to FIRST_SEASON_TO.
 */
export function seasonsFrom(laterStarts: (number | { start: number; to?: number })[]): Season[] {
  const later = laterStarts
    .map((x) => (typeof x === "number" ? { start: x, to: FIRST_SEASON_TO } : { start: x.start, to: x.to ?? FIRST_SEASON_TO }))
    .sort((a, b) => a.start - b.start);
  const all = [{ start: 0, to: FIRST_SEASON_TO }, ...later];
  return all.map((s, i) => ({ n: i + 1, start: s.start, end: i + 1 < all.length ? all[i + 1].start : null, to: s.to }));
}

/** The seasons that have begun by `now` (the server's clock, so every phone agrees). */
export function seasonsAt(now: number, days: { day: string; to: number }[] = SEASON_STARTS): Season[] {
  return seasonsFrom(days.map((d) => ({ start: dayStart(d.day), to: d.to })).filter((s) => s.start <= now));
}

/** What a game played at `t` is played to: its season's rule. */
export function targetAt(seasons: Season[], t: number): number {
  return seasonAt(seasons, t)?.to ?? FIRST_SEASON_TO;
}

export function currentSeason(seasons: Season[]): Season {
  return seasons[seasons.length - 1] ?? { n: 1, start: 0, end: null, to: FIRST_SEASON_TO };
}

export function inSeason(s: Season, t: number): boolean {
  return t >= s.start && (s.end === null || t < s.end);
}

/** The season a moment falls in. Anything before Season 2 is Season 1. */
export function seasonAt(seasons: Season[], t: number): Season {
  for (let i = seasons.length - 1; i >= 0; i--) if (t >= seasons[i].start) return seasons[i];
  return seasons[0] ?? currentSeason(seasons);
}

export function inScope(scope: Scope, seasons: Season[], t: number): boolean {
  if (scope === "all") return true;
  const s = seasons.find((x) => x.n === scope);
  return !!s && inSeason(s, t);
}

/** A finished season: its table is final. All time and the season in progress never are. */
export function isFinal(scope: Scope, seasons: Season[]): boolean {
  return scope !== "all" && seasons.some((s) => s.n === scope && s.end !== null);
}

/** A season after the first: everyone starts it on START (see StandingsOpts.fresh). The
 *  opening season keeps the league's own priors, so its table is All time as it stood. */
export function isFresh(scope: Scope, seasons: Season[]): boolean {
  return scope !== "all" && seasons.some((s) => s.n === scope && s.start > 0);
}

/** The games a view is built from. Order is preserved; the engine sorts anyway. */
export function scopeMatches<T extends { order: number }>(matches: T[], scope: Scope, seasons: Season[]): T[] {
  return scope === "all" ? matches : matches.filter((m) => inScope(scope, seasons, m.order));
}

/** Stable string key for a scope: "all", "s1", "s2"… Used for caches and the wire format. */
export function scopeKey(scope: Scope): string {
  return scope === "all" ? "all" : `s${scope}`;
}

/** Every view there is, All time first. */
export function allScopes(seasons: Season[]): Scope[] {
  return ["all", ...seasons.map((s) => s.n)];
}

export function seasonName(n: number): string {
  return `Season ${n}`;
}
