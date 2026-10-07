// The rating model: a whole-history skill fit, pure and deterministic.
//
// Every player has a skill per day they played. A game is scored on its POINTS: team A's
// expected share of the points is Φ((skillA0 + skillA1 − skillB0 − skillB1) / S), and the
// actual scoreline is a binomial-ish observation of that (RHO points per effective
// observation, because rallies aren't independent). Skills drift day to day with a random
// walk (DRIFT per √day), founders start on a fixed prior, late joiners on a prior whose mean
// is itself fitted from how earlier late joiners turned out.
//
// The rating is the maximum-a-posteriori fit to ALL games at once — so who logged first,
// how often you play, and when you joined cannot bias it. It is refitted after every game;
// `computeStandings` in league.ts turns the sequence of fits into a per-game ledger.
//
// Solver: damped Newton, with each step solved matrix-free by preconditioned conjugate
// gradients. Nothing here is O(variables³), so a season with 600 player-days stays cheap.
// Chosen by replaying the real league (see scripts/rating-backtest.ts): forward log-loss
// 0.500 vs 0.541 for the incremental engine it replaced.

import { dayKey, dayNum } from "./day";

export type RatingModel = {
  S: number; // skill gap (in μ) per unit of the probit on POINT share
  RHO: number; // points per effective observation (overdispersion)
  S0: number; // prior sd on a player's first skill
  DRIFT: number; // random-walk sd per √day
  MU0: number; // founders' prior mean, and the display anchor
  LATE_SD: number; // hyperprior sd on the late-joiner mean (around MU0)
  /** How much a gap between partners costs their team: strength = a + b − GAP·|a − b|. 0 is the
   *  plain sum; at GAP g the weaker partner counts for (1+g)/2 of the team ("they'll serve at
   *  the weaker one"); 1 is pure weakest-link. Kept at 0: the real league predicts best on the
   *  sum, and the gap term isn't concave, so a large enough GAP gives more than one fit (AGENTS.md). */
  GAP: number;
};

export const MODEL: RatingModel = { S: 30, RHO: 6, S0: 5, DRIFT: 0.5, MU0: 25, LATE_SD: 5, GAP: 0 };

/** Display scale. START is what a founder shows before their first game; SCALE is display
 *  points per μ. Fixed constants, so nobody's number moves because the roster changed. */
export const START = 800;
export const SCALE = 80;
export function disp(mu: number): number { return Math.round(START + SCALE * (mu - MODEL.MU0)); }

// ---- maths helpers ----
function erf(x: number): number {
  if (x === 0) return 0; // the polynomial gives ~1e-9 here; a level game should be exactly 50%
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return s * y;
}
export function cdf(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function pdf(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
/** log Φ(z), with the asymptotic form far in the left tail where Φ underflows. */
function logcdf(z: number): number {
  return z < -5 ? -0.5 * z * z - Math.log(-z) - 0.5 * Math.log(2 * Math.PI) : Math.log(Math.max(1e-300, cdf(z)));
}
/** φ(z)/Φ(z) — the inverse Mills ratio. */
function lam(z: number): number { return z < -5 ? -z - 1 / z : pdf(z) / Math.max(1e-300, cdf(z)); }

/** |d|, rounded off within ~GAP_E of zero so the fit stays smooth when partners are level. */
const GAP_E = 0.5;
function soft(d: number): number { return Math.sqrt(d * d + GAP_E * GAP_E) - GAP_E; }
function softSlope(d: number): number { return d / Math.sqrt(d * d + GAP_E * GAP_E); }
function softCurve(d: number): number { const r = d * d + GAP_E * GAP_E; return (GAP_E * GAP_E) / (r * Math.sqrt(r)); }

/** A pair's combined strength, in μ: the sum, less GAP × the gap between them. */
export function teamSkill(a: number, b: number, m: RatingModel = MODEL): number {
  return m.GAP ? a + b - m.GAP * soft(a - b) : a + b;
}

/** Team A's expected share of the points, from the four skills going in. */
export function expectedShare(a0: number, a1: number, b0: number, b1: number, m: RatingModel = MODEL): number {
  // At GAP 0, the plain sum in its original order of operations, so no number moves by a bit.
  return cdf((m.GAP ? teamSkill(a0, a1, m) - teamSkill(b0, b1, m) : a0 + a1 - b0 - b1) / m.S);
}

/**
 * P(win a race to `to`, win by 2) from a per-point probability. Deuce at (to−1)–(to−1) is the
 * closed form p²/(p²+q²). This is what the app shows as the pre-game win chance. A shorter game
 * gives the weaker team more chance: the same edge per point counts for less over 17 than 21.
 */
export function gameWinProb(p: number, to = 21): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const q = 1 - p;
  const deuce = (p * p) / (p * p + q * q);
  // f[a][b] = P(A wins from a–b). Fill from high scores down.
  const f: number[][] = Array.from({ length: to + 1 }, () => new Array(to + 1).fill(0));
  for (let a = to; a >= 0; a--) {
    for (let b = to; b >= 0; b--) {
      if (a === to && b <= to - 2) f[a][b] = 1;
      else if (b === to && a <= to - 2) f[a][b] = 0;
      else if (a === to - 1 && b === to - 1) f[a][b] = deuce;
      else if (a === to || b === to) f[a][b] = a === to ? 1 : 0; // to–(to−1) can't be reached from below the deuce
      else f[a][b] = p * f[a + 1][b] + q * f[a][b + 1];
    }
  }
  return f[0][0];
}

// ---- the fit ----
export type FitGame = { teamA: string[]; teamB: string[]; scoreA: number; scoreB: number; order: number };

/** Latest skill of every player who has played, plus the fitted late-joiner start. */
export type Snapshot = { skill: Record<string, number>; late: number };

export type Fit = {
  x: Float64Array; // node values (skill per player-day), then the late-joiner mean
  keys: string[]; // node key `${id}@${day}` per index
  index: Map<string, number>;
  last: Record<string, number>; // player id → index of their latest node
  founders: Set<string>;
  late: number;
  model: RatingModel;
  iterations: number;
  /** The solver's steps shrank to nothing (or to float noise the line search can't improve on).
   *  False means it stopped short: the iteration cap, or a line search failing on a real step.
   *  With a GAP that happens crawling off a saddle. */
  converged: boolean;
};

/** Players who were in a game on the league's first day. Everyone else is a late joiner. */
export function foundersOf(games: FitGame[]): Set<string> {
  const out = new Set<string>();
  if (!games.length) return out;
  const first = dayKey(games[0].order);
  for (const g of games) {
    if (dayKey(g.order) !== first) break;
    for (const id of [...g.teamA, ...g.teamB]) out.add(id);
  }
  return out;
}

/** What a player who has never played would be rated, given the fit so far. */
export function priorOf(id: string, founders: Set<string>, late: number, m: RatingModel = MODEL): number {
  return founders.has(id) ? m.MU0 : late;
}

/** `fresh`: everyone counts as a founder, so every player starts on MU0 — a later season, where
 *  nobody is new to the league and "everyone starts on 800" should be literally true. */
export function foundersFor(games: FitGame[], fresh: boolean): Set<string> {
  return fresh ? new Set(games.flatMap((g) => [...g.teamA, ...g.teamB])) : foundersOf(games);
}

/**
 * Fit skills to `games` (must be sorted by `order`, and every game must have 4 distinct
 * players). `warm` seeds the solver from an earlier fit or snapshot; at GAP 0 the posterior is
 * concave, so the answer is the same either way, it just converges in fewer steps. With a GAP it
 * isn't, and the start can decide which of several fits comes back. `fresh`: see foundersFor.
 */
export function fitSkills(games: FitGame[], warm?: Fit | Snapshot, m: RatingModel = MODEL, fresh = false): Fit {
  const founders = foundersFor(games, fresh);
  // Nodes: one per (player, day), in play order per player.
  const daysOf: Record<string, { day: string; t: number }[]> = {};
  for (const g of games) {
    const day = dayKey(g.order);
    for (const id of [...g.teamA, ...g.teamB]) {
      const arr = (daysOf[id] ??= []);
      if (!arr.length || arr[arr.length - 1].day !== day) arr.push({ day, t: dayNum(day) });
    }
  }
  const keys: string[] = [];
  const index = new Map<string, number>();
  const last: Record<string, number> = {};
  const ids = Object.keys(daysOf).sort();
  for (const id of ids) {
    for (const d of daysOf[id]) {
      index.set(`${id}@${d.day}`, keys.length);
      keys.push(`${id}@${d.day}`);
    }
    last[id] = keys.length - 1;
  }
  const lateIdx = keys.length;
  const n = keys.length + 1;
  const x = new Float64Array(n);

  // Seed.
  const warmFit = warm && "x" in warm ? (warm as Fit) : null;
  const warmSnap = warm && !("x" in warm) ? (warm as Snapshot) : null;
  let lateSeed = m.MU0;
  if (warmFit) lateSeed = warmFit.late;
  else if (warmSnap) lateSeed = warmSnap.late;
  x[lateIdx] = lateSeed;
  for (const id of ids) {
    let seed = priorOf(id, founders, lateSeed, m);
    if (warmFit && id in warmFit.last) seed = warmFit.x[warmFit.last[id]];
    else if (warmSnap && id in warmSnap.skill) seed = warmSnap.skill[id];
    for (const d of daysOf[id]) {
      const k = index.get(`${id}@${d.day}`)!;
      x[k] = warmFit && warmFit.index.has(`${id}@${d.day}`) ? warmFit.x[warmFit.index.get(`${id}@${d.day}`)!] : seed;
    }
  }

  // Quadratic prior terms: −(x_i − x_j)²/(2v), or −(x_i − mean)²/(2v) when j < 0.
  const priors: { i: number; j: number; mean: number; inv: number }[] = [];
  for (const id of ids) {
    const days = daysOf[id];
    const first = index.get(`${id}@${days[0].day}`)!;
    if (founders.has(id)) priors.push({ i: first, j: -1, mean: m.MU0, inv: 1 / (m.S0 * m.S0) });
    else priors.push({ i: first, j: lateIdx, mean: 0, inv: 1 / (m.S0 * m.S0) });
    for (let k = 1; k < days.length; k++) {
      const gap = Math.max(1, days[k].t - days[k - 1].t);
      priors.push({ i: index.get(`${id}@${days[k].day}`)!, j: index.get(`${id}@${days[k - 1].day}`)!, mean: 0, inv: 1 / (m.DRIFT * m.DRIFT * gap) });
    }
  }
  priors.push({ i: lateIdx, j: -1, mean: m.MU0, inv: 1 / (m.LATE_SD * m.LATE_SD) });

  // Game terms: z = (teamSkill(A) − teamSkill(B))/S on the four nodes of that day. `c` is ∂z/∂x
  // on those nodes: ±1/S at GAP 0, otherwise refreshed with the curvature on every gradient call.
  // GAP 0 takes a fast path through the same arithmetic as before GAP existed: the app's fits
  // run on every logged game and in 200 bootstrap refits, and the general path costs ~35% more.
  const cS = 1 / m.S;
  const G = games.map((g) => {
    const day = dayKey(g.order);
    const idx = [...g.teamA.map((id) => index.get(`${id}@${day}`)!), ...g.teamB.map((id) => index.get(`${id}@${day}`)!)];
    return { idx, k: g.scoreA / m.RHO, l: g.scoreB / m.RHO, d2: 0, c: [cS, cS, -cS, -cS], wa: 0, wb: 0 };
  });
  const zOf = (g: { idx: number[] }, v: Float64Array) =>
    (m.GAP ? teamSkill(v[g.idx[0]], v[g.idx[1]], m) - teamSkill(v[g.idx[2]], v[g.idx[3]], m) : v[g.idx[0]] + v[g.idx[1]] - v[g.idx[2]] - v[g.idx[3]]) * cS;

  const objective = (v: Float64Array): number => {
    let f = 0;
    for (const p of priors) { const d = p.j < 0 ? v[p.i] - p.mean : v[p.i] - v[p.j]; f -= 0.5 * d * d * p.inv; }
    for (const g of G) { const z = zOf(g, v); f += g.k * logcdf(z) + g.l * logcdf(-z); }
    return f;
  };
  // Gradient of the log posterior, and per-game curvature (stored on G for the mat-vec).
  const gradient = (v: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (const p of priors) {
      const d = p.j < 0 ? v[p.i] - p.mean : v[p.i] - v[p.j];
      out[p.i] -= d * p.inv;
      if (p.j >= 0) out[p.j] += d * p.inv;
    }
    for (const g of G) {
      const z = zOf(g, v);
      const la = lam(z), lb = lam(-z);
      const dl = g.k * la - g.l * lb; // ∂/∂z
      g.d2 = g.k * la * (la + z) + g.l * lb * (lb - z); // −∂²/∂z² ≥ 0
      if (!m.GAP) {
        const t = dl * cS;
        out[g.idx[0]] += t; out[g.idx[1]] += t; out[g.idx[2]] -= t; out[g.idx[3]] -= t;
        continue;
      }
      const da = v[g.idx[0]] - v[g.idx[1]], db = v[g.idx[2]] - v[g.idx[3]];
      const sa = m.GAP * softSlope(da), sb = m.GAP * softSlope(db);
      g.c[0] = cS * (1 - sa); g.c[1] = cS * (1 + sa); g.c[2] = -cS * (1 - sb); g.c[3] = -cS * (1 + sb);
      for (let q = 0; q < 4; q++) out[g.idx[q]] += dl * g.c[q];
      // The bend in the gap term: it adds curvature to one pair and takes it from the other,
      // depending on which way the game pulls. Exact Newton keeps both halves; the safe step
      // keeps only the positive one, so A stays positive definite (see the loop below).
      g.wa = m.GAP && (exact || dl > 0) ? dl * cS * m.GAP * softCurve(da) : 0;
      g.wb = m.GAP && (exact || dl < 0) ? -dl * cS * m.GAP * softCurve(db) : 0;
    }
  };
  // A·v where A = −Hessian (positive definite at GAP 0: probit likelihood and Gaussian priors are
  // concave; with a GAP, see the bend above).
  const Av =(v: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (const p of priors) {
      const d = p.j < 0 ? v[p.i] : v[p.i] - v[p.j];
      out[p.i] += d * p.inv;
      if (p.j >= 0) out[p.j] -= d * p.inv;
    }
    if (!m.GAP) {
      for (const g of G) {
        const cv = (v[g.idx[0]] + v[g.idx[1]] - v[g.idx[2]] - v[g.idx[3]]) * (g.d2 * cS * cS);
        out[g.idx[0]] += cv; out[g.idx[1]] += cv; out[g.idx[2]] -= cv; out[g.idx[3]] -= cv;
      }
      return;
    }
    for (const g of G) {
      const [i0, i1, i2, i3] = g.idx;
      const cv = (g.c[0] * v[i0] + g.c[1] * v[i1] + g.c[2] * v[i2] + g.c[3] * v[i3]) * g.d2;
      for (let q = 0; q < 4; q++) out[g.idx[q]] += cv * g.c[q];
      if (g.wa) { const t = g.wa * (v[i0] - v[i1]); out[i0] += t; out[i1] -= t; }
      if (g.wb) { const t = g.wb * (v[i2] - v[i3]); out[i2] += t; out[i3] -= t; }
    }
  };
  const diagA = (out: Float64Array) => {
    out.fill(0);
    for (const p of priors) { out[p.i] += p.inv; if (p.j >= 0) out[p.j] += p.inv; }
    for (const g of G) {
      for (let q = 0; q < 4; q++) out[g.idx[q]] += g.d2 * g.c[q] * g.c[q];
      out[g.idx[0]] += g.wa; out[g.idx[1]] += g.wa; out[g.idx[2]] += g.wb; out[g.idx[3]] += g.wb;
    }
  };

  // Preconditioned CG for A s = b. False if it ran into a direction A doesn't curve along (A
  // isn't positive definite there), which only the exact gap curvature can cause.
  const grad = new Float64Array(n), step = new Float64Array(n), r = new Float64Array(n), zv = new Float64Array(n), pv = new Float64Array(n), ap = new Float64Array(n), dg = new Float64Array(n), trial = new Float64Array(n);
  const solve = (b: Float64Array): boolean => {
    step.fill(0);
    diagA(dg);
    for (let i = 0; i < n; i++) if (!(dg[i] > 0)) return false;
    r.set(b);
    for (let i = 0; i < n; i++) zv[i] = r[i] / dg[i];
    pv.set(zv);
    let rz = 0; for (let i = 0; i < n; i++) rz += r[i] * zv[i];
    const b2 = rz;
    for (let it = 0; it < 4 * n + 20 && rz > 1e-14 * b2; it++) {
      Av(pv, ap);
      let pAp = 0; for (let i = 0; i < n; i++) pAp += pv[i] * ap[i];
      if (pAp <= 0) return false;
      const alpha = rz / pAp;
      for (let i = 0; i < n; i++) { step[i] += alpha * pv[i]; r[i] -= alpha * ap[i]; }
      let rzNew = 0; for (let i = 0; i < n; i++) { zv[i] = r[i] / dg[i]; rzNew += r[i] * zv[i]; }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < n; i++) pv[i] = zv[i] + beta * pv[i];
    }
    return true;
  };

  let f = objective(x);
  let iterations = 0;
  // With a GAP: the always-positive-definite step until the fit is close, then exact Newton for
  // the last stretch (it converges in a few steps where the other crawls). The first time exact
  // fails in any way, back to the safe step for good.
  let exact = false, exactOk = m.GAP !== 0, converged = false;
  for (let it = 0; it < 60; it++) {
    iterations++;
    gradient(x, grad);
    if (!solve(grad) && exact) { exact = exactOk = false; gradient(x, grad); solve(grad); }
    let maxStep = 0; for (let i = 0; i < n; i++) maxStep = Math.max(maxStep, Math.abs(step[i]));
    if (maxStep < 1e-7) { converged = true; break; }
    // Backtracking line search: the step is an ascent direction, so this always terminates.
    let a = 1, accepted = false;
    for (let tries = 0; tries < 20; tries++) {
      for (let i = 0; i < n; i++) trial[i] = x[i] + a * step[i];
      const ft = objective(trial);
      if (ft >= f - 1e-12) { x.set(trial); f = ft; accepted = true; break; }
      a /= 2;
    }
    if (!accepted) {
      if (exact) { exact = exactOk = false; continue; }
      // Twenty halvings of a tiny step all failing is float noise at the peak, not a stall.
      converged = maxStep < 1e-4;
      break;
    }
    if (maxStep * a < 1e-7) { converged = true; break; }
    if (exactOk && maxStep * a < 0.05) exact = true;
  }

  return { x, keys, index, last, founders, late: x[lateIdx], model: m, iterations, converged };
}

export function snapshotOf(fit: Fit): Snapshot {
  const skill: Record<string, number> = {};
  for (const id of Object.keys(fit.last)) skill[id] = fit.x[fit.last[id]];
  return { skill, late: fit.late };
}

/** A player's current skill from a fit, or their prior if they have never played. */
export function skillOf(fit: Fit, id: string): number {
  return id in fit.last ? fit.x[fit.last[id]] : priorOf(id, fit.founders, fit.late, fit.model);
}
