// Rating backtest: reproduces, in one command, the fairness review that chose the rating
// model, so "is it rigged?" arguments get settled with numbers rather than vibes.
//
//   npx tsx --env-file=.env.local scripts/rating-backtest.ts [--json <path>] [--influence] [--gap 0.2,0.4]
//
// READ-ONLY. With --json it reads { players, matches } from a file (the shape LeagueData
// carries); otherwise it loads confirmed matches from the DB exactly like getLeagueData.
// --influence is the slow extra: delete every match in turn and measure who moves.
// Section 6 refits the history at each candidate GAP (rating.ts) to test "the weaker partner
// gets targeted"; it adds a few seconds. --gap also prints the ladder as it would stand at those GAPs.
//
// Everything is computed from computeStandings(players, matches): its per-game
// winProb/expShare are already the forward (pre-game, prefix-fit) predictions, so the
// accuracy section needs no separate replay loop.

import { readFileSync } from "node:fs";
import {
  computeStandings, rankRanges, explainDelta, previewMatch, tierOf, disp, expectedShare, gameWinProb, parScoreline, PROV_N, WIN_MIN,
  type LeaguePlayer, type LeagueMatch, type Standings, type MatchEntry,
} from "../src/lib/league";
import { fitSkills, skillOf, foundersOf, priorOf, MODEL, SCALE, type Fit, type FitGame, type RatingModel } from "../src/lib/rating";
import { dayKey } from "../src/lib/day";
import { seasonsAt, targetAt } from "../src/lib/season";

// ---- args ----
const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf("--json");
const jsonPath = jsonIdx >= 0 ? argv[jsonIdx + 1] : undefined;
const influence = argv.includes("--influence");
if (jsonIdx >= 0 && !jsonPath) { console.error("--json needs a path"); process.exit(2); }
// --gap 0.2,0.4: also print the all-time ladder as it would stand at each of these GAPs.
const gapIdx = argv.indexOf("--gap");
const gapRaw = gapIdx >= 0 ? (argv[gapIdx + 1] ?? "").split(",") : [];
const gapList = gapRaw.map(Number);
if (gapIdx >= 0 && gapRaw.some((x, k) => x.trim() === "" || !Number.isFinite(gapList[k]) || gapList[k] < 0 || gapList[k] > 0.6)) {
  console.error("--gap needs comma-separated values from 0 to 0.6, the range section 6 sweeps");
  process.exit(2);
}

// ---- formatting ----
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x: number, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const section = (title: string) => console.log(`\n== ${title} ==`);
const ms = (t0: number) => `${(performance.now() - t0).toFixed(0)}ms`;

type Cell = string | number;
/** Fixed-width table: text columns left-aligned, numeric-looking columns right-aligned. */
function table(headers: string[], rows: Cell[][], align?: ("l" | "r")[]) {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const w = headers.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  const al = headers.map((_, c) => align?.[c] ?? (rows.every((r) => /^[-+−–\d.%#/ ]*$/.test(String(r[c] ?? ""))) ? "r" : "l"));
  const line = (r: string[]) => r.map((s, c) => (al[c] === "r" ? s.padStart(w[c]) : s.padEnd(w[c]))).join("  ").trimEnd();
  console.log(line(headers));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of all.slice(1)) console.log(line(r));
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function corr(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

// ---- data ----
type Loaded = { players: LeaguePlayer[]; matches: LeagueMatch[]; source: string };

async function load(): Promise<Loaded> {
  if (jsonPath) {
    const j = JSON.parse(readFileSync(jsonPath, "utf8")) as { players: LeaguePlayer[]; matches: LeagueMatch[] };
    return { players: j.players, matches: j.matches, source: jsonPath };
  }
  // Same four queries as getLeagueData, minus the session/availability/cookie ones.
  const { db } = await import("../src/db/index");
  const { players, matches, matchTeams, matchPlayers } = await import("../src/db/schema");
  const { eq, asc } = await import("drizzle-orm");
  const [roster, matchRows, teamRows, mpRows] = await Promise.all([
    db.select({ id: players.id, name: players.displayName, color: players.color, active: players.isActive }).from(players).orderBy(asc(players.displayName)),
    db.select().from(matches).where(eq(matches.status, "confirmed")).orderBy(asc(matches.playedAt)),
    db.select({ matchId: matchTeams.matchId, teamNo: matchTeams.teamNo, score: matchTeams.score })
      .from(matchTeams).innerJoin(matches, eq(matches.id, matchTeams.matchId)).where(eq(matches.status, "confirmed")),
    db.select({ matchId: matchPlayers.matchId, playerId: matchPlayers.playerId, teamNo: matchPlayers.teamNo })
      .from(matchPlayers).innerJoin(matches, eq(matches.id, matchPlayers.matchId)).where(eq(matches.status, "confirmed")),
  ]);
  const scoreByTeam = new Map<string, number>();
  for (const t of teamRows) scoreByTeam.set(`${t.matchId}:${t.teamNo}`, t.score);
  const playersByMatch = new Map<string, typeof mpRows>();
  for (const mp of mpRows) {
    const arr = playersByMatch.get(mp.matchId) ?? [];
    arr.push(mp);
    playersByMatch.set(mp.matchId, arr);
  }
  const leagueMatches: LeagueMatch[] = [];
  const seasons = seasonsAt(Date.now());
  for (const m of matchRows) {
    const mps = playersByMatch.get(m.id) ?? [];
    const teamA = mps.filter((p) => p.teamNo === 1).map((p) => p.playerId);
    const teamB = mps.filter((p) => p.teamNo === 2).map((p) => p.playerId);
    if (teamA.length !== 2 || teamB.length !== 2) continue;
    leagueMatches.push({
      id: m.id, date: dayKey(m.playedAt.getTime()), order: m.playedAt.getTime(), teamA, teamB,
      scoreA: scoreByTeam.get(`${m.id}:1`) ?? 0, scoreB: scoreByTeam.get(`${m.id}:2`) ?? 0, clientMatchId: m.clientMatchId,
      to: targetAt(seasons, m.playedAt.getTime()), // games to 17 from Season 2: their odds are a race to 17
    });
  }
  const client = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
  await client?.end?.();
  return { players: roster, matches: leagueMatches, source: `DB (${process.env.DATABASE_URL?.replace(/\/\/.*@/, "//…@") ?? "?"})` };
}

// ---- main ----
async function main() {
  const { players, matches: raw, source } = await load();
  const known = new Set(players.map((p) => p.id));
  // The same filter computeStandings applies, so match indices line up with its ledger.
  const matches = [...raw]
    .filter((m) => [...m.teamA, ...m.teamB].length === 4 && new Set([...m.teamA, ...m.teamB]).size === 4 && [...m.teamA, ...m.teamB].every((id) => known.has(id)))
    .sort((a, b) => a.order - b.order);
  const name = (id: string) => players.find((p) => p.id === id)?.name ?? id.slice(0, 6);
  const NW = Math.max(4, ...players.map((p) => p.name.length));
  const describe = (m: LeagueMatch) =>
    `${name(m.teamA[0])} & ${name(m.teamA[1])} ${m.scoreA}–${m.scoreB} ${name(m.teamB[0])} & ${name(m.teamB[1])} (${dayKey(m.order)})`;

  console.log("Spike rating backtest");
  console.log(`Source: ${source} — ${players.length} players, ${matches.length} valid matches, ${raw.length - matches.length} skipped`);
  console.log("\"Fair\" here means two things: the odds quoted for a game were predicted BEFORE it, from only the");
  console.log("games logged so far (out-of-sample); and the final rating is one fit to ALL games at once, so");
  console.log("the order things were logged in, and how often you play, cannot bias it (order-free).");

  // Section 7 (timing) numbers are gathered as we go, printed at the end.
  let t0 = performance.now();
  const cs: Standings = computeStandings(players, matches);
  const tCold = performance.now() - t0;
  t0 = performance.now();
  computeStandings(players, matches, { ledger: cs.ledger });
  const tWarm = performance.now() - t0;
  t0 = performance.now();
  const ranges = rankRanges(players, matches, undefined, undefined, Object.fromEntries(cs.all.map((p) => [p.id, p.held])));
  const tRanges = performance.now() - t0;

  const entryOf = (m: LeagueMatch, id: string): MatchEntry | undefined => cs.st[id]?.matches.find((e) => e.id === m.id);

  // ---- 1. Accuracy ----
  section("1. Accuracy (forward-chained: every prediction made before its game, from games ≥ #25)");
  {
    const WARMUP = 24;
    let ll = 0, brier = 0, n = 0;
    const buckets = [
      { lo: 0.5, hi: 0.7, n: 0, pred: 0, won: 0 },
      { lo: 0.7, hi: 0.85, n: 0, pred: 0, won: 0 },
      { lo: 0.85, hi: 1.0001, n: 0, pred: 0, won: 0 },
    ];
    for (let i = WARMUP; i < matches.length; i++) {
      const m = matches[i];
      const e = entryOf(m, m.teamA[0]);
      if (!e) continue;
      const p = Math.min(1 - 1e-9, Math.max(1e-9, e.winProb));
      const y = m.scoreA > m.scoreB ? 1 : 0;
      ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      brier += (p - y) ** 2;
      n++;
      const fav = Math.max(p, 1 - p), favWon = (p >= 0.5) === (y === 1);
      const b = buckets.find((b) => fav >= b.lo && fav < b.hi)!;
      b.n++; b.pred += fav; b.won += favWon ? 1 : 0;
    }
    if (n === 0) console.log(`Fewer than ${WARMUP + 1} matches — nothing to score.`);
    else {
      table(
        ["metric", "model", "coin flip"],
        [
          ["log-loss (lower is better)", f(ll / n, 3), f(Math.LN2, 3)],
          ["Brier (lower is better)", f(brier / n, 3), "0.250"],
          ["games scored", n, n],
        ],
      );
      console.log("\nCalibration — how often the favourite actually won, by how confident the model was:");
      table(
        ["favourite at", "n", "predicted", "actual"],
        buckets.map((b) => [`${pct(b.lo)}–${pct(Math.min(1, b.hi))}`, b.n, b.n ? pct(b.pred / b.n) : "–", b.n ? pct(b.won / b.n) : "–"]),
      );
    }
  }

  // ---- 2. Ladder ----
  section("2. Ladder (final fit; \"likely\" = 5–95% bootstrap rank range)");
  {
    table(
      ["#", "name", "games", "W–L", "pts %", "rating", "likely", "tier"],
      cs.ranked.map((p) => [
        p.rank ? `#${p.rank}` : "rest", p.name.padEnd(NW), p.games, `${p.wins}–${p.losses}`, pct(p.share),
        p.rating, ranges[p.id] ? `${ranges[p.id][0]}–${ranges[p.id][1]}` : "–", tierOf(p.rating, p.provisional).name,
      ]),
    );
    if (cs.placing.length) {
      console.log("\nPlacing (rated, not yet ranked):");
      table(
        ["name", "games", "W–L", "rating", "needs"],
        cs.placing.map((p) => [p.name.padEnd(NW), p.games, `${p.wins}–${p.losses}`, p.rating, `${PROV_N - p.games} more`]),
      );
    }
    if (cs.unranked.length) console.log(`\nNever played: ${cs.unranked.map((p) => p.name).join(", ")}`);
    console.log(`\nA newcomer starts on ${disp(cs.late)} (fitted from how earlier late joiners turned out; founders start on ${disp(25)}).`);
  }

  // ---- 3. Liveliness ----
  section("3. Liveliness (does the ladder still move once you're known?)");
  {
    const VET = 30;
    let vets = cs.played.filter((p) => p.games >= VET);
    let label = `veterans (≥${VET} games)`;
    if (!vets.length) { vets = cs.ranked; label = `placed players (no one has ${VET} games yet)`; }
    const lastDeltas = vets.flatMap((p) => p.matches.slice(-20).map((e) => Math.abs(e.delta)));
    console.log(`${label}: ${vets.length} — median |Δ| over their last 20 games: ${f(median(lastDeltas), 1)} rating points`);
    table(
      ["name", "games", "median |Δ| last 20", "rating"],
      vets.map((p) => [p.name.padEnd(NW), p.games, f(median(p.matches.slice(-20).map((e) => Math.abs(e.delta))), 1), p.rating]),
    );

    // Ladder churn per session: recompute placed ranks after each calendar day. Passing
    // the full ledger means every prefix fit is reused, so this is cheap.
    const ends: number[] = [];
    for (let i = 0; i < matches.length; i++) {
      if (i === matches.length - 1 || dayKey(matches[i].order) !== dayKey(matches[i + 1].order)) ends.push(i + 1);
    }
    const tS = performance.now();
    let prev: Map<string, number> | null = null;
    const changes: { day: string; moved: number; placed: number; newlyPlaced: number }[] = [];
    for (const k of ends) {
      const s = computeStandings(players, matches.slice(0, k), { ledger: cs.ledger });
      const cur = new Map(s.ranked.map((p) => [p.id, p.rank!]));
      if (prev) {
        let moved = 0, newly = 0;
        for (const [id, r] of cur) {
          if (!prev.has(id)) newly++;
          else if (prev.get(id) !== r) moved++;
        }
        changes.push({ day: dayKey(matches[k - 1].order), moved, placed: cur.size, newlyPlaced: newly });
      }
      prev = cur;
    }
    const tSessions = performance.now() - tS;
    console.log(`\nSessions: ${ends.length} calendar days; ${changes.length} with a previous session to compare against (${tSessions.toFixed(0)}ms for all prefixes with the ledger passed).`);
    if (changes.length) {
      console.log(`Placed players who changed ladder position per session: mean ${f(mean(changes.map((c) => c.moved)), 1)}, max ${Math.max(...changes.map((c) => c.moved))}.`);
      table(
        ["session", "placed", "moved", "newly placed"],
        changes.slice(-8).map((c) => [c.day, c.placed, c.moved, c.newlyPlaced]),
      );
      if (changes.length > 8) console.log(`(last 8 of ${changes.length} shown)`);
    }

    let wins = 0, winsToppedUp = 0, losses = 0, lossesGained = 0, flat = 0;
    for (const p of vets) for (const e of p.matches) {
      if (e.delta === 0) flat++;
      if (e.won) { wins++; if (e.held > 0) winsToppedUp++; }
      else { losses++; if (e.delta > 0) lossesGained++; }
    }
    console.log(`\nAmong ${label}: ${winsToppedUp}/${wins} wins topped up to the win floor (+${WIN_MIN} and up) (${pct(wins ? winsToppedUp / wins : NaN, 1)}), ${lossesGained}/${losses} losses gained points (${pct(losses ? lossesGained / losses : NaN, 1)}), ${flat} games moved them 0.`);
    const held = vets.map((p) => [p.name, p.held] as const).filter(([, h]) => h > 0).sort((a, b) => b[1] - a[1]);
    console.log(`Win top-ups kept on the ladder (rating minus fit): ${held.map(([n, h]) => `${n} +${h}`).join(", ") || "none"}.`);
    console.log("(The fit still drops a win under par; the ladder pays it winFloor instead. Odds and par use the fit.)");
  }

  // ---- 4. Fairness audit ----
  section("4. Fairness audit (fair skill = final fitted μ; fair odds = the win chance those skills give each game)");
  {
    const mu = (id: string) => cs.st[id].mu;
    type Acc = { games: number; lop: number; under: number; fav: number; wins: number; sumFair: number; partner: number; opp: number };
    const acc: Record<string, Acc> = {};
    const get = (id: string) => (acc[id] ??= { games: 0, lop: 0, under: 0, fav: 0, wins: 0, sumFair: 0, partner: 0, opp: 0 });
    for (const m of matches) {
      const expA = expectedShare(mu(m.teamA[0]), mu(m.teamA[1]), mu(m.teamB[0]), mu(m.teamB[1]));
      const pA = gameWinProb(expA, m.to ?? 21);
      const side = (team: string[], opp: string[], p: number, won: boolean) => {
        for (const id of team) {
          const a = get(id);
          a.games++;
          if (p < 0.25) { a.lop++; a.under++; } else if (p > 0.75) { a.lop++; a.fav++; }
          if (won) a.wins++;
          a.sumFair += p;
          a.partner += disp(mu(team.find((x) => x !== id)!));
          a.opp += (disp(mu(opp[0])) + disp(mu(opp[1]))) / 2;
        }
      };
      side(m.teamA, m.teamB, pA, m.scoreA > m.scoreB);
      side(m.teamB, m.teamA, 1 - pA, m.scoreB > m.scoreA);
    }
    table(
      ["name", "games", "lopsided", "as dog", "as fav", "wins", "Σ fair", "luck", "avg partner", "avg opp", "rating"],
      cs.played.map((p) => {
        const a = get(p.id);
        return [
          p.name.padEnd(NW), a.games, pct(a.lop / a.games), pct(a.under / a.games), pct(a.fav / a.games),
          a.wins, f(a.sumFair, 1), signed(Number((a.wins - a.sumFair).toFixed(1))), Math.round(a.partner / a.games), Math.round(a.opp / a.games), p.rating,
        ];
      }),
    );
    console.log("lopsided = games where fair odds fell outside 25–75%, split by which side of it you were on.");
    console.log("luck = actual wins − Σ fair win prob: positive means you've won more than your skill says you should have.");
    console.log("avg partner / avg opp = mean rating of who you played with and against, at today's skills.");

    // A rating is the fit plus its win top-ups (rating = disp(μ) + held). The fit part is 0 off
    // a cold refit by construction; the only way it isn't is if the warm-started ledger chain
    // settled somewhere a cold fit doesn't, so check that on its own. The top-up is the one
    // deliberate volume bias (more wins, more top-ups), so it's reported separately.
    const games: FitGame[] = matches.map((m) => ({ teamA: m.teamA, teamB: m.teamB, scoreA: m.scoreA, scoreB: m.scoreB, order: m.order }));
    const cold = fitSkills(games);
    const xs: number[] = [], ys: number[] = [];
    let maxDiff = 0;
    for (const p of cs.played) {
      const fair = disp(skillOf(cold, p.id));
      maxDiff = Math.max(maxDiff, Math.abs(p.rating - p.held - fair));
      xs.push(p.games); ys.push(p.held);
    }
    const c = corr(xs, ys);
    console.log(`\nmax |fit − fair| = ${maxDiff} pts (should be 0: 'fair' is a cold refit of the same games, so anything else means the ledger and the fit disagree)`);
    console.log(`corr(games played, win top-ups) = ${Number.isFinite(c) ? f(c, 3) : ys.every((y) => y === 0) ? "0 (no top-ups)" : "n/a (no spread in games played or top-ups)"} — the ladder's one deliberate volume bias: "a win always pays" (top-ups by player in section 3).`);
  }

  // ---- 5. Margin table ----
  section("5. Margin table (what each scoreline would have paid, with the game itself removed)");
  {
    const LOSER = [19, 16, 13, 9, 5]; // for a game to 21; scaled to what each game was played to
    for (const target of matches.slice(-3).reverse()) {
      const to = target.to ?? 21;
      const losers = LOSER.map((l) => Math.round((l * to) / 21));
      const idx = matches.indexOf(target);
      const without = matches.filter((m) => m.id !== target.id);
      const csW = computeStandings(players, without, { ledger: cs.ledger });
      const e = entryOf(target, target.teamA[0]);
      const par = e ? explainDelta(e).par : "?";
      const muW = (id: string) => csW.st[id].mu;
      const expA = expectedShare(muW(target.teamA[0]), muW(target.teamA[1]), muW(target.teamB[0]), muW(target.teamB[1]));
      const favA = expA >= 0.5;
      const fav = favA ? target.teamA : target.teamB;
      const dog = favA ? target.teamB : target.teamA;
      const favP = gameWinProb(favA ? expA : 1 - expA, to);
      console.log(`\nGame #${idx + 1}: ${describe(target)} — par ${par}, favourites ${fav.map(name).join(" & ")} at ${pct(favP)}`);
      const cols = [...fav.map((id) => `${name(id)} (fav)`), ...dog.map((id) => `${name(id)} (dog)`)];
      const ids = [...fav, ...dog];
      const rows: Cell[][] = [];
      const row = (label: string, scoreFav: number, scoreDog: number) => {
        const hypo = favA
          ? { teamA: target.teamA, teamB: target.teamB, scoreA: scoreFav, scoreB: scoreDog, to }
          : { teamA: target.teamA, teamB: target.teamB, scoreA: scoreDog, scoreB: scoreFav, to };
        const pv = previewMatch(players, without, csW, hypo);
        rows.push([label, ...ids.map((id) => signed(pv.rows.find((r) => r.id === id)?.delta ?? 0))]);
      };
      for (const L of losers) row(`favourites win ${to}–${L}`, to, L);
      for (const L of losers) row(`underdogs win ${to}–${L}`, L, to);
      const actual = ids.map((id) => signed(entryOf(target, id)?.delta ?? 0));
      rows.push([`actual ${favA ? `${target.scoreA}–${target.scoreB}` : `${target.scoreB}–${target.scoreA}`} (fav–dog)`, ...actual]);
      table(["scoreline", ...cols], rows);
    }
  }

  // ---- 6. Team shape ----
  // "A strong player and a weak one aren't the same as two in the middle: you serve at the weak
  // one." The model scores a pair as the SUM of its two skills, which says those are the same
  // team. Pure weakest-link (2 × the weaker) and strongest-carries were tested when the model
  // was chosen and predicted worse; this checks the in-between, GAP (see rating.ts).
  section("6. Team shape (is a pair worth the sum of its players, or does the weaker one get targeted?)");
  const tShape = performance.now();
  {
    // Every prediction is scored from game #25 on, like section 1, and nothing is called on fewer
    // than 30 of them: with one or two scored games the noise estimate is 0 and anything "wins".
    const WARMUP = 24, MIN_SCORED = 30;
    const games: FitGame[] = matches.map((m) => ({ teamA: m.teamA, teamB: m.teamB, scoreA: m.scoreA, scoreB: m.scoreB, order: m.order }));
    const founders = foundersOf(games);
    const dispGap = (mu: number) => Math.round(mu * SCALE);
    // A fit from scratch, run on until it settles: with a GAP the first go can stop at the cap.
    const fresh = (gs: FitGame[], m: RatingModel) => {
      let fit = fitSkills(gs, undefined, m);
      for (let k = 0; !fit.converged && k < 10; k++) fit = fitSkills(gs, fit, m);
      return fit;
    };
    if (matches.length < WARMUP + MIN_SCORED) console.log(`Fewer than ${WARMUP + MIN_SCORED} matches — too few to score this.`);
    else {
      // (a) Under today's model, does the more lopsided pair come in under par? Skills are the
      // ones going into each game (the ledger), so nothing here has seen the result it's judging.
      const pre = (i: number, id: string) => {
        const snap = i > 0 ? cs.ledger.snaps[i - 1] : undefined;
        return snap?.skill[id] ?? priorOf(id, founders, snap?.late ?? MODEL.MU0);
      };
      const xs: number[] = [], ys: number[] = [];
      for (let i = WARMUP; i < matches.length; i++) {
        const m = matches[i];
        const e = entryOf(m, m.teamA[0]);
        if (!e) continue;
        const gapA = Math.abs(pre(i, m.teamA[0]) - pre(i, m.teamA[1])), gapB = Math.abs(pre(i, m.teamB[0]) - pre(i, m.teamB[1]));
        const total = m.scoreA + m.scoreB;
        const aboveParA = (m.scoreA / total - e.expShare) * total; // points team A beat par by
        // Orient every game from the side of the more lopsided pair.
        xs.push(Math.abs(gapA - gapB));
        ys.push(gapA >= gapB ? aboveParA : -aboveParA);
      }
      const bins = [
        { lo: 0, hi: 150 }, { lo: 150, hi: 300 }, { lo: 300, hi: 450 }, { lo: 450, hi: Infinity },
      ].map((b) => {
        const sel = ys.filter((_, k) => dispGap(xs[k]) >= b.lo && dispGap(xs[k]) < b.hi);
        const mu = mean(sel), sd = Math.sqrt(sel.reduce((s, y) => s + (y - mu) ** 2, 0) / Math.max(1, sel.length - 1));
        return [`${b.lo}${b.hi === Infinity ? "+" : `–${b.hi}`}`, sel.length, sel.length ? signed(Number(mu.toFixed(1))) : "–", sel.length > 1 ? `±${f(2 * sd / Math.sqrt(sel.length), 1)}` : "–"];
      });
      // Slope through the origin: under the plain sum a lopsided pair is about on par on average
      // (it runs slightly positive, ~+0.06 per 100 in simulations, because ratings are shrunk).
      const sxx = xs.reduce((s, x) => s + x * x, 0), sxy = xs.reduce((s, x, k) => s + x * ys[k], 0);
      const beta = sxx ? sxy / sxx : NaN;
      const res = xs.reduce((s, x, k) => s + (ys[k] - beta * x) ** 2, 0) / Math.max(1, xs.length - 1);
      const se = sxx ? Math.sqrt(res / sxx) : NaN;
      const per100 = (b: number) => b * (100 / SCALE);
      console.log(`(a) Points the MORE lopsided pair scored above (+) or below (−) par, by how much bigger its gap was`);
      console.log(`    (gap = difference between the two partners' ratings going in; games ≥ #${WARMUP + 1}).`);
      table(["extra gap", "games", "vs par", "95% ±"], bins);
      console.log(`Slope: ${signed(Number(per100(beta).toFixed(2)))} points vs par per 100 rating points of extra gap (95% ±${f(2 * per100(se), 2)}).`);
      console.log(`Clearly negative would suggest the weaker partner gets targeted. Near 0 doesn't rule it out: at a few`);
      console.log(`hundred games even strong targeting usually lands inside the ±. (b) is the test.`);

      // (b) Refit the whole history at each GAP and score every game forward, exactly as section 1
      // does for today's model. Point log-loss uses every rally, so it's far more sensitive than wins.
      // Stops at 0.6, where the weaker partner counts for 80%. The gap term isn't concave, so a large
      // enough GAP gives more than one fit (AGENTS.md). Each row says how far a fit from scratch lands
      // from the chained one, and how many chained fits stopped short, so a row can't be trusted
      // blind. Checked after every game up to ~170 games; past that, every few (a spot check).
      const GAPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
      const every = Math.max(1, Math.ceil((games.length - WARMUP) / 150));
      type Run = { g: number; pt: number[]; win: number[]; brier: number[]; share: number[]; stuck: number; split: number; unsure: boolean };
      const runs: Run[] = GAPS.map((g) => {
        const m = { ...MODEL, GAP: g };
        const run: Run = { g, pt: [], win: [], brier: [], share: [], stuck: 0, split: 0, unsure: false };
        let fit: Fit | undefined;
        for (let i = 0; i < games.length; i++) {
          if (i >= WARMUP && fit) {
            const at = fit;
            const s = (id: string) => (id in at.last ? at.x[at.last[id]] : priorOf(id, founders, at.late, m));
            const mt = matches[i];
            const p = Math.min(1 - 1e-9, Math.max(1e-9, expectedShare(s(mt.teamA[0]), s(mt.teamA[1]), s(mt.teamB[0]), s(mt.teamB[1]), m)));
            const w = Math.min(1 - 1e-9, Math.max(1e-9, gameWinProb(p, mt.to ?? 21)));
            const y = mt.scoreA > mt.scoreB ? 1 : 0;
            run.pt.push(-(mt.scoreA * Math.log(p) + mt.scoreB * Math.log(1 - p)) / (mt.scoreA + mt.scoreB));
            run.win.push(-(y * Math.log(w) + (1 - y) * Math.log(1 - w)));
            run.brier.push((w - y) ** 2);
            run.share.push(p);
          }
          fit = fitSkills(games.slice(0, i + 1), fit, m);
          if (!fit.converged) run.stuck++;
          if (i >= WARMUP && ((i - WARMUP) % every === 0 || i === games.length - 1)) {
            const cold = fresh(games.slice(0, i + 1), m);
            if (!cold.converged) run.unsure = true;
            else for (const id of Object.keys(fit.last)) {
              run.split = Math.max(run.split, Math.round(SCALE * Math.abs(fit.x[fit.last[id]] - cold.x[cold.last[id]])));
            }
          }
        }
        return run;
      });
      const base = runs.find((r) => r.g === 0)!;
      // Paired against GAP 0, game by game, so the noise common to both mostly cancels.
      const vs = (a: number[], b: number[]) => {
        const d = a.map((x, k) => x - b[k]);
        const mu = mean(d), sd = Math.sqrt(d.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(1, d.length - 1));
        return { mu, se: sd / Math.sqrt(Math.max(1, d.length)) };
      };
      const milli = (x: number) => (x === 0 ? "0" : `${x > 0 ? "+" : "−"}${Math.abs(x * 1000).toFixed(2)}`);
      console.log(`\n(b) The model refitted at each GAP, every game predicted forward (n = ${base.pt.length}). Lower is better;`);
      console.log(`    Δ columns are ×1000 per game against today's model (GAP 0), with a 95% ± from the game-by-game pairing.`);
      console.log(`    'fresh fit' = the most a fit from scratch lands from the chained one (pts), checked ${every === 1 ? "after every game" : `every ${every} games, a spot check that can miss a disagreement in between`}.`);
      console.log(`    '?' = a fresh fit that never settled. 'stuck' = chained fits that stopped short (cap or failed step).`);
      table(
        ["GAP", "weaker counts", "point log-loss", "Δ ±", "win log-loss", "Δ ±", "Brier", "fresh fit", "stuck"],
        runs.map((r) => {
          const dp = vs(r.pt, base.pt), dw = vs(r.win, base.win);
          return [
            r.g === 0 ? "0 (today)" : f(r.g, 1), pct((1 + r.g) / 2),
            f(mean(r.pt), 4), r.g === 0 ? "–" : `${milli(dp.mu)} ±${(2 * dp.se * 1000).toFixed(2)}`,
            f(mean(r.win), 4), r.g === 0 ? "–" : `${milli(dw.mu)} ±${(2 * dw.se * 1000).toFixed(2)}`,
            f(mean(r.brier), 4), `${r.split ? `±${r.split}` : "same"}${r.unsure ? " ?" : ""}`, r.stuck,
          ];
        }),
        ["l", "r", "r", "r", "r", "r", "r", "r", "r"],
      );
      // The verdict is ONE test fixed in advance: does a little targeting (GAP 0.1) beat none? That's
      // the slope at 0, with no picking of whichever row happened to score best. The best row is
      // reported, not tested.
      const best = runs.reduce((a, b) => (mean(b.pt) < mean(a.pt) ? b : a));
      const small = vs(runs.find((r) => r.g === 0.1)!.pt, base.pt);
      const clear = small.mu + 2 * small.se < 0;
      const edge = best.g === GAPS[GAPS.length - 1] ? ` It's the edge of the range, so the best may lie beyond it.` : "";
      console.log(
        clear ? `GAP 0.1 beats the plain sum by more than its noise: the weaker partner looks targeted. Best on points: GAP ${best.g} (the weaker partner counts for ${pct((1 + best.g) / 2)}).${edge} Before turning it on, see AGENTS.md: a GAP this size can give more than one fit.`
        : best.g === 0 ? "Best on points: GAP 0, the plain sum. Nothing here says a lopsided pair is weaker than its total."
        : `Best on points: GAP ${best.g} (the weaker partner counts for ${pct((1 + best.g) / 2)}), but GAP 0.1 doesn't beat the plain sum by more than its noise, so not enough games to call it.${edge}`,
      );

      // (c) What it would have changed: the recent games with the most lopsided pairings.
      if (best.g !== 0) {
        const idxs = matches.map((_, i) => i).filter((i) => i >= WARMUP).slice(-60);
        const gapOf = (i: number) => Math.abs(Math.abs(pre(i, matches[i].teamA[0]) - pre(i, matches[i].teamA[1])) - Math.abs(pre(i, matches[i].teamB[0]) - pre(i, matches[i].teamB[1])));
        const top = [...idxs].sort((a, b) => gapOf(b) - gapOf(a)).slice(0, 6).sort((a, b) => b - a);
        console.log(`\n(c) Recent games with the most lopsided pairings: par and win chance, today vs GAP ${best.g}.`);
        table(
          ["game", "extra gap", "par today", "par at GAP", "win % today", "win % at GAP"],
          top.map((i) => {
            const k = i - WARMUP, mt = matches[i], to = mt.to ?? 21;
            return [describe(mt), dispGap(gapOf(i)), parScoreline(base.share[k], to), parScoreline(best.share[k], to), pct(gameWinProb(base.share[k], to)), pct(gameWinProb(best.share[k], to))];
          }),
          ["l", "r", "r", "r", "r", "r"],
        );
      }
    }

    // (d) --gap: the all-time ladder as it would read at each GAP, win top-ups and all.
    if (gapList.length) {
      const alt = gapList.map((g) => ({ g, s: computeStandings(players, matches, { model: { ...MODEL, GAP: g } }) }));
      const place = (p: { rank?: number; provisional: boolean }) => (p.rank ? `#${p.rank}` : p.provisional ? "placing" : "rest");
      console.log(`\n(d) The all-time ladder if GAP were on (--gap): rating, place, and the change from today.`);
      table(
        ["name", "games", "today", "", ...alt.flatMap((a) => [`GAP ${a.g}`, "", "Δ"])],
        cs.played.map((p) => [
          p.name.padEnd(NW), p.games, p.rating, place(p),
          ...alt.flatMap((a) => { const q = a.s.st[p.id]; return [q.rating, place(q), signed(q.rating - p.rating)]; }),
        ]),
        ["l", "r", "r", "l", ...alt.flatMap((): ("l" | "r")[] => ["r", "l", "r"])],
      );
      for (const a of alt) {
        const cold = fresh(games, { ...MODEL, GAP: a.g });
        const split = Math.max(0, ...cs.played.map((p) => Math.round(SCALE * Math.abs(a.s.st[p.id].mu - skillOf(cold, p.id)))));
        if (!cold.converged) console.log(`GAP ${a.g}: a fit from scratch never settled, so this column can't be checked against one.`);
        else if (split) console.log(`GAP ${a.g}: a fit from scratch lands up to ${split} pts away from this one. There's more than one answer, so read the column as one of them.`);
      }
    }
  }
  const tShapeMs = performance.now() - tShape;

  // ---- 7. Timing ----
  section("7. Timing");
  table(
    ["operation", "ms"],
    [
      [`computeStandings, cold (${matches.length} fits)`, tCold.toFixed(0)],
      ["computeStandings, ledger passed (0 fits)", tWarm.toFixed(1)],
      ["rankRanges (200 bootstrap refits)", tRanges.toFixed(0)],
      ["team shape (a forward refit per GAP)", tShapeMs.toFixed(0)],
    ],
  );

  // ---- 8. Influence ----
  if (influence) {
    section("8. Influence (delete each match in turn: max |rating change| over placed players)");
    const tI = performance.now();
    const out: { m: LeagueMatch; max: number; who: string }[] = [];
    for (const m of matches) {
      const s = computeStandings(players, matches.filter((x) => x.id !== m.id), { ledger: cs.ledger });
      let max = 0, who = "";
      for (const p of cs.ranked) {
        const d = Math.abs(s.st[p.id].rating - p.rating);
        if (d > max) { max = d; who = p.name; }
      }
      out.push({ m, max, who });
    }
    const worst = [...out].sort((a, b) => b.max - a.max).slice(0, 5);
    console.log(`${out.length} deletions in ${ms(tI)}. Mean max-move ${f(mean(out.map((o) => o.max)), 1)} pts, median ${f(median(out.map((o) => o.max)), 1)} pts.`);
    console.log("Most influential games:");
    table(
      ["#", "game", "max move", "who"],
      worst.map((o) => [`#${matches.indexOf(o.m) + 1}`, describe(o.m), o.max, o.who]),
    );
  } else {
    console.log("\n(--influence not passed: skipping the per-match deletion sweep)");
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
