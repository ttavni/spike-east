// Ratings for every view of the league (All time, and each season), built once per change.
//
// A view's ledger and rank ranges are a deterministic function of three things: the model,
// the players, and that view's games. So each is cached under a fingerprint of the model
// (`RATING_KEY`) and of its games (`sig`), and recomputed only when one of those moves:
//
//   - a logged game changes All time and the season it fell in; a finished season never refits
//   - a stale ledger is extended, not rebuilt: computeStandings reuses every prefix that still
//     matches, so one new game is one warm fit
//   - the opening season's games are a prefix of All time's, so it borrows that ledger rather
//     than fitting (or shipping) its own copy
//
// Pure, so it's tested directly; ratingLedger.ts wraps it with the process memory and the
// rating_cache table.

import {
  computeStandings, rankRanges, matchSigs, packLedger,
  MODEL, START, SCALE, WIN_MIN, WIN_PER, PROV_N, DORMANT_DAYS, RANGE_SAMPLES, RANGE_SEED,
  type Ledger, type PackedLedger, type LeagueMatch, type LeaguePlayer,
} from "./league";
import { allScopes, isFinal, isFresh, scopeKey, scopeMatches, type Scope, type Season } from "./season";

/** Two independent 32-bit FNV-1a hashes and a count: plenty to tell two match lists apart. */
export function fingerprint(parts: string[]): string {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x01000193) >>> 0;
    }
    a = Math.imul(a ^ 0x1f, 0x01000193) >>> 0; // separator, so ["ab","c"] ≠ ["a","bc"]
    b = Math.imul(b ^ 0x1e, 0x01000193) >>> 0;
  }
  return `${parts.length}:${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/** Bump when the maths around the fit changes in a way no constant captures (how held, rank
 *  ranges or resting are worked out). Deploys on Vercel are covered without it, below. */
const CACHE_VERSION = 3; // 2: later seasons start everyone on START; 3: ledgers record `fresh`

/**
 * Everything besides the games that a cached rating depends on: the constants, and on Vercel the
 * commit, so every deploy computes its own rows once and never trusts another build's (a preview
 * sharing the production database included). A change to rating.ts's code is also caught
 * directly, by `ledgerStillFits`, whenever a row is read back.
 */
export const RATING_KEY = fingerprint([
  JSON.stringify(MODEL),
  ...[START, SCALE, WIN_MIN, WIN_PER, PROV_N, DORMANT_DAYS, RANGE_SAMPLES, RANGE_SEED, CACHE_VERSION].map(String),
  process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID ?? "",
]);

export type RankRanges = Record<string, [number, number]>;

/** One view, as the phones get it. A null ledger means "use All time's": this view's games
 *  are a prefix of All time's, so computeStandings reuses that ledger for every one of them. */
export type ScopeRatings = { ledger: PackedLedger | null; rankRanges: RankRanges };

/** One view, as cached. `packed` is kept beside `ledger` so it's packed once, not per request. */
export type CachedScope = {
  model: string;
  sig: string;
  ledger: Ledger | null;
  packed: PackedLedger | null;
  rankRanges: RankRanges;
};

export type ScopeGames = { scope: Scope; key: string; matches: LeagueMatch[]; final: boolean; fresh: boolean; sig: string };

/**
 * Every view there is, All time first, with its games and their fingerprint. A finished season
 * ranks differently (nobody rests), so finishing is part of the fingerprint: a season closing
 * recomputes its rank ranges even though none of its games changed.
 */
export function scopeGames(players: LeaguePlayer[], matches: LeagueMatch[], seasons: Season[]): ScopeGames[] {
  return allScopes(seasons).map((scope) => {
    const ms = scopeMatches(matches, scope, seasons);
    const final = isFinal(scope, seasons), fresh = isFresh(scope, seasons);
    const sig = fingerprint([...matchSigs(players, ms), final ? "final" : "open", fresh ? "fresh" : "league"]);
    return { scope, key: scopeKey(scope), matches: ms, final, fresh, sig };
  });
}

export const isCurrent = (c: CachedScope | undefined, sig: string): boolean => !!c && c.model === RATING_KEY && c.sig === sig;

export function buildRatings(
  players: LeaguePlayer[],
  matches: LeagueMatch[],
  seasons: Season[],
  prev: ReadonlyMap<string, CachedScope>,
): { ratings: Record<string, ScopeRatings>; cache: Map<string, CachedScope>; changed: string[]; allLedger: Ledger } {
  const cache = new Map<string, CachedScope>();
  const ratings: Record<string, ScopeRatings> = {};
  const changed: string[] = [];
  let all: CachedScope | undefined;
  let allLedger: Ledger = { sigs: [], snaps: [] };

  for (const g of scopeGames(players, matches, seasons)) {
    const old = prev.get(g.key);
    let entry: CachedScope;
    if (old && isCurrent(old, g.sig)) {
      entry = old;
    } else if (all && g.sig === all.sig) {
      // The same games as All time (there's only one season so far): same ratings, no work.
      entry = { ...all, ledger: null, packed: null };
      changed.push(g.key);
    } else {
      // Extend whichever ledger shares the longest prefix with these games: this view's own,
      // if it was built under the same model, otherwise All time's.
      const warm = old && old.model === RATING_KEY && old.ledger ? old.ledger : allLedger;
      const cs = computeStandings(players, g.matches, { ledger: warm, final: g.final, fresh: g.fresh });
      // Only a season run on the league's own priors can share All time's snapshots.
      const borrows = g.scope !== "all" && !g.fresh && cs.ledger.snaps.every((s, i) => s === allLedger.snaps[i]);
      const held = Object.fromEntries(cs.all.map((p) => [p.id, p.held]));
      entry = {
        model: RATING_KEY,
        sig: g.sig,
        ledger: borrows ? null : cs.ledger,
        packed: borrows ? null : packLedger(cs.ledger),
        rankRanges: rankRanges(players, g.matches, RANGE_SAMPLES, RANGE_SEED, held, g.final, g.fresh),
      };
      changed.push(g.key);
    }
    if (g.scope === "all") { all = entry; allLedger = entry.ledger ?? allLedger; }
    cache.set(g.key, entry);
    ratings[g.key] = { ledger: entry.packed, rankRanges: entry.rankRanges };
  }
  return { ratings, cache, changed, allLedger };
}
