// Pure league engine, ported from the Spike v2 design (TrueSkill-lite).
// Computes standings, chemistry, matchmaker suggestions and per-player profiles
// from the raw players + matches lists. Runs identically on server and client.

export type LeaguePlayer = { id: string; name: string; color: string; active: boolean };

export type LeagueMatch = {
  id: string;
  date: string; // human label e.g. "Jun 23" or "Today"
  order: number; // chronological sort key (epoch ms)
  teamA: string[]; // 2 ids
  teamB: string[]; // 2 ids
  scoreA: number;
  scoreB: number;
  clientMatchId?: string | null; // links an optimistic local copy to its persisted server row
  /** Points the game was played to: its season's rule (21 in Season 1, 17 from Season 2).
   *  The fit only reads the points; this is for the win chance and par. Default 21. */
  to?: number;
};

export function initial(name: string): string {
  if (!name) return "?";
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ---- the rating model ----
// The maths lives in rating.ts (a whole-history points fit). This file turns a sequence of
// those fits into everything the app shows: standings, a per-game ledger, and the "why".
import {
  MODEL, SCALE, disp, fitSkills, snapshotOf, priorOf, foundersFor, expectedShare, gameWinProb, skillOf as fitSkillOf,
  type Snapshot, type Fit, type FitGame, type RatingModel,
} from "./rating";
export { MODEL, START, SCALE, disp, gameWinProb, expectedShare } from "./rating";

/** Games before a player gets a ladder rank. Below it they're "placing": rated, unranked.
 *  Bootstrapping the real league showed ranks still ±3 places at 9–11 games, so 8 is the
 *  least the league can look someone in the eye with. */
export const PROV_N = 8;

/** The least a win pays: WIN_MIN for a win by two, plus a point for every WIN_PER further
 *  points of margin, so even under par the scoreline still counts. The fit alone drops a
 *  favourite who wins under par; the ladder tops that win up to this instead, and the top-up
 *  is kept (PlayerStat.held). */
export const WIN_MIN = 2;
export const WIN_PER = 3;
export function winFloor(gf: number, ga: number): number {
  return WIN_MIN + Math.max(0, Math.round((gf - ga - 2) / WIN_PER));
}

// ---- rank tiers (roundnet-lingo names layered over the display rating) ----
// Reads as a prestige climb from a self-deprecating bottom to a mythical GOAT top.
export type Tier = { name: string; icon: string; color: string };
/** Shown while a player is still placing (<PROV_N games), regardless of their noisy rating. */
export const PROVISIONAL_TIER: Tier = { name: "Fresh Meat", icon: "🐣", color: "#8A9196" };
/** Numeric tiers, ascending. Each applies from `min` up to the next tier's `min`. Everyone
 *  starts in Pocket Sniper (START = 800, mid-list). Scotty Beeks (1400+) is a deliberately
 *  mythical cap — even a dominant #1 sits below it. */
export const TIERS: (Tier & { min: number })[] = [
  { min: 0, name: "Whiff Merchant", icon: "💨", color: "#FF6B6B" },
  { min: 350, name: "Tacky Boomer", icon: "📠", color: "#E0935A" },
  { min: 500, name: "Soft Touch", icon: "🧈", color: "#E0B15A" },
  { min: 600, name: "Lob Goblin", icon: "👺", color: "#A8B05A" },
  { min: 700, name: "Roll-Shot Rascal", icon: "🌀", color: "#8A9196" },
  { min: 800, name: "Pocket Sniper", icon: "🎯", color: "#C4CDD6" },
  { min: 900, name: "Spike Lee", icon: "🎬", color: "#F4F5F6" },
  { min: 1000, name: "Tomahawk", icon: "🪓", color: "#5CD37D" },
  { min: 1100, name: "Block-ness Monster", icon: "🦕", color: "#FFCF5C" },
  { min: 1400, name: "Scotty Beeks", icon: "🐐", color: "#CBFB4F" },
];
/** Rank-tier name/icon/color for a display rating. Placing players are always "Fresh Meat". */
export function tierOf(rating: number, provisional: boolean): Tier {
  if (provisional) return PROVISIONAL_TIER;
  let tier: Tier = TIERS[0];
  for (const t of TIERS) { if (rating >= t.min) tier = t; else break; }
  return { name: tier.name, icon: tier.icon, color: tier.color };
}

export type PlayerStat = LeaguePlayer & {
  initial: string;
  mu: number; // fitted skill (the rating is disp(mu) + held)
  games: number;
  wins: number;
  losses: number;
  pf: number; // points for (total scored)
  pa: number; // points against (total conceded)
  rating: number;
  share: number; // career share of points, 0–1
  winPct: number;
  provisional: boolean; // placing: has played, but fewer than PROV_N games → no rank
  rank?: number; // undefined while placing or resting, so the visible ladder has no gaps
  rankRange?: [number, number]; // 5–95% bootstrap range, when the server supplied one
  peak: number; // highest rating ever reached after a game
  bestStreak: number; // longest unbeaten run (consecutive wins)
  momentum: number; // rating change over the last 5 games
  diff: number; // points for minus points against
  form: ("W" | "L")[];
  last5: ("W" | "L")[];
  streak: { type: "W" | "L" | null; count: number };
  hist: { i: number; r: number; t: number }[]; // t = match epoch ms (0 = baseline)
  partners: Record<string, { games: number; wins: number }>;
  opps: Record<string, { games: number; wins: number; losses: number }>;
  matches: MatchEntry[];
  ripples: Ripple[]; // rating moved while they sat out, because others' games revalued theirs
  revalued: number; // Σ ripples
  held: number; // Σ MatchEntry.held: points topped up so every win paid at least winFloor
  lastPlayed: number; // epoch ms of the most recent game, 0 if never played
  firstPlayed: number; // epoch ms of the first game, 0 if never played
};

/** One player's view of one game, carrying everything needed to explain what it did to them. */
export type MatchEntry = {
  idx: number; // position in the chronologically sorted match list
  id: string; // LeagueMatch.id — may be a "local-<uuid>" optimistic match
  t: number; // LeagueMatch.order, epoch ms
  date: string;
  partner: string;
  opps: string[];
  won: boolean;
  gf: number;
  ga: number;
  delta: number;
  winProb: number; // this player's team's win probability, from skills *before* the game (0–1)
  // The ledger is the difference between two whole-history fits: with and without this
  // game. ratingBefore is the fit *without* it (so it already includes every revaluation up
  // to that point), ratingAfter the fit with it, and ratingBefore + delta === ratingAfter.
  ratingBefore: number;
  ratingAfter: number;
  expShare: number; // the share of points the league expected this player's team to take
  pointShare: number; // the share they actually took
  to: number; // points the game was played to
  gamesBefore: number; // how many games the league already had on this player
  daysOff: number | null; // days since their previous playing day; null on their first day
  earlierToday: number; // games of theirs already logged earlier the same day
  /** Points added so this win paid winFloor(gf, ga): the fit alone moved them `delta − held`.
   *  0 for a loss, and for any win the fit already paid at least that much. */
  held: number;
};

/** A rating change on a game the player wasn't in: someone else's result revalued theirs. */
export type Ripple = { idx: number; id: string; t: number; date: string; delta: number };

export type PairStat = { a: string; b: string; games: number; wins: number; exp: number; lastIdx: number };

/** Two players who have faced each other. No wins/exp — the relation is asymmetric,
 *  so only "how often" and "how recently" mean anything for both sides at once. */
export type FoeStat = { a: string; b: string; games: number; lastIdx: number };

/**
 * The fit after every prefix of the match list. `sigs[i]` identifies match i (id + score +
 * time), so a stale or edited ledger is detected and recomputed rather than trusted.
 * Deterministic function of the match list; the server builds and caches it, the client
 * only ever extends it by the odd optimistic match.
 */
export type Ledger = {
  sigs: string[];
  snaps: Snapshot[];
  /** Built with every player a founder (a later season). The sigs can't tell the two apart, so
   *  this is what stops a season reusing All time's snapshots when its games happen to match. */
  fresh?: boolean;
  /** Built under a model other than the app's (StandingsOpts.model), as its JSON. Only ever set
   *  by the backtest; such a ledger is never packed, cached or reused under another model. */
  model?: string;
};

/**
 * A ledger as it travels (to the phones) and rests (in rating_cache): the same numbers with
 * the player ids written once instead of once per snapshot, which roughly halves it. Lossless —
 * JSON keeps every double exactly — so an unpacked ledger reproduces the original bit for bit.
 * `skill[i]` lists the skills after game i, in `ids` order; a player is in every snapshot from
 * their first game on, so ordering `ids` by first appearance leaves each row a dense prefix.
 */
export type PackedLedger = { ids: string[]; sigs: string[]; late: number[]; skill: number[][]; fresh?: boolean };

export function packLedger(l: Ledger): PackedLedger {
  // The packed form has no room for a model stamp, so unpacked it would pass for the app's.
  if (l.model) throw new Error("ledger: built under another model, so it can't be packed");
  const ids: string[] = [];
  const at = new Map<string, number>();
  for (const snap of l.snaps) {
    for (const id of Object.keys(snap.skill).filter((x) => !at.has(x)).sort()) { at.set(id, ids.length); ids.push(id); }
  }
  const skill = l.snaps.map((snap) => {
    const row: number[] = [];
    for (const id of ids) { if (!(id in snap.skill)) break; row.push(snap.skill[id]); }
    if (row.length !== Object.keys(snap.skill).length) throw new Error("ledger: a player left the fit mid-history");
    return row;
  });
  return { ids, sigs: [...l.sigs], late: l.snaps.map((s) => s.late), skill, ...(l.fresh ? { fresh: true } : {}) };
}

export function unpackLedger(p: PackedLedger): Ledger {
  const snaps = p.skill.map((row, i): Snapshot => {
    const skill: Record<string, number> = {};
    row.forEach((v, k) => (skill[p.ids[k]] = v));
    return { skill, late: p.late[i] };
  });
  return { sigs: [...p.sigs], snaps, ...(p.fresh ? { fresh: true } : {}) };
}

/**
 * Does a stored ledger still agree with the model this code runs? Refits the last game it
 * covers, warm-started from its own final snapshot, and checks it lands in the same place. A
 * changed constant or a changed line of rating.ts moves every skill by far more than solver
 * tolerance; an unchanged model lands within it. One warm fit — cheap enough to run on every
 * ledger read back from the database before trusting it.
 */
export function ledgerStillFits(players: LeaguePlayer[], matchesIn: LeagueMatch[], ledger: Ledger, fresh = false, tol = 1e-6): boolean {
  const known: Record<string, true> = {};
  players.forEach((p) => (known[p.id] = true));
  const ms = [...matchesIn].filter((m) => validMatch(m, known)).sort((a, b) => a.order - b.order);
  let k = 0;
  while (k < ledger.sigs.length && k < ms.length && ledger.sigs[k] === matchSig(ms[k])) k++;
  // Nothing in common with these games (the first one was edited, say): nothing to check it
  // against, and it can't be built on anyway, so it's no evidence of a changed model.
  if (k === 0) return true;
  const games: FitGame[] = ms.slice(0, k).map((m) => ({ teamA: m.teamA, teamB: m.teamB, scoreA: m.scoreA, scoreB: m.scoreB, order: m.order }));
  const want = ledger.snaps[k - 1];
  const got = snapshotOf(fitSkills(games, want, MODEL, fresh));
  if (Math.abs(got.late - want.late) > tol) return false;
  const ids = Object.keys(want.skill);
  if (ids.length !== Object.keys(got.skill).length) return false;
  return ids.every((id) => id in got.skill && Math.abs(got.skill[id] - want.skill[id]) <= tol);
}

export type Standings = {
  st: Record<string, PlayerStat>;
  ranked: PlayerStat[]; // PROV_N+ games, by rating
  placing: PlayerStat[]; // 1..PROV_N-1 games, by rating — rated, no rank yet
  unranked: PlayerStat[]; // never played
  played: PlayerStat[]; // ranked + placing
  all: PlayerStat[];
  pair: Record<string, PairStat>;
  foe: Record<string, FoeStat>;
  count: number;
  lastMatchAt: number; // epoch ms of the league's most recent game, 0 if none
  final: boolean; // a finished season: nobody is resting, every placed player keeps a rank
  fresh: boolean; // a later season: everyone started it on START
  ledger: Ledger;
  late: number; // fitted skill a late joiner starts on (μ)
};

function calcStreak(f: ("W" | "L")[]): { type: "W" | "L" | null; count: number } {
  if (!f.length) return { type: null, count: 0 };
  const t = f[f.length - 1];
  let c = 0;
  for (let i = f.length - 1; i >= 0; i--) {
    if (f[i] === t) c++;
    else break;
  }
  return { type: t, count: c };
}

export type StandingsOpts = {
  /** A ledger from an earlier call (normally the server's). Prefixes that still match are reused. */
  ledger?: Ledger;
  /** Per-player bootstrap rank ranges, when the server computed them. */
  rankRanges?: Record<string, [number, number]>;
  /** A finished season's final table: resting is about who's around *now*, which no longer
   *  applies, so every placed player is numbered. */
  final?: boolean;
  /** A season after the first: everyone starts it on START, not just whoever played its first
   *  night (see foundersFor). The opening season keeps the league's own priors, so its table is
   *  exactly All time as it stood. */
  fresh?: boolean;
  /** Fit with a different model (the backtest's what-ifs, e.g. another GAP). The ledger it
   *  returns is stamped with that model, and a ledger is only reused under the model it was
   *  built with, in both directions. */
  model?: RatingModel;
};

export const matchSig = (m: LeagueMatch) => `${m.id}:${m.scoreA}:${m.scoreB}:${m.order}`;

/** A match the engine can use: four distinct known players. */
function validMatch(m: LeagueMatch, known: Record<string, unknown>): boolean {
  const ids = [...m.teamA, ...m.teamB];
  return ids.length === 4 && new Set(ids).size === 4 && ids.every((id) => id && id in known);
}

/** The signatures a ledger built from these games would carry, in play order. */
export function matchSigs(players: LeaguePlayer[], matchesIn: LeagueMatch[]): string[] {
  const known: Record<string, true> = {};
  players.forEach((p) => (known[p.id] = true));
  return matchesIn.filter((m) => validMatch(m, known)).sort((a, b) => a.order - b.order).map(matchSig);
}

export function computeStandings(
  players: LeaguePlayer[],
  matchesIn: LeagueMatch[],
  opts: StandingsOpts = {},
): Standings {
  const st: Record<string, PlayerStat> = {};
  players.forEach((p) => {
    st[p.id] = {
      ...p,
      initial: initial(p.name),
      mu: MODEL.MU0,
      games: 0,
      wins: 0,
      losses: 0,
      pf: 0,
      pa: 0,
      rating: disp(MODEL.MU0),
      share: 0,
      winPct: 0,
      provisional: false,
      peak: disp(MODEL.MU0),
      bestStreak: 0,
      momentum: 0,
      diff: 0,
      form: [],
      last5: [],
      streak: { type: null, count: 0 },
      hist: [],
      partners: {},
      opps: {},
      matches: [],
      ripples: [],
      revalued: 0,
      held: 0,
      lastPlayed: 0,
      firstPlayed: 0,
    };
  });
  const matches = [...matchesIn].filter((m) => validMatch(m, st)).sort((a, b) => a.order - b.order);
  const games: FitGame[] = matches.map((m) => ({ teamA: m.teamA, teamB: m.teamB, scoreA: m.scoreA, scoreB: m.scoreB, order: m.order }));
  const founders = foundersFor(games, !!opts.fresh);
  const model = opts.model ?? MODEL;

  // One fit per prefix. Anything the supplied ledger already has (and still matches) is
  // reused; the rest is fitted, each warm-started from the one before.
  const sigs: string[] = [];
  const snaps: Snapshot[] = [];
  let fit: Fit | undefined;
  // Only a ledger built under the same rule and model is reusable: same games, different maths.
  const stamp = model === MODEL ? undefined : JSON.stringify(model);
  const led = opts.ledger && !!opts.ledger.fresh === !!opts.fresh && opts.ledger.model === stamp ? opts.ledger : undefined;
  for (let i = 0; i < matches.length; i++) {
    const sig = matchSig(matches[i]);
    sigs.push(sig);
    if (led && led.sigs[i] === sig && led.snaps[i] && (i === 0 || snaps[i - 1] === led.snaps[i - 1])) {
      snaps.push(led.snaps[i]);
      fit = undefined;
    } else {
      fit = fitSkills(games.slice(0, i + 1), fit ?? snaps[i - 1], model, !!opts.fresh);
      snaps.push(snapshotOf(fit));
    }
  }
  const ledger: Ledger = { sigs, snaps, ...(opts.fresh ? { fresh: true } : {}), ...(stamp ? { model: stamp } : {}) };
  const empty: Snapshot = { skill: {}, late: MODEL.MU0 };
  const skillIn = (snap: Snapshot, id: string) => snap.skill[id] ?? priorOf(id, founders, snap.late, model);
  // A win always pays at least winFloor. The fit still drops a favourite who wins under par
  // (that's what keeps the odds and par honest), so the top-up lives on top of the fit instead.
  // Every rating is disp(skill) + held, which keeps the ledger telescoping exactly.
  const shown = (snap: Snapshot, id: string) => disp(skillIn(snap, id)) + st[id].held;

  const pair: Record<string, PairStat> = {};
  const foe: Record<string, FoeStat> = {};

  matches.forEach((mt, idx) => {
    const A = mt.teamA, B = mt.teamB, aWon = mt.scoreA > mt.scoreB;
    const pre = idx > 0 ? snaps[idx - 1] : empty, post = snaps[idx];
    const expA = expectedShare(skillIn(pre, A[0]), skillIn(pre, A[1]), skillIn(pre, B[0]), skillIn(pre, B[1]), model);
    const to = mt.to ?? 21;
    const preA = gameWinProb(expA, to);
    const total = mt.scoreA + mt.scoreB;
    const inGame = new Set([...A, ...B]);
    const apply = (team: string[], won: boolean, opp: string[], gf: number, ga: number, winProb: number, expShare: number) => {
      team.forEach((id) => {
        const p = st[id];
        const ratingBefore = shown(pre, id);
        const fitDelta = disp(post.skill[id]) - disp(skillIn(pre, id));
        const floor = won ? winFloor(gf, ga) : -Infinity;
        const held = fitDelta < floor ? floor - fitDelta : 0;
        p.held += held;
        const ratingAfter = shown(post, id);
        if (p.games === 0) { p.hist.push({ i: 0, r: ratingBefore, t: 0 }); p.firstPlayed = mt.order; }
        const gamesBefore = p.games;
        const today = dayKey(mt.order);
        let earlierToday = 0, daysOff: number | null = null;
        for (let k = p.matches.length - 1; k >= 0; k--) {
          const d = dayKey(p.matches[k].t);
          if (d === today) earlierToday++;
          else { daysOff = dayNum(today) - dayNum(d); break; }
        }
        p.games++;
        won ? p.wins++ : p.losses++;
        p.pf += gf;
        p.pa += ga;
        p.form.push(won ? "W" : "L");
        p.hist.push({ i: p.hist.length, r: ratingAfter, t: mt.order });
        const partner = team.find((x) => x !== id)!;
        if (!p.partners[partner]) p.partners[partner] = { games: 0, wins: 0 };
        p.partners[partner].games++;
        if (won) p.partners[partner].wins++;
        opp.forEach((o) => {
          if (!p.opps[o]) p.opps[o] = { games: 0, wins: 0, losses: 0 };
          p.opps[o].games++;
          won ? p.opps[o].wins++ : p.opps[o].losses++;
        });
        p.matches.push({
          idx, id: mt.id, t: mt.order, date: mt.date, partner, opps: [...opp], won, gf, ga,
          delta: ratingAfter - ratingBefore, winProb, ratingBefore, ratingAfter,
          expShare, pointShare: total ? gf / total : 0.5, to, gamesBefore, daysOff, earlierToday, held,
        });
        p.lastPlayed = mt.order;
      });
    };
    apply(A, aWon, B, mt.scoreA, mt.scoreB, preA, expA);
    apply(B, !aWon, A, mt.scoreB, mt.scoreA, 1 - preA, 1 - expA);
    // Everyone else who already has a rating: did this result revalue them?
    for (const id in pre.skill) {
      if (inGame.has(id) || !st[id]) continue;
      const d = disp(post.skill[id]) - disp(pre.skill[id]);
      if (d !== 0) { st[id].ripples.push({ idx, id: mt.id, t: mt.order, date: mt.date, delta: d }); st[id].revalued += d; }
    }
    const pk = (a: string, b: string) => [a, b].sort().join("|");
    const ka = pk(A[0], A[1]);
    if (!pair[ka]) pair[ka] = { a: A[0], b: A[1], games: 0, wins: 0, exp: 0, lastIdx: -1 };
    pair[ka].games++; if (aWon) pair[ka].wins++; pair[ka].exp += preA; pair[ka].lastIdx = idx;
    const kb = pk(B[0], B[1]);
    if (!pair[kb]) pair[kb] = { a: B[0], b: B[1], games: 0, wins: 0, exp: 0, lastIdx: -1 };
    pair[kb].games++; if (!aWon) pair[kb].wins++; pair[kb].exp += 1 - preA; pair[kb].lastIdx = idx;
    // The four cross-team pairings, so the scheduler can tell a fresh opponent from a stale one.
    for (const a of A) for (const b of B) {
      const kf = pk(a, b);
      if (!foe[kf]) foe[kf] = { a: a < b ? a : b, b: a < b ? b : a, games: 0, lastIdx: -1 };
      foe[kf].games++; foe[kf].lastIdx = idx;
    }
  });

  const final = snaps.length ? snaps[snaps.length - 1] : empty;
  const all = Object.values(st);
  all.forEach((p) => {
    p.mu = skillIn(final, p.id);
    p.rating = disp(p.mu) + p.held;
    if (!p.hist.length) p.hist.push({ i: 0, r: p.rating, t: 0 });
    p.share = p.pf + p.pa ? p.pf / (p.pf + p.pa) : 0;
    p.winPct = p.games ? Math.round((p.wins / p.games) * 100) : 0;
    p.provisional = p.games > 0 && p.games < PROV_N;
    p.last5 = p.form.slice(-5);
    p.streak = calcStreak(p.form);
    // The starting point isn't a peak: you have to have played to have reached it.
    p.peak = p.hist.slice(1).reduce((m, h) => (h.r > m ? h.r : m), p.rating);
    p.diff = p.pf - p.pa;
    let run = 0, best = 0;
    for (const r of p.form) { if (r === "W") { run++; best = Math.max(best, run); } else run = 0; }
    p.bestStreak = best;
    p.momentum = p.matches.slice(-5).reduce((sum, m) => sum + m.delta, 0);
    if (opts.rankRanges?.[p.id]) p.rankRange = opts.rankRanges[p.id];
  });
  // Ties broken on the unrounded skill, then name, so the order is stable and deterministic.
  const byRating = (a: PlayerStat, b: PlayerStat) => b.rating - a.rating || b.mu - a.mu || a.name.localeCompare(b.name);
  const lastMatchAt = matches.length ? matches[matches.length - 1].order : 0;
  const ranked = all.filter((p) => p.games >= PROV_N).sort(byRating);
  // Resting players keep their place in `ranked` (and their rating) but give up the number,
  // so the ladder reads 1, 2, 3… with no gap. Their next game makes them un-dormant and the
  // rank comes straight back.
  let n = 0;
  ranked.forEach((p) => { if (opts.final || !restingAt(p.lastPlayed, lastMatchAt)) p.rank = ++n; });
  const placing = all.filter((p) => p.provisional).sort(byRating);
  const unranked = all.filter((p) => p.games === 0);
  return { st, ranked, placing, unranked, played: [...ranked, ...placing], all, pair, foe, count: matches.length, lastMatchAt, final: !!opts.final, fresh: !!opts.fresh, ledger, late: final.late };
}

export const RANGE_SAMPLES = 200;
export const RANGE_SEED = 20260629;

/**
 * How sure the league is of each rank. Refits the model on bootstrap resamples of the
 * match list and reads off the 5th–95th percentile rank of every placed player. Seeded, so
 * two calls agree. Server-side work (a few hundred fits); the client just displays it.
 * `held` (each player's PlayerStat.held) is added on top of every resample, so the range is
 * read off the same number the ladder ranks by.
 */
export function rankRanges(
  players: LeaguePlayer[],
  matchesIn: LeagueMatch[],
  samples = RANGE_SAMPLES,
  seed = RANGE_SEED,
  held: Record<string, number> = {},
  final = false,
  fresh = false,
): Record<string, [number, number]> {
  const known: Record<string, true> = {};
  players.forEach((p) => (known[p.id] = true));
  const matches = [...matchesIn].filter((m) => validMatch(m, known)).sort((a, b) => a.order - b.order);
  if (!matches.length) return {};
  const games: FitGame[] = matches.map((m) => ({ teamA: m.teamA, teamB: m.teamB, scoreA: m.scoreA, scoreB: m.scoreB, order: m.order }));
  const count: Record<string, number> = {};
  for (const g of games) for (const id of [...g.teamA, ...g.teamB]) count[id] = (count[id] ?? 0) + 1;
  // Resting players have no rank, so they're left out of the order the ranges are read from —
  // except in a finished season, whose table numbers everyone who placed.
  const lastAt: Record<string, number> = {};
  for (const g of games) for (const id of [...g.teamA, ...g.teamB]) lastAt[id] = g.order;
  const leagueLast = games[games.length - 1].order;
  const placed = Object.keys(count).filter((id) => count[id] >= PROV_N && (final || !restingAt(lastAt[id], leagueLast))).sort();
  if (placed.length < 2) return {};
  const full = fitSkills(games, undefined, MODEL, fresh);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const ranks: Record<string, number[]> = {};
  placed.forEach((id) => (ranks[id] = []));
  for (let b = 0; b < samples; b++) {
    const G = Array.from({ length: games.length }, () => games[Math.floor(rnd() * games.length)]).sort((x, y) => x.order - y.order);
    const F = fitSkills(G, full, MODEL, fresh);
    const at = (id: string) => fitSkillOf(F, id) + (held[id] ?? 0) / SCALE;
    const order = [...placed].sort((x, y) => at(y) - at(x));
    order.forEach((id, k) => ranks[id].push(k + 1));
  }
  const out: Record<string, [number, number]> = {};
  for (const id of placed) {
    const r = ranks[id].sort((x, y) => x - y);
    out[id] = [r[Math.floor(0.05 * (r.length - 1))], r[Math.floor(0.95 * (r.length - 1))]];
  }
  return out;
}

// ---- explaining the rating ----
/** An upset is a win the ratings gave you less than this going in. */
export const UPSET_PROB = 0.4;

// The whole point of these helpers is that people can see WHY a number is what it is.
// All of them are arithmetic over what computeStandings already recorded — no second model.

export type RatingParts = {
  start: number; // what they were rated before their first game
  fromWins: number; // Σ delta over games they won
  fromLosses: number; // Σ delta over games they lost (usually negative)
  revalued: number; // Σ ripples: moved by other people's games
  rating: number; // start + fromWins + fromLosses + revalued, exactly
};

/** The rating as a sum a human can check: start + won + lost + revalued = rating, exactly. */
export function explainRating(p: PlayerStat): RatingParts {
  let fromWins = 0, fromLosses = 0;
  for (const m of p.matches) { if (m.won) fromWins += m.delta; else fromLosses += m.delta; }
  return { start: p.hist[0]?.r ?? disp(MODEL.MU0), fromWins, fromLosses, revalued: p.revalued, rating: p.rating };
}

export type RatingStory = {
  parts: RatingParts;
  climbFromWins: number; // total points gained across all winning games
  dropFromLosses: number; // total points lost across all losing games (negative)
  gamesToPlace: number; // games still needed before a rank appears (0 once placed)
};

export function ratingStory(p: PlayerStat): RatingStory {
  const parts = explainRating(p);
  return { parts, climbFromWins: parts.fromWins, dropFromLosses: parts.fromLosses, gamesToPlace: Math.max(0, PROV_N - p.games) };
}

/** The scoreline the league expected from a share of the points, e.g. 0.6 → "21–14" (or, in a
 *  game to 17, "17–11"). */
export function parScoreline(share: number, to = 21): string {
  const s = Math.max(0.05, Math.min(0.95, share));
  return s >= 0.5 ? `${to}–${Math.round((to * (1 - s)) / s)}` : `${Math.round((to * s) / (1 - s))}–${to}`;
}

/**
 * One line of "why did that game move me that much?", for the match sheet. The two levers
 * are what the league expected and what actually happened, so the sentence names both.
 */
export function matchVerdict(e: MatchEntry): string {
  return `Par ${parScoreline(e.expShare, e.to)}, actual ${e.gf}–${e.ga} → ${e.delta >= 0 ? "+" : ""}${e.delta}`;
}

// ---- why one game moved one player as far as it did ----
// The question is always asked in the same form: "we won the same game, why did they get
// more than me?" So the breakdown is per PLAYER, not per match, and it can take the
// partner's entry to answer the comparison directly rather than by implication.
//
// Nothing here changes a rating. Every number is arithmetic over what computeStandings
// already recorded on the entry, which is what stops the explanation drifting from the ladder.

export type DeltaFactor = {
  key: "odds" | "margin" | "pace";
  label: string;
  value: string;
  effect: string;
  /** −1…1: how far this factor pushed the swing below or above a normal game. Drives a bar. */
  lift: number;
};

export type DeltaBreakdown = {
  delta: number;
  expShare: number;
  pointShare: number;
  par: string; // the expected scoreline
  /** Won, but short enough of par that the fit would have dropped them: the win paid winFloor. */
  underPar: boolean;
  factors: DeltaFactor[];
  headline: string;
  /** Present only when a partner entry was supplied AND the two moved differently enough to explain. */
  compare: string | null;
};

const clamp1 = (n: number) => Math.max(-1, Math.min(1, n));
/** Games at which the league treats you as known: your steps are about half a newcomer's. */
const KNOWN_GAMES = 20;

export function explainDelta(
  e: MatchEntry,
  partner?: { entry: MatchEntry; name: string },
): DeltaBreakdown {
  const par = parScoreline(e.expShare, e.to);
  const total = e.gf + e.ga;
  const surplus = Math.round((e.pointShare - e.expShare) * total); // points above par
  const pct = Math.round(e.winProb * 100);

  const odds: DeltaFactor = {
    key: "odds",
    label: "Par going in",
    value: par,
    // Worded off the WIN chance (what the sheet shows), not the point share: a 91% favourite
    // is only expected to take ~60% of the points, which would read as a toss-up otherwise.
    effect:
      e.winProb >= 0.65 ? `Favourites at ${pct}% — the league expected a comfortable win, so only a comfortable win pays`
      : e.winProb <= 0.35 ? `Underdogs at ${pct}% — the bar was low, so even a close loss can pay`
      : `A toss-up at ${pct}% — par is a close game, and the result decides everything`,
    lift: clamp1((0.5 - e.winProb) / 0.5),
  };

  const margin: DeltaFactor = {
    key: "margin",
    label: "Result vs par",
    value: `${e.gf}–${e.ga}`,
    effect:
      surplus >= 3 ? `${surplus} points better than par — that's what moves you`
      : surplus <= -3 ? `${-surplus} points short of par${e.won ? " — a smaller win than the league expected, but a win always pays" : ""}`
      : "Bang on par — the league already had this right, so it barely moves you",
    lift: clamp1((e.pointShare - e.expShare) / 0.2),
  };

  const pace: DeltaFactor = {
    key: "pace",
    label: "How well the league knows you",
    value: `${e.gamesBefore} game${e.gamesBefore === 1 ? "" : "s"}`,
    effect:
      e.gamesBefore >= 2 * KNOWN_GAMES ? "Well known — each game nudges you rather than rewriting you"
      : e.gamesBefore >= KNOWN_GAMES ? "Mostly known — the league adjusts you in smaller steps than a newcomer"
      : "Still being worked out — every game rewrites a lot, so your swings are large",
    lift: clamp1((KNOWN_GAMES - e.gamesBefore) / KNOWN_GAMES),
  };

  const factors = [odds, margin, pace];
  // Under par means the fit alone would have dropped them, not just paid them under the floor.
  const underPar = e.won && e.delta - e.held < 0;
  const headline =
    underPar ? `Won, but under par — a win always pays, so +${e.delta}`
    : !e.won && e.delta > 0 ? "Lost, but above par — closer than the league expected"
    : Math.abs(margin.lift) < 0.15 ? `A normal game: ${e.delta >= 0 ? "+" : ""}${e.delta}`
    : margin.lift > 0 ? "Mostly the scoreline — you beat par" : "Mostly the scoreline — you fell short of par";

  let compare: string | null = null;
  if (partner) {
    // Partners share a par and a result, so the team's credit is the same for both. What
    // splits it is how sure the league is about each of them going in, NOT their ratings:
    // whoever it's less sure about moves further, win or lose. That's why a higher-rated
    // partner can take more off a win, and it's the one thing people keep asking about.
    const mine = Math.abs(e.delta), theirs = Math.abs(partner.entry.delta);
    const iFar = theirs >= 1 && mine / theirs >= 1.15;
    const theyFar = mine >= 1 && theirs / mine >= 1.15;
    if (iFar || theyFar) {
      const far = iFar ? e : partner.entry, near = iFar ? partner.entry : e;
      const ratio = (iFar ? mine / theirs : theirs / mine).toFixed(1);
      // Subject / object / possessive for each side, so "you" reads naturally.
      const who = (me: boolean) => (me ? { s: "you", S: "You", o: "you", p: "your" } : { s: partner.name, S: partner.name, o: partner.name, p: `${partner.name}'s` });
      const F = who(iFar), N = who(!iFar);
      const head = `${F.S} moved ~${ratio}× further than ${N.o} off the same result.`;
      const rule = "Partners share a result, and ratings don't decide the split: whoever the league is less sure about moves more, win or lose.";
      let why: string;
      if (far.gamesBefore < near.gamesBefore) {
        why = `It has ${far.gamesBefore} game${far.gamesBefore === 1 ? "" : "s"} on ${F.o} to ${near.gamesBefore} on ${N.o}.`;
      } else if (far.daysOff !== null && near.daysOff !== null && far.daysOff > near.daysOff) {
        why = `${F.S} had ${far.daysOff} days off to ${N.p} ${near.daysOff}, and form can change in that time.`;
      } else if (far.earlierToday < near.earlierToday) {
        why = `${N.S} had already played ${near.earlierToday} game${near.earlierToday === 1 ? "" : "s"} that day, which pinned ${N.o} down.`;
      } else {
        why = `Here it comes down to how the rest of ${F.p} games fit together.`;
      }
      compare = `${head} ${rule} ${why}`;
    }
  }

  return { delta: e.delta, expShare: e.expShare, pointShare: e.pointShare, par, underPar, factors, headline, compare };
}

// ---- activity: day buckets and the GitHub-style calendar grid ----
// Day helpers live in day.ts (shared with the rating model); re-exported here so callers
// keep importing them from the engine.
import { LEAGUE_TZ, DAY_MS, dayKey, dayNum, numKey, weekdayOf } from "./day";
export { LEAGUE_TZ, dayKey };

export type DayBucket = {
  day: string; // "YYYY-MM-DD"
  t: number; // epoch ms of that day's UTC midnight — for labels only, never for bucketing
  games: number;
  wins: number;
  losses: number;
  delta: number; // net rating change across the day
  matchIds: string[];
};

/** Every day this player actually played, oldest first. Days off are simply absent. */
export function dayBuckets(p: PlayerStat, tz: string = LEAGUE_TZ): DayBucket[] {
  const by = new Map<string, DayBucket>();
  for (const m of p.matches) {
    const day = dayKey(m.t, tz);
    let b = by.get(day);
    if (!b) {
      b = { day, t: dayNum(day) * DAY_MS, games: 0, wins: 0, losses: 0, delta: 0, matchIds: [] };
      by.set(day, b);
    }
    b.games++;
    m.won ? b.wins++ : b.losses++;
    b.delta += m.delta;
    b.matchIds.push(m.id);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export type GridCell = DayBucket & { inRange: boolean; weekday: number };
export type ActivityGrid = {
  columns: GridCell[][]; // weeks, each exactly 7 cells, Monday first
  monthLabels: { col: number; label: string }[];
  max: number; // busiest single day in the window, for scaling the colour ramp
  /** All-time, not windowed — the footer line reads better that way. */
  summary: { games: number; sessions: number; longestGapDays: number };
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A GitHub-contributions-shaped calendar. `now` is a required-in-practice input rather
 * than a call to Date.now() so the grid is deterministic in tests and stable across a
 * server render. The last column is the week containing `now`; days after it are
 * rendered as blanks (inRange: false) so the grid stays rectangular.
 */
export function activityGrid(
  p: PlayerStat,
  opts: { weeks?: number; now: number; tz?: string },
): ActivityGrid {
  const tz = opts.tz ?? LEAGUE_TZ;
  const weeks = opts.weeks ?? 26;
  const buckets = dayBuckets(p, tz);
  const byDay = new Map(buckets.map((b) => [b.day, b]));

  const endNum = dayNum(dayKey(opts.now, tz));
  const lastCell = endNum + (6 - weekdayOf(endNum)); // pad out to the Sunday of this week
  const firstCell = lastCell - weeks * 7 + 1;

  const columns: GridCell[][] = [];
  const monthLabels: { col: number; label: string }[] = [];
  let max = 0;
  let prevMonth = -1;
  for (let c = 0; c < weeks; c++) {
    const col: GridCell[] = [];
    for (let r = 0; r < 7; r++) {
      const n = firstCell + c * 7 + r;
      const day = numKey(n);
      const b = byDay.get(day);
      if (b && b.games > max) max = b.games;
      col.push({
        day, t: n * DAY_MS, weekday: r, inRange: n <= endNum,
        games: b?.games ?? 0, wins: b?.wins ?? 0, losses: b?.losses ?? 0,
        delta: b?.delta ?? 0, matchIds: b?.matchIds ?? [],
      });
    }
    const month = new Date(col[0].t).getUTCMonth();
    if (month !== prevMonth) { monthLabels.push({ col: c, label: MONTHS[month] }); prevMonth = month; }
    columns.push(col);
  }

  let longestGapDays = 0;
  for (let i = 1; i < buckets.length; i++) {
    const gap = dayNum(buckets[i].day) - dayNum(buckets[i - 1].day);
    if (gap > longestGapDays) longestGapDays = gap;
  }
  return { columns, monthLabels, max, summary: { games: p.games, sessions: buckets.length, longestGapDays } };
}

// ---- badges ----
export type Badge = { id: string; icon: string; label: string; desc: string };

/**
 * Everything a player has earned, best-first. Pure and order-stable, so the profile
 * can render it straight. Thresholds are deliberately generous — these are bragging
 * rights for a friendly league, not achievements to grind.
 */
export function computeBadges(
  p: PlayerStat,
  /** A season rather than All time: counts and peaks are this season's, so they say so — and
   *  a veteran placing again is "Placing", not a rookie. `final` for a finished season. */
  view: { period: string; final: boolean } | null = null,
): Badge[] {
  const b: Badge[] = [];
  if (p.games === 0) return b;
  const clutch = p.matches.filter((m) => m.won && m.gf - m.ga === 2).length; // won by exactly 2
  const blowouts = p.matches.filter((m) => m.won && m.gf - m.ga >= 15).length;
  const upsets = p.matches.filter((m) => m.won && m.winProb < UPSET_PROB).length;
  const atPeak = p.rating === p.peak && p.games >= PROV_N;
  if (p.rank === 1) b.push({ id: "top-dog", icon: "👑", label: "Top Dog", desc: "#1 on the ladder" });
  if (atPeak) b.push({ id: "peak", icon: "🚀", label: "At Your Peak", desc: view ? `Highest rating ${view.period}` : "Career-high rating right now" });
  if (p.streak.type === "W" && p.streak.count >= 3) b.push({ id: "on-fire", icon: "🔥", label: "On Fire", desc: `${p.streak.count}-game win streak` });
  if (p.bestStreak >= 4) b.push({ id: "unbeaten", icon: "🧱", label: "Unbeaten Run", desc: `${p.bestStreak} wins in a row` });
  if (p.momentum >= 60) b.push({ id: "surging", icon: "⚡", label: "Surging", desc: `+${p.momentum} over the last 5` });
  if (clutch >= 3) b.push({ id: "clutch", icon: "🧊", label: "Clutch", desc: `${clutch} games won by 2` });
  if (blowouts >= 3) b.push({ id: "dominator", icon: "💥", label: "Dominator", desc: `${blowouts} blowout wins` });
  if (upsets >= 3) b.push({ id: "spoiler", icon: "🃏", label: "Spoiler", desc: `${upsets} wins as the underdog` });
  if (p.winPct >= 60 && p.games >= 8) b.push({ id: "closer", icon: "🎯", label: "Closer", desc: `${p.winPct}% win rate` });
  const played = `${p.games} games ${view ? view.period : "played"}`;
  if (p.games >= 25) b.push({ id: "veteran", icon: "🏛️", label: "Veteran", desc: played });
  else if (p.games >= 15) b.push({ id: "iron-arm", icon: "💪", label: "Iron Arm", desc: played });
  const bestWin = [...p.matches].filter((m) => m.won).sort((x, y) => y.delta - x.delta)[0];
  if (bestWin && bestWin.delta >= 60) b.push({ id: "giant-slayer", icon: "⚔️", label: "Giant Slayer", desc: `+${bestWin.delta} upset` });
  if (p.provisional) {
    b.push(
      !view ? { id: "rookie", icon: "🌱", label: "Rookie", desc: `Getting placed · ${PROV_N - p.games} more` }
      : view.final ? { id: "rookie", icon: "🌱", label: "Didn't place", desc: `${p.games} of ${PROV_N} games` }
      : { id: "rookie", icon: "🌱", label: "Placing", desc: `${PROV_N - p.games} more games to a rank` },
    );
  }
  return b;
}

// ---- head to head ----
export type H2H = {
  vs: { games: number; wins: number; losses: number; pf: number; pa: number };
  with: { games: number; wins: number; losses: number };
  games: MatchEntry[]; // every game they've shared a court in, newest last
  vsGames: MatchEntry[]; // ...of those, the ones they were on opposite sides of
  withGames: MatchEntry[]; // ...and the ones they played together
  swing: number; // net rating this player has taken out of the rivalry
};

/** How one player has fared against AND alongside another. The two are separate records. */
export function headToHead(p: PlayerStat, otherId: string): H2H {
  const h: H2H = {
    vs: { games: 0, wins: 0, losses: 0, pf: 0, pa: 0 },
    with: { games: 0, wins: 0, losses: 0 },
    games: [],
    vsGames: [],
    withGames: [],
    swing: 0,
  };
  for (const m of p.matches) {
    const against = m.opps.includes(otherId);
    const alongside = m.partner === otherId;
    if (!against && !alongside) continue;
    h.games.push(m);
    if (against) {
      h.vsGames.push(m);
      h.vs.games++;
      m.won ? h.vs.wins++ : h.vs.losses++;
      h.vs.pf += m.gf;
      h.vs.pa += m.ga;
      h.swing += m.delta;
    } else {
      h.withGames.push(m);
      h.with.games++;
      m.won ? h.with.wins++ : h.with.losses++;
    }
  }
  return h;
}

/**
 * The two players' career numbers, side by side, with the leader on each line already
 * decided. Values are pre-formatted here rather than in the component so the "who's ahead"
 * call and the string it's attached to can never disagree — and so it can be tested.
 *
 * `lead` is null when the line is level, when it's not a merit (games played), or when
 * either player has nothing to compare yet.
 */
export type CompareRow = {
  key: string;
  label: string;
  a: string;
  b: string;
  lead: "a" | "b" | null;
};

export function comparePlayers(a: PlayerStat, b: PlayerStat): CompareRow[] {
  const both = a.games > 0 && b.games > 0;
  /** Higher wins, unless `lower` — and only where both sides have played. */
  const lead = (x: number, y: number, lower = false): "a" | "b" | null => {
    if (!both || x === y) return null;
    const aAhead = lower ? x < y : x > y;
    return aAhead ? "a" : "b";
  };
  const per = (n: number, g: number) => (g ? (n / g).toFixed(1) : "–");
  const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;
  const upsets = (p: PlayerStat) => p.matches.filter((m) => m.won && m.winProb < UPSET_PROB).length;

  return [
    { key: "rating", label: "Rating", a: `${a.rating}`, b: `${b.rating}`, lead: lead(a.rating, b.rating) },
    {
      key: "rank", label: "Ladder rank",
      a: a.rank ? `#${a.rank}` : "–", b: b.rank ? `#${b.rank}` : "–",
      lead: a.rank && b.rank ? lead(a.rank, b.rank, true) : null,
    },
    { key: "games", label: "Games played", a: `${a.games}`, b: `${b.games}`, lead: null },
    { key: "record", label: "Record", a: `${a.wins}–${a.losses}`, b: `${b.wins}–${b.losses}`, lead: lead(a.winPct, b.winPct) },
    { key: "winPct", label: "Win rate", a: `${a.winPct}%`, b: `${b.winPct}%`, lead: lead(a.winPct, b.winPct) },
    { key: "ppg", label: "Points per game", a: per(a.pf, a.games), b: per(b.pf, b.games), lead: lead(a.pf / (a.games || 1), b.pf / (b.games || 1)) },
    { key: "diff", label: "Point difference", a: signed(a.diff), b: signed(b.diff), lead: lead(a.diff, b.diff) },
    { key: "peak", label: "Peak rating", a: `${a.peak}`, b: `${b.peak}`, lead: lead(a.peak, b.peak) },
    { key: "streak", label: "Best unbeaten run", a: `${a.bestStreak}`, b: `${b.bestStreak}`, lead: lead(a.bestStreak, b.bestStreak) },
    { key: "momentum", label: "Last 5 games", a: signed(a.momentum), b: signed(b.momentum), lead: lead(a.momentum, b.momentum) },
    { key: "upsets", label: "Upsets won", a: `${upsets(a)}`, b: `${upsets(b)}`, lead: lead(upsets(a), upsets(b)) },
  ];
}

// ---- what if? ----
export type PreviewRow = {
  id: string;
  delta: number;
  ratingBefore: number;
  ratingAfter: number;
  rankBefore?: number;
  rankAfter?: number;
};
export type Preview = { rows: PreviewRow[]; winProb: number };

/**
 * What one hypothetical game would do, right now.
 *
 * This replays the whole league with the extra game appended rather than reimplementing
 * the update maths on a scratch copy. The league is tiny, and replaying makes the answer
 * identical to the real ladder *by construction* — not merely intended to be. Memoise it
 * against the chosen players and score; don't call it on every render.
 */
export function previewMatch(
  players: LeaguePlayer[],
  matches: LeagueMatch[],
  cs: Standings,
  hypo: { teamA: string[]; teamB: string[]; scoreA: number; scoreB: number; to?: number },
): Preview {
  const ids = [...hypo.teamA, ...hypo.teamB];
  if (ids.length !== 4 || new Set(ids).size !== 4 || ids.some((id) => !cs.st[id])) {
    return { rows: [], winProb: 0.5 };
  }
  // Replay with the ledger `cs` was built from: every prefix is reused, so this costs one
  // warm fit for the extra game and is identical to the real ladder by construction.
  const after = computeStandings(
    players,
    [...matches, { id: "__whatif__", date: "Now", order: (cs.lastMatchAt || 0) + 1, ...hypo }],
    { ledger: cs.ledger, final: cs.final, fresh: cs.fresh },
  );
  const rows: PreviewRow[] = ids.map((id) => ({
    id,
    delta: after.st[id].rating - cs.st[id].rating,
    ratingBefore: cs.st[id].rating,
    ratingAfter: after.st[id].rating,
    rankBefore: cs.st[id].rank,
    rankAfter: after.st[id].rank,
  }));
  const entry = after.st[hypo.teamA[0]].matches.find((m) => m.id === "__whatif__");
  return { rows, winProb: entry ? entry.winProb : 0.5 };
}

// ---- league records + leaderboards ----
// Every record names real people and, where it came from one game, carries that game's id
// so the UI can link straight to it. Rating-based records only count placed players — a
// one-game fluke topping the all-time board would make the whole thing a joke.

export type LeagueRecord = {
  key: string;
  icon: string;
  label: string;
  value: string; // pre-formatted, ready to render
  playerIds: string[];
  detail: string;
  matchId?: string;
};

export type LeagueTotals = { games: number; players: number; points: number };

export function leagueRecords(cs: Standings, matches: LeagueMatch[]): { records: LeagueRecord[]; totals: LeagueTotals } {
  const out: LeagueRecord[] = [];
  const settled = cs.ranked;
  const nameOf = (id: string) => cs.st[id]?.name ?? "?";
  const push = (r: LeagueRecord) => { if (r.playerIds.length) out.push(r); };
  const best = <T,>(xs: T[], score: (x: T) => number): T | null =>
    xs.reduce<T | null>((b, x) => (b === null || score(x) > score(b) ? x : b), null);

  const peak = best(settled, (p) => p.peak);
  if (peak) push({ key: "peak", icon: "🏔️", label: "Peak rating", value: `${peak.peak}`, playerIds: [peak.id], detail: peak.peak === peak.rating ? "and they're still there" : `now ${peak.rating}` });

  const streak = best(cs.played, (p) => p.bestStreak);
  if (streak && streak.bestStreak > 1) push({ key: "streak", icon: "🔥", label: "Longest win streak", value: `${streak.bestStreak}`, playerIds: [streak.id], detail: "wins in a row" });

  // Deliberately NOT here: most games, most points, best win rate, best point difference.
  // Those are per-player aggregates that the Leaders tab already ranks, and the league's
  // strongest player sweeps all of them — six identical cards is a boring hall of fame.
  // Records are for one-off feats and pairings; Leaders is for the counting stats.

  // Single-game records — scan one player's view of each game, since every entry
  // carries the pre-game odds and the margin.
  let upset: { e: MatchEntry; id: string } | null = null;
  let blowout: { e: MatchEntry; id: string } | null = null;
  let highest: { m: LeagueMatch; total: number } | null = null;
  for (const p of cs.all) {
    for (const e of p.matches) {
      if (e.won) {
        if (!upset || e.winProb < upset.e.winProb) upset = { e, id: p.id };
        if (!blowout || e.gf - e.ga > blowout.e.gf - blowout.e.ga) blowout = { e, id: p.id };
      }
    }
  }
  for (const m of matches) {
    const total = m.scoreA + m.scoreB;
    if (!highest || total > highest.total) highest = { m, total };
  }
  if (upset) {
    const winners = [upset.id, upset.e.partner];
    push({ key: "upset", icon: "🃏", label: "Biggest upset", value: `${Math.round(upset.e.winProb * 100)}%`, playerIds: winners, detail: `beat ${upset.e.opps.map(nameOf).join(" & ")} ${upset.e.gf}–${upset.e.ga}`, matchId: upset.e.id });
  }
  if (blowout) {
    const winners = [blowout.id, blowout.e.partner];
    push({ key: "blowout", icon: "💥", label: "Biggest blowout", value: `${blowout.e.gf}–${blowout.e.ga}`, playerIds: winners, detail: `over ${blowout.e.opps.map(nameOf).join(" & ")}`, matchId: blowout.e.id });
  }
  if (highest && highest.total > 0) {
    // Named after the winners, like the other single-game records, so the card reads
    // "X & Y — beat A & B" rather than listing all four with a bare "+2".
    const m = highest.m;
    const aWon = m.scoreA > m.scoreB;
    const winners = aWon ? m.teamA : m.teamB;
    const losers = aWon ? m.teamB : m.teamA;
    push({
      key: "highest", icon: "🎢", label: "Highest scoring game",
      value: `${Math.max(m.scoreA, m.scoreB)}–${Math.min(m.scoreA, m.scoreB)}`,
      playerIds: winners, detail: `${highest.total} points against ${losers.map(nameOf).join(" & ")}`,
      matchId: m.id,
    });
  }

  const duo = chemistryRanked(cs)[0];
  if (duo) push({ key: "duo", icon: "🤝", label: "Best duo", value: `+${duo.chem}`, playerIds: [duo.a, duo.b], detail: `${duo.wins}–${duo.games - duo.wins} together` });

  const rivalry = Object.values(cs.foe).reduce<FoeStat | null>((b, f) => (b === null || f.games > b.games ? f : b), null);
  if (rivalry && rivalry.games > 1) push({ key: "rivalry", icon: "⚔️", label: "Most-played rivalry", value: `${rivalry.games}`, playerIds: [rivalry.a, rivalry.b], detail: "games against each other" });

  // Busiest single day, league-wide — the "we played eleven games that night" record.
  const perDay = new Map<string, string[]>();
  for (const m of matches) {
    const d = dayKey(m.order);
    perDay.set(d, [...(perDay.get(d) ?? []), ...m.teamA, ...m.teamB]);
  }
  let busiest: { day: string; ids: string[] } | null = null;
  for (const [day, ids] of perDay) if (!busiest || ids.length > busiest.ids.length) busiest = { day, ids };
  if (busiest && busiest.ids.length > 4) {
    const games = busiest.ids.length / 4;
    push({
      key: "busiest", icon: "📅", label: "Busiest session", value: `${games}`,
      playerIds: [...new Set(busiest.ids)], detail: `games in one day · ${busiest.day}`,
    });
  }

  return {
    records: out,
    totals: {
      games: matches.length,
      players: cs.played.length,
      points: matches.reduce((n, m) => n + m.scoreA + m.scoreB, 0),
    },
  };
}

export type LeaderBoard = { id: string; label: string; unit: string; rows: { id: string; value: number; sub: string }[] };

/** Compact top-N boards for the raw counting stats people actually argue about. */
export function leaderboards(cs: Standings, top = 5): LeaderBoard[] {
  const ranked = cs.played;
  const board = (
    id: string, label: string, unit: string,
    pick: (p: PlayerStat) => number, sub: (p: PlayerStat) => string,
    pool: PlayerStat[] = ranked,
  ): LeaderBoard => ({
    id, label, unit,
    rows: [...pool].sort((a, b) => pick(b) - pick(a)).slice(0, top).map((p) => ({ id: p.id, value: pick(p), sub: sub(p) })),
  });
  return [
    board("wins", "Most wins", "", (p) => p.wins, (p) => `${p.games} games`),
    board("points", "Most points scored", "", (p) => p.pf, (p) => `${(p.pf / p.games).toFixed(1)}/game`),
    board("games", "Most games played", "", (p) => p.games, (p) => `${p.wins}–${p.losses}`),
    board("diff", "Best point difference", "", (p) => p.diff, (p) => `${p.pf} for · ${p.pa} against`),
    board("winpct", "Best win rate", "%", (p) => p.winPct, (p) => `${p.wins}–${p.losses}`, ranked.filter((p) => p.games >= 8)),
    board("upsets", "Most upsets won", "", (p) => p.matches.filter((m) => m.won && m.winProb < UPSET_PROB).length, (p) => `of ${p.games} games`),
  ].filter((b) => b.rows.length > 0);
}

// ---- dormancy ----
/** No game in this many days and you drop out of the main ladder into "Resting", and lose
 *  your rank number until you play again. */
export const DORMANT_DAYS = 28;

/**
 * Measured against the league's most recent game, NOT wall clock. That's deliberate:
 * it's deterministic in tests, identical on server and client (so no hydration mismatch),
 * and it means a league-wide quiet month doesn't silently empty the ladder for everyone.
 * A player with no games at all is never dormant — they're "unranked", a different thing.
 */
export function isDormant(p: PlayerStat, cs: Standings, days: number = DORMANT_DAYS): boolean {
  return !cs.final && restingAt(p.lastPlayed, cs.lastMatchAt, days);
}

function restingAt(lastPlayed: number, lastMatchAt: number, days: number = DORMANT_DAYS): boolean {
  if (!lastPlayed || !lastMatchAt) return false;
  return lastMatchAt - lastPlayed > days * DAY_MS;
}

/**
 * Who to offer first wherever people are picked (sign-in, who's at the court, the Log form):
 * anyone who has played lately, or hasn't played yet because they've only just been added.
 * Everyone resting — no game in DORMANT_DAYS of the league's own time — folds away behind
 * "show everyone", so a roster that keeps collecting one-off guests stays a short list. Pass All
 * time's standings: a new season shouldn't make a regular look like a stranger. Order is kept.
 */
export function splitRoster<T extends { id: string }>(players: T[], cs: Standings): { regulars: T[]; others: T[] } {
  const regulars: T[] = [], others: T[] = [];
  for (const p of players) {
    const st = cs.st[p.id];
    (st && st.games > 0 && isDormant(st, cs) ? others : regulars).push(p);
  }
  return { regulars, others };
}

/** Whole days between a player's last game and the league's, for the "28d" chip. */
export function daysSincePlayed(p: PlayerStat, cs: Standings): number {
  if (!p.lastPlayed || !cs.lastMatchAt) return 0;
  return Math.floor((cs.lastMatchAt - p.lastPlayed) / DAY_MS);
}

export function streakInfo(s: { type: "W" | "L" | null; count: number }) {
  if (!s || !s.count) return { has: false, label: "", color: "#6B7177" };
  return { has: true, label: (s.type === "W" ? "W" : "L") + s.count, color: s.type === "W" ? "#5CD37D" : "#FF6B6B" };
}

// ---- chemistry ----
export type ChemRow = { a: string; b: string; games: number; wins: number; chem: number };
/** Every pair that has played together, sorted best to worst chemistry. */
export function chemistryRanked(cs: Standings): ChemRow[] {
  return Object.values(cs.pair)
    .filter((p) => p.games >= 2)
    .map((p) => {
      const actual = p.wins / p.games, expected = p.exp / p.games;
      return { a: p.a, b: p.b, games: p.games, wins: p.wins, chem: Math.round((actual - expected) * 100) };
    })
    .sort((x, y) => y.chem - x.chem);
}

// ---- matchmaker ----
function kcombos<T>(a: T[], k: number): T[][] {
  const r: T[][] = [];
  const rec = (s: number, c: T[]) => {
    if (c.length === k) { r.push([...c]); return; }
    for (let i = s; i < a.length; i++) { c.push(a[i]); rec(i + 1, c); c.pop(); }
  };
  rec(0, []);
  return r;
}

/** A ranked game, warm-up to handshake. */
export const GAME_MINUTES = 25;
/** A game's length scales with what it's played to: a game to 17 is about 20 minutes. */
export function gameMinutes(to = 21): number {
  return Math.round((GAME_MINUTES * to) / 21);
}
/** A typical evening — 2 to 3 hours. */
export const SESSION_MINUTES = 150;
/** Games in a default session plan (SESSION_MINUTES / GAME_MINUTES). */
export const DEFAULT_ROUNDS = 6;
export const MAX_ROUNDS = 20;

export type SessionGame = {
  court: number; // 0-based court within the round
  A: string[];
  B: string[];
  diff: number; // rating gap between the two teams, in display points
  fresh: number; // how many of the two partnerships have NEVER partnered in league history (0–2)
  gap: number; // games since the more-recent partnership last played (Infinity if both are new)
  key: string; // canonical "a|b#c|d" matchup key
  locked: boolean; // already played — reproduced from `opts.played`, not chosen by the optimiser
};

export type SessionRound = {
  index: number; // 0-based round number, stable across a partial replan
  games: SessionGame[]; // one per court, 1..floor(N/4)
  out: string[]; // who sits this round
  locked: boolean;
};

export type SessionPlan = {
  rounds: SessionRound[];
  courts: number; // games running at once, floor(N/4)
  perPlayer: Record<string, { games: number; sits: number }>;
};

/** A game already played tonight, pinned into the plan at its round. */
export type PlayedGame = { A: string[]; B: string[]; round: number };

export type SessionOpts = { rounds?: number; played?: PlayedGame[] };

// Novelty weights. Partners matter ~3x as much as opponents; within each, how *recently*
// they played matters ~4x as much as how *often* (frequency is only an anti-clumping
// backstop, so a duo who've played nine times doesn't resurface the moment they age out).
const W_PART = 1.0, W_PFREQ = 0.25, W_OPP = 0.3, W_OFREQ = 0.08;
// Reusing a partnership already played tonight, per partnership. Deliberately larger than
// everything above combined (max 1.63), so an unused pairing always wins however overdue
// the reused one looks on paper — "mix it up as much as possible" within the session. Only
// once the pigeonhole forces a repeat does this tie, and league staleness decides again.
const W_SEEN = 4.0;
// Balance is the only term below the novelty grid, so it decides ties and nothing else.
const W_BALANCE = 0.12;
// Novelty is quantised onto this grid and multiplied by BIG, so it strictly outranks
// balance while differences finer than the grid stay genuine ties for balance to settle.
// Normalising every novelty term to [0,1] first is what keeps the ordering stable as the
// league grows — a term measured in raw "matches ago" would swamp these weights after a
// hundred games.
const NOV_QUANT = 0.05, BIG = 1e4;
// mu-sum gap counted as maximally lopsided: matches the UI's "Lopsided" line (60 display
// points, and `diff` scales the mu gap by 20).
const BAL_REF = 3;
const F_REF = 4; // partner/foe game count at which the frequency term saturates

const pkey = (a: string, b: string) => (a < b ? a + "|" + b : b + "|" + a);

/** Order-independent signature for a round's games — the canonical tie-break. */
const sigOf = (picked: { key: string }[]) => picked.map((g) => g.key).sort().join("#");

/** Partial court assignments kept per level once there are three or more courts. */
const BEAM_WIDTH = 24;
/** Ceiling on how many equally-fair benches to try per round. */
const SITTER_CAP = 16;
/** Most players a plan can hold — the player bitmask can't address more. Twice any real session. */
export const MAX_PLAYERS = 31;

/**
 * Bound how many benches we score. Every set `pickSitters` returns is equally fair, but at
 * ten-plus players there can be hundreds and each one costs a full court search. Sampling at
 * an even stride rather than taking the first N keeps it off the alphabetically-first players,
 * who would otherwise always be the ones benched in round one.
 */
function capSitters(sets: string[][]): string[][] {
  if (sets.length <= SITTER_CAP) return sets;
  const stride = Math.ceil(sets.length / SITTER_CAP);
  const out: string[][] = [];
  for (let i = 0; i < sets.length && out.length < SITTER_CAP; i += stride) out.push(sets[i]);
  return out;
}

type Game = {
  A: string[]; B: string[];
  pa: string; pb: string; // partnership keys
  foes: string[]; // the four cross-team pairings
  key: string;
  mask: number; // bitmask of the four players, by index into the sorted id list
  // League history, fixed for the whole call: matches since each pairing last played
  // (Infinity if never) and how many games it has behind it.
  pGaps: [number, number];
  pGames: [number, number];
  fGaps: number[];
  fGames: number[];
  muGap: number;
  diff: number;
};

/**
 * Choose who sits this round. Rotation is a HARD rule, not a weighted preference: sitters
 * always come from those who have sat least, and never from anyone who sat last round.
 *
 * That guarantees `max(sat) − min(sat) <= 1` after every round — if the least-sat tier is
 * big enough the sitters all come from it; if it isn't, the whole tier is forced out and
 * the shortfall comes from the tier above, whose untouched members keep the lower count.
 * Since `games = rounds − sat`, an even spread of games falls out for free, and it holds
 * at every point in the session, so stopping early is still fair.
 *
 * Every set it returns is equally fair, so the caller is free to pick between them on
 * novelty — which is how "who plays" gets decided without rotation ever being overruled.
 */
function pickSitters(
  free: string[],
  need: number,
  sat: Record<string, number>,
  sitStreak: Record<string, number>,
): string[][] {
  if (need <= 0) return [[]];
  if (free.length <= need) return [[...free].sort()];
  const order = [...free].sort(
    (a, b) => sat[a] - sat[b] || sitStreak[a] - sitStreak[b] || (a < b ? -1 : 1),
  );
  const threshold = sat[order[need - 1]];
  const forced = free.filter((p) => sat[p] < threshold); // strictly least-sat: must sit
  const rest = need - forced.length;
  let tie = free.filter((p) => sat[p] === threshold).sort();
  const notJustSat = tie.filter((p) => !sitStreak[p]);
  if (notJustSat.length >= rest) tie = notJustSat; // no back-to-back benching
  if (tie.length < rest) return [order.slice(0, need).sort()]; // unreachable; never fail
  return kcombos(tie, rest).map((c) => [...forced, ...c].sort());
}

/**
 * Plan one night of 2v2 games for the people who are here.
 *
 * `floor(N/4)` games run at once, so eight players means two courts and nobody sits;
 * six means one court and two sit. The plan is exactly `opts.rounds` rounds long
 * (default `DEFAULT_ROUNDS`) rather than the full round-robin — a session is a couple
 * of hours, not 45 games.
 *
 * Priorities, strictly in this order:
 *   1. Rotation, as a hard constraint (see `pickSitters`): nobody sits twice running and
 *      everyone finishes the night within one game of everyone else.
 *   2. Mixing up the session: a partnership used earlier tonight loses to any unused one,
 *      so pairings only repeat when the pigeonhole forces it (`W_SEEN`).
 *   3. Among those, the pairings that haven't happened for a long time — measured across the
 *      whole LEAGUE, not just tonight, so duos who haven't partnered in months come up
 *      first. Opponents count too, at about a third the weight.
 *   4. Balanced teams, as the final tie-break.
 *
 * `opts.played` pins games that have already been played back into their rounds, so a
 * replan can rewrite the rest of the night — for a late arrival, say — while leaving
 * what's finished alone and keeping round numbers stable.
 *
 * Deterministic: the same inputs always give the same plan, whatever order `ids` arrives in.
 */
export function genSession(idsIn: string[], cs: Standings, opts: SessionOpts = {}): SessionPlan {
  const ids = [...new Set(idsIn)].sort();
  const N = ids.length;
  const courts = Math.floor(N / 4);
  const R = Math.min(MAX_ROUNDS, Math.floor(opts.rounds ?? DEFAULT_ROUNDS));
  const empty: SessionPlan = { rounds: [], courts: 0, perPlayer: {} };
  // N > MAX_PLAYERS would overflow the player bitmask (JS shifts count mod 32) and produce
  // nonsense rather than a plan, so refuse it outright.
  if (courts < 1 || R < 1 || N > MAX_PLAYERS) return empty;

  const bit: Record<string, number> = {};
  ids.forEach((id, i) => (bit[id] = 1 << i));
  const mu = (id: string) => cs.st[id]?.mu ?? cs.late;

  // ---- league-history novelty, normalised to [0,1] ----
  // Horizons scale with the roster so "a long time" means the same thing for five players
  // as for twelve. Saturating (rather than linear) means 40-vs-50 matches ago correctly
  // reads as no difference, while 2-vs-12 reads strongly.
  const nPairs = (N * (N - 1)) / 2;
  const H_PART = Math.max(4, nPairs);
  const H_OPP = Math.max(3, Math.round(nPairs / 2));
  /** Matches since this pair last partnered; Infinity if they never have. */
  const partGap = (key: string) => {
    const p = cs.pair[key];
    return p && p.games ? cs.count - 1 - p.lastIdx : Infinity;
  };
  const foeGap = (key: string) => {
    const f = cs.foe[key];
    return f && f.games ? cs.count - 1 - f.lastIdx : Infinity;
  };
  const staleness = (gap: number, horizon: number) =>
    gap === Infinity ? 0 : 1 - Math.min(1, gap / horizon);
  const freq = (games: number | undefined) => (games ? Math.min(1, games / F_REF) : 0);

  const gameOf = (A: string[], B: string[], court: number, locked: boolean): Game & SessionGame => {
    const pa = pkey(A[0], A[1]), pb = pkey(B[0], B[1]);
    const foes = [pkey(A[0], B[0]), pkey(A[0], B[1]), pkey(A[1], B[0]), pkey(A[1], B[1])];
    const pGaps: [number, number] = [partGap(pa), partGap(pb)];
    const muGap = Math.abs(mu(A[0]) + mu(A[1]) - mu(B[0]) - mu(B[1]));
    return {
      court, A: [...A], B: [...B], pa, pb, foes,
      key: pa < pb ? pa + "#" + pb : pb + "#" + pa,
      mask: (bit[A[0]] | 0) | (bit[A[1]] | 0) | (bit[B[0]] | 0) | (bit[B[1]] | 0),
      pGaps,
      pGames: [cs.pair[pa]?.games ?? 0, cs.pair[pb]?.games ?? 0],
      fGaps: foes.map(foeGap),
      fGames: foes.map((k) => cs.foe[k]?.games ?? 0),
      muGap,
      diff: Math.round(muGap * 20),
      // Filled in when the game is committed, against the state as it stood then.
      fresh: (pGaps[0] === Infinity ? 1 : 0) + (pGaps[1] === Infinity ? 1 : 0),
      gap: Math.min(pGaps[0], pGaps[1]),
      locked,
    };
  };

  // Every distinct 2v2 among the present players, with its league history resolved once.
  // 3·C(N,4) entries: 45 at N=6, 210 at N=8, 1485 at N=12. The round loop then only has to
  // layer tonight's state on top, so none of the map lookups happen in the hot path.
  const games: (Game & SessionGame)[] = [];
  const byMask = new Map<number, (Game & SessionGame)[]>();
  for (const f of kcombos(ids, 4)) {
    for (const [A, B] of [
      [[f[0], f[1]], [f[2], f[3]]],
      [[f[0], f[2]], [f[1], f[3]]],
      [[f[0], f[3]], [f[1], f[2]]],
    ] as [string[], string[]][]) {
      const g = gameOf(A, B, 0, false);
      games.push(g);
      const bucket = byMask.get(g.mask);
      if (bucket) bucket.push(g); else byMask.set(g.mask, [g]);
    }
  }
  const FULL = (1 << N) - 1;

  // ---- bookkeeping, advanced only when a round is committed ----
  const sat: Record<string, number> = {}, plays: Record<string, number> = {};
  const sitStreak: Record<string, number> = {};
  ids.forEach((id) => { sat[id] = 0; plays[id] = 0; sitStreak[id] = 0; });
  const sPartLast = new Map<string, number>(), sFoeLast = new Map<string, number>();
  const sPartN = new Map<string, number>(), sFoeN = new Map<string, number>();

  // A pairing used earlier tonight is, in every sense that matters, one that just played —
  // tonight's games are league history, they simply aren't logged yet. So session repeats
  // fold straight into the staleness measure instead of sitting in a weaker tier below it,
  // which is what stops the same matchup being picked round after round when it happens to
  // be the freshest on paper. `courts` games go by per round, so that's the conversion.
  const effGap = (leagueGap: number, key: string, last: Map<string, number>, i: number) => {
    const used = last.get(key);
    return used === undefined ? leagueGap : Math.min(leagueGap, (i - used) * courts);
  };
  const effFresh = (g: Game, i: number) => {
    const a = effGap(g.pGaps[0], g.pa, sPartLast, i), b = effGap(g.pGaps[1], g.pb, sPartLast, i);
    return { fresh: (a === Infinity ? 1 : 0) + (b === Infinity ? 1 : 0), gap: Math.min(a, b) };
  };

  /** What a game costs this round: overdue-ness first, then team balance to break ties. */
  const cost = (g: Game, i: number) => {
    let stale = 0, often = 0, seen = 0;
    for (let k = 0; k < 2; k++) {
      const key = k ? g.pb : g.pa;
      stale += staleness(effGap(g.pGaps[k], key, sPartLast, i), H_PART);
      often += freq(g.pGames[k] + (sPartN.get(key) ?? 0));
      if (sPartLast.has(key)) seen++;
    }
    let fStale = 0, fOften = 0;
    for (let k = 0; k < 4; k++) {
      fStale += staleness(effGap(g.fGaps[k], g.foes[k], sFoeLast, i), H_OPP);
      fOften += freq(g.fGames[k] + (sFoeN.get(g.foes[k]) ?? 0));
    }
    const nov =
      W_SEEN * seen +
      (W_PART * stale + W_PFREQ * often) / 2 +
      (W_OPP * fStale + W_OFREQ * fOften) / 4;
    return Math.round(nov / NOV_QUANT) * BIG + W_BALANCE * Math.min(1, g.muGap / BAL_REF);
  };

  const lockedByRound = new Map<number, (Game & SessionGame)[]>();
  for (const p of opts.played ?? []) {
    if (p.A.length !== 2 || p.B.length !== 2) continue;
    const round = Math.max(0, Math.floor(p.round));
    const list = lockedByRound.get(round) ?? [];
    list.push(gameOf(p.A, p.B, list.length, true));
    lockedByRound.set(round, list);
  }

  const rounds: SessionRound[] = [];
  const commit = (index: number, picked: (Game & SessionGame)[], out: string[]) => {
    rounds.push({
      index,
      // fresh/gap read against the state *before* this round lands — two courts in the same
      // round are player-disjoint, so they can't affect each other's numbers.
      games: picked.map((g, court) => ({
        court, A: g.A, B: g.B, diff: g.diff, key: g.key, locked: g.locked, ...effFresh(g, index),
      })),
      out: [...out].sort(),
      locked: picked.length > 0 && picked.every((g) => g.locked),
    });
    for (const g of picked) {
      sPartLast.set(g.pa, index); sPartLast.set(g.pb, index);
      sPartN.set(g.pa, (sPartN.get(g.pa) ?? 0) + 1);
      sPartN.set(g.pb, (sPartN.get(g.pb) ?? 0) + 1);
      for (const k of g.foes) { sFoeLast.set(k, index); sFoeN.set(k, (sFoeN.get(k) ?? 0) + 1); }
      for (const id of [...g.A, ...g.B]) if (id in sat) { plays[id]++; sitStreak[id] = 0; }
    }
    for (const id of out) { sat[id]++; sitStreak[id]++; }
  };

  for (let i = 0; i < R; i++) {
    const pinned = lockedByRound.get(i) ?? [];
    const pinnedIds = new Set(pinned.flatMap((g) => [...g.A, ...g.B]));
    // A round that has already started keeps exactly the games it had. Topping it up when the
    // court count has since grown would credit players with games the caller isn't going to
    // store, leaving the stored plan and the rotation bookkeeping disagreeing.
    const open = pinned.length ? 0 : courts;
    if (open <= 0) {
      commit(i, pinned, ids.filter((id) => !pinnedIds.has(id)));
      continue;
    }
    const pinnedMask = pinned.reduce((m, g) => m | g.mask, 0);
    const free = ids.filter((id) => !pinnedIds.has(id));
    // Whoever the open courts can't seat sits. Normally this is exactly `sitCount`; it only
    // differs if a pinned game involves someone who has since left the roster.
    const sitters = capSitters(pickSitters(free, Math.max(0, free.length - 4 * open), sat, sitStreak));

    let best: { picked: (Game & SessionGame)[]; score: number; sig: string; out: string; sitting: string[] } | null = null;
    // Fill the courts one at a time, keeping the best partial assignments. Exact for one or
    // two courts (the whole space is explored); a wide deterministic beam at three or more,
    // which only happens from twelve players up.
    const width = courts <= 2 ? Infinity : BEAM_WIDTH;
    for (const out of sitters) {
      const outKey = out.join(",");
      const outMask = out.reduce((m, id) => m | (bit[id] | 0), 0);
      let beam = [{ picked: pinned, avail: FULL & ~pinnedMask & ~outMask, score: 0 }];
      for (let c = 0; c < open; c++) {
        const next: typeof beam = [];
        for (const state of beam) {
          // Court order is meaningless, so fix an order: every court must contain the
          // lowest-numbered player still waiting. That reaches each set of disjoint games
          // exactly once (nothing to deduplicate) AND — unlike ordering courts by table
          // index — leaves every partial assignment extendable, so pruning the beam can
          // never strand it in a dead end.
          const lo = state.avail & -state.avail;
          const rest: number[] = [];
          for (let b = 0; b < N; b++) {
            const m = 1 << b;
            if (m !== lo && state.avail & m) rest.push(m);
          }
          for (let x = 0; x < rest.length; x++)
            for (let y = x + 1; y < rest.length; y++)
              for (let z = y + 1; z < rest.length; z++) {
                const m4 = lo | rest[x] | rest[y] | rest[z];
                for (const g of byMask.get(m4) ?? []) {
                  next.push({
                    picked: [...state.picked, g],
                    avail: state.avail & ~g.mask,
                    score: state.score + cost(g, i),
                  });
                }
              }
        }
        if (!next.length) break;
        // Only worth ordering when we're about to throw candidates away. Sorting on score
        // alone is enough to be deterministic: quantised scores tie constantly, and a stable
        // sort leaves ties in generation order, which the canonical court ordering above
        // already fixes. Comparing matchup keys here instead would rebuild a string per
        // comparison for no added determinism.
        if (width !== Infinity) {
          next.sort((a, b) => a.score - b.score);
          beam = next.slice(0, width);
        } else {
          beam = next;
        }
      }
      for (const state of beam) {
        if (state.picked.length !== courts) continue;
        const sig = sigOf(state.picked);
        // Strictly better wins; exact ties break on the sitters then the matchup keys, so
        // the plan is stable whatever order the candidates were generated in.
        if (best && state.score >= best.score - 1e-9) {
          if (state.score >= best.score + 1e-9) continue;
          if (outKey > best.out) continue;
          if (outKey === best.out && sig >= best.sig) continue;
        }
        best = { picked: state.picked, score: state.score, sig, out: outKey, sitting: out };
      }
    }
    if (!best) break; // no legal round (shouldn't happen once courts >= 1)
    commit(i, best.picked, best.sitting);
  }

  const perPlayer: Record<string, { games: number; sits: number }> = {};
  ids.forEach((id) => (perPlayer[id] = { games: plays[id], sits: sat[id] }));
  return { rounds, courts, perPlayer };
}

/** One game as the plan-copy formatter needs it: two teams, a court, and (if it's been
 *  played) the score already in team-A-first order. */
export type PlanTextGame = { courtNo: number; teamA: string[]; teamB: string[]; result?: string | null };
export type PlanTextRound = { roundNo: number; games: PlanTextGame[]; out: string[] };

/**
 * Tonight's plan as plain text for pasting into WhatsApp. Deliberately plain — names,
 * "vs.", one game per line — so it reads the same in any chat. Court labels appear only
 * when more than one game runs at a time, and `*bold*` is WhatsApp's own markup.
 */
export function planText(rounds: PlanTextRound[], nameOf: (id: string) => string): string {
  const games = rounds.reduce((n, rd) => n + rd.games.length, 0);
  const multi = rounds.some((rd) => rd.games.length > 1);
  const head = multi
    ? `🏐 *TONIGHT* · ${rounds.length} round${rounds.length === 1 ? "" : "s"}, ${games} games`
    : `🏐 *TONIGHT* · ${games} game${games === 1 ? "" : "s"}`;
  const team = (ids: string[]) => ids.map(nameOf).join(" & ");
  const blocks = rounds.map((rd) => {
    const lines = [`*Round ${rd.roundNo + 1}*`];
    for (const g of rd.games) {
      const court = multi ? `Court ${g.courtNo + 1} — ` : "";
      lines.push(`${court}${team(g.teamA)} vs. ${team(g.teamB)}${g.result ? ` ✅ ${g.result}` : ""}`);
    }
    if (rd.out.length) lines.push(`🪑 ${rd.out.map(nameOf).join(", ")}`);
    return lines.join("\n");
  });
  return [head, ...blocks].join("\n\n");
}
