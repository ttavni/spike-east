import { describe, it, expect } from "vitest";
import {
  computeStandings,
  chemistryRanked,
  genSession,
  planText,
  tierOf,
  TIERS,
  disp,
  START,
  MODEL,
  PROV_N,
  WIN_MIN,
  winFloor,
  computeBadges,
  leagueRecords,
  leaderboards,
  ratingStory,
  previewMatch,
  headToHead,
  comparePlayers,
  explainRating,
  explainDelta,
  matchVerdict,
  parScoreline,
  matchSig,
  rankRanges,
  gameWinProb,
  expectedShare,
  dayKey,
  dayBuckets,
  activityGrid,
  isDormant,
  daysSincePlayed,
  DORMANT_DAYS,
  DEFAULT_ROUNDS,
  packLedger,
  unpackLedger,
  ledgerStillFits,
  splitRoster,
  type Ledger,
  type LeaguePlayer,
  type LeagueMatch,
  type MatchEntry,
  type SessionOpts,
  type SessionPlan,
} from "./league";
import { fitSkills, snapshotOf, foundersOf, teamSkill, MODEL as RATING_MODEL, type FitGame } from "./rating";
import { seasonsFrom, seasonsAt, currentSeason, seasonAt, targetAt, inScope, scopeMatches, scopeKey, isFinal, isFresh, SEASON_STARTS, FIRST_SEASON_TO } from "./season";
import { validWinBy2 } from "./validation";
import { dayStart } from "./day";
import { buildRatings, fingerprint, RATING_KEY, type CachedScope } from "./ratingCache";

const players: LeaguePlayer[] = [
  { id: "a", name: "A", color: "#fff", active: true },
  { id: "b", name: "B", color: "#fff", active: true },
  { id: "c", name: "C", color: "#fff", active: true },
  { id: "d", name: "D", color: "#fff", active: true },
];

function match(id: string, t1: [string, string], t2: [string, string], s1: number, s2: number, order: number): LeagueMatch {
  return { id, date: "x", order, teamA: t1, teamB: t2, scoreA: s1, scoreB: s2 };
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

// A few sessions of a closed foursome: every player is in every game, so everyone ends on
// 12 games (placed) and nobody's rating can move on a game they sat out — there are no
// ripples here, which is what makes it the clean fixture for the strict provenance chain.
function history(): LeagueMatch[] {
  const out: LeagueMatch[] = [];
  const lineups: [[string, string], [string, string]][] = [
    [["a", "b"], ["c", "d"]],
    [["a", "c"], ["b", "d"]],
    [["a", "d"], ["b", "c"]],
  ];
  for (let i = 0; i < 12; i++) {
    const [t1, t2] = lineups[i % 3];
    const aWin = i % 3 !== 2;
    out.push(match(`h${i}`, t1, t2, aWin ? 21 : 14 + (i % 5), aWin ? 12 + (i % 6) : 21, (i + 1) * DAY));
  }
  return out;
}

// The bigger league: eight regulars over eight evenings (six games a night, midday UTC in
// January so London and UTC agree on the calendar day), with results driven by a fixed
// skill order so the fit has something real to find. a–f are founders (they play on day 1);
// g first appears on day 3 and h on day 5, so both start on the fitted late-joiner prior.
// i then plays three games on a later evening (placing) and z never plays (unranked).
// Every player who plays regularly ends well past PROV_N, and the deterministic scores
// mean some "wins under par" and "losses above par" occur naturally.
const T0 = Date.UTC(2026, 0, 5, 12);
const IDS8 = ["a", "b", "c", "d", "e", "f", "g", "h"];
const SKILL: Record<string, number> = { a: 7, b: 6, c: 5, d: 4, e: 3, f: 2, g: 1, h: 0 };
const bigPlayers: LeaguePlayer[] = [...IDS8, "i", "z"].map((id) => ({ id, name: id.toUpperCase(), color: "#fff", active: true }));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function bigHistory(n = 48): LeagueMatch[] {
  const out: LeagueMatch[] = [];
  for (let k = 0; out.length < n; k++) {
    const day = 1 + Math.floor(k / 6);
    const pool = IDS8.filter((id) => (id !== "g" || day >= 3) && (id !== "h" || day >= 5));
    const rot = pool.slice(k % pool.length).concat(pool.slice(0, k % pool.length));
    const pick = [rot[0], rot[1 + (k % 3)], rot[4], rot[5]];
    const split = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]][Math.floor(k / 3) % 3];
    const A: [string, string] = [pick[split[0][0]], pick[split[0][1]]];
    const B: [string, string] = [pick[split[1][0]], pick[split[1][1]]];
    const gap = SKILL[A[0]] + SKILL[A[1]] - SKILL[B[0]] - SKILL[B[1]];
    const aWins = gap > 0 || (gap === 0 && k % 2 === 0);
    const loser = clamp(19 - 2 * Math.abs(gap) + (k % 3) - 1, 3, 19);
    out.push(match(`g${k}`, A, B, aWins ? 21 : loser, aWins ? loser : 21, T0 + (day - 1) * DAY + (k % 6) * HOUR));
  }
  const lateDay = Math.floor((out[out.length - 1].order - T0) / DAY) + 2;
  out.push(match("i1", ["i", "a"], ["b", "c"], 21, 15, T0 + lateDay * DAY));
  out.push(match("i2", ["i", "d"], ["e", "f"], 18, 21, T0 + lateDay * DAY + HOUR));
  out.push(match("i3", ["i", "g"], ["h", "a"], 21, 19, T0 + lateDay * DAY + 2 * HOUR));
  return out;
}

const toGames = (ms: LeagueMatch[]): FitGame[] =>
  [...ms].sort((a, b) => a.order - b.order).map((m) => ({ teamA: m.teamA, teamB: m.teamB, scoreA: m.scoreA, scoreB: m.scoreB, order: m.order }));

/** The partner's view of the same game. */
const partnerEntry = (cs: ReturnType<typeof computeStandings>, e: MatchEntry) =>
  cs.st[e.partner].matches.find((x) => x.id === e.id)!;

describe("league engine", () => {
  it("tracks W/L, points for/against and puts the winner on top", () => {
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 10, 1),
      match("m2", ["a", "c"], ["b", "d"], 21, 15, 2),
    ]);
    const a = cs.st["a"];
    expect(a.wins).toBe(2);
    expect(a.losses).toBe(0);
    expect(a.pf).toBe(42);
    expect(a.pa).toBe(25);
    // Two games is placing, not placed: nobody has a rank yet, but the rated order still holds.
    expect(cs.ranked).toEqual([]);
    expect(cs.played[0].id).toBe("a"); // unbeaten -> top
    expect(cs.count).toBe(2);
  });

  it("records a rating history point per game with a timestamp", () => {
    const cs = computeStandings(players, [match("m1", ["a", "b"], ["c", "d"], 21, 5, 1000)]);
    const a = cs.st["a"];
    expect(a.hist.length).toBe(2); // baseline + 1 game
    expect(a.hist[1].t).toBe(1000);
  });

  it("chemistryRanked returns pairs sorted best to worst", () => {
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, 1),
      match("m2", ["a", "b"], ["c", "d"], 21, 8, 2),
    ]);
    const rows = chemistryRanked(cs);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].chem).toBeGreaterThanOrEqual(rows[i].chem);
  });
});

describe("per-match provenance", () => {
  it("carries the match id and epoch timestamp on every entry", () => {
    const cs = computeStandings(players, [match("m1", ["a", "b"], ["c", "d"], 21, 5, 1000)]);
    for (const id of ["a", "b", "c", "d"]) {
      expect(cs.st[id].matches[0].id).toBe("m1");
      expect(cs.st[id].matches[0].t).toBe(1000);
    }
  });

  it("reconciles ratingBefore + delta === ratingAfter for every player-match", () => {
    for (const cs of [computeStandings(players, history()), computeStandings(bigPlayers, bigHistory())]) {
      for (const p of cs.all) {
        for (const m of p.matches) expect(m.ratingBefore + m.delta).toBe(m.ratingAfter);
      }
    }
  });

  it("chains each game's ratingBefore onto the previous game's ratingAfter in a closed foursome", () => {
    const cs = computeStandings(players, history());
    for (const p of cs.all) {
      expect(p.matches.length).toBe(12);
      // Everyone is a founder, and nobody sits out, so nothing can move between games.
      expect(p.ripples).toEqual([]);
      expect(p.matches[0].ratingBefore).toBe(START);
      for (let i = 1; i < p.matches.length; i++) {
        expect(p.matches[i].ratingBefore).toBe(p.matches[i - 1].ratingAfter);
      }
      expect(p.matches[p.matches.length - 1].ratingAfter).toBe(p.rating);
    }
  });

  it("chains through the ripples when other people's games revalue you between yours", () => {
    // A whole-history fit can move a player's rating on a game they weren't in. Those moves
    // are recorded as ripples, and they are exactly the gap between one game's ratingAfter
    // and the next game's ratingBefore — so the chain still closes, it just has more links.
    const cs = computeStandings(bigPlayers, bigHistory());
    expect(cs.all.some((p) => p.ripples.length > 0)).toBe(true); // guard against vacuity
    for (const p of cs.all) {
      for (let i = 1; i < p.matches.length; i++) {
        const prev = p.matches[i - 1], cur = p.matches[i];
        const between = p.ripples.filter((r) => r.idx > prev.idx && r.idx < cur.idx).reduce((n, r) => n + r.delta, 0);
        expect(prev.ratingAfter + between).toBe(cur.ratingBefore);
      }
      // ...and the ripples after the last game carry it to the current rating.
      if (p.matches.length) {
        const last = p.matches[p.matches.length - 1];
        const tail = p.ripples.filter((r) => r.idx > last.idx).reduce((n, r) => n + r.delta, 0);
        expect(last.ratingAfter + tail).toBe(p.rating);
      }
      expect(p.ripples.reduce((n, r) => n + r.delta, 0)).toBe(p.revalued);
      for (const r of p.ripples) expect(p.matches.some((m) => m.idx === r.idx)).toBe(false); // never a game they played
    }
  });

  it("records par and the actual share of points on every entry", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    for (const p of cs.all) {
      p.matches.forEach((m, i) => {
        expect(m.gamesBefore).toBe(i);
        expect(m.expShare).toBeGreaterThan(0);
        expect(m.expShare).toBeLessThan(1);
        expect(m.pointShare).toBeCloseTo(m.gf / (m.gf + m.ga), 12);
        const partner = partnerEntry(cs, m);
        expect(partner.expShare).toBe(m.expShare); // team-mates share the same par
        const opp = cs.st[m.opps[0]].matches.find((x) => x.id === m.id)!;
        expect(opp.expShare + m.expShare).toBeCloseTo(1, 10); // and the other side has the complement
        expect(opp.winProb + m.winProb).toBeCloseTo(1, 10);
      });
    }
  });
});

describe("lastPlayed / firstPlayed", () => {
  it("bracket a player's history with the right epochs", () => {
    const ms = history();
    const cs = computeStandings(players, ms);
    expect(cs.st["a"].firstPlayed).toBe(ms[0].order);
    expect(cs.st["a"].lastPlayed).toBe(ms[ms.length - 1].order);
    expect(cs.lastMatchAt).toBe(ms[ms.length - 1].order);
  });

  it("are 0 for a player with no games", () => {
    const cs = computeStandings([...players, { id: "z", name: "Z", color: "#fff", active: true }], history());
    expect(cs.st["z"].lastPlayed).toBe(0);
    expect(cs.st["z"].firstPlayed).toBe(0);
  });

  it("are unchanged when the same matches arrive shuffled", () => {
    const ms = history();
    const shuffled = [ms[4], ms[0], ms[9], ms[2], ...ms.filter((_, i) => ![0, 2, 4, 9].includes(i))];
    expect(computeStandings(players, shuffled).st["a"].lastPlayed)
      .toBe(computeStandings(players, ms).st["a"].lastPlayed);
  });
});

describe("dayBuckets / activityGrid", () => {
  // 2026-06-10 is BST (UTC+1), so a 23:30 UTC kick-off is already the 11th in London.
  const lateNight = Date.UTC(2026, 5, 10, 23, 30);

  it("buckets by London calendar day, not by UTC", () => {
    expect(dayKey(lateNight)).toBe("2026-06-11");
  });

  it("collapses several games on one day into a single bucket", () => {
    const t = Date.UTC(2026, 5, 10, 18, 0);
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, t),
      match("m2", ["a", "c"], ["b", "d"], 21, 8, t + 3_600_000),
      match("m3", ["a", "d"], ["b", "c"], 15, 21, t + 7_200_000),
    ]);
    const b = dayBuckets(cs.st["a"]);
    expect(b.length).toBe(1);
    expect(b[0]).toMatchObject({ games: 3, wins: 2, losses: 1 });
    expect(b[0].matchIds).toEqual(["m1", "m2", "m3"]);
  });

  it("ascends, and its games sum back to the player's total", () => {
    const cs = computeStandings(players, history());
    for (const p of cs.ranked) {
      const b = dayBuckets(p);
      for (let i = 1; i < b.length; i++) expect(b[i].day > b[i - 1].day).toBe(true);
      expect(b.reduce((n, x) => n + x.games, 0)).toBe(p.games);
      for (const x of b) expect(x.wins + x.losses).toBe(x.games);
      expect(b.reduce((n, x) => n + x.delta, 0)).toBe(p.matches.reduce((n, m) => n + m.delta, 0));
    }
  });

  it("builds a rectangular grid ending on the week containing `now`", () => {
    const cs = computeStandings(players, history());
    const now = Date.UTC(2026, 5, 10, 12);
    const g = activityGrid(cs.st["a"], { weeks: 26, now });
    expect(g.columns.length).toBe(26);
    for (const col of g.columns) expect(col.length).toBe(7);
    const last = g.columns[25];
    expect(last.some((c) => c.day === "2026-06-10")).toBe(true);
    // 2026-06-10 is a Wednesday, so Thu–Sun of that week are out of range.
    expect(last.filter((c) => !c.inRange).length).toBe(4);
  });

  it("is byte-identical across two calls with the same `now`", () => {
    const cs = computeStandings(players, history());
    const now = Date.UTC(2026, 5, 10, 12);
    expect(activityGrid(cs.st["a"], { now })).toEqual(activityGrid(cs.st["a"], { now }));
  });

  it("reports all-time sessions and the longest gap between them", () => {
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, Date.UTC(2026, 0, 1, 12)),
      match("m2", ["a", "b"], ["c", "d"], 21, 5, Date.UTC(2026, 0, 2, 12)),
      match("m3", ["a", "b"], ["c", "d"], 21, 5, Date.UTC(2026, 0, 22, 12)),
    ]);
    const g = activityGrid(cs.st["a"], { now: Date.UTC(2026, 0, 25, 12) });
    expect(g.summary).toEqual({ games: 3, sessions: 3, longestGapDays: 20 });
  });
});

describe("computeBadges", () => {
  const ids = (p: Parameters<typeof computeBadges>[0]) => computeBadges(p).map((b) => b.id);

  it("gives a player with no games nothing at all", () => {
    const cs = computeStandings([...players, { id: "z", name: "Z", color: "#fff", active: true }], history());
    expect(computeBadges(cs.st["z"])).toEqual([]);
  });

  it("crowns the leader and lights up a win streak", () => {
    // a wins nine straight with every partner, so everyone is placed (9 ≥ PROV_N), a is
    // unarguably #1 and on a W9. Top Dog needs a rank, so a placing fixture can't earn it.
    const lineups: [[string, string], [string, string]][] = [[["a", "b"], ["c", "d"]], [["a", "c"], ["b", "d"]], [["a", "d"], ["b", "c"]]];
    const ms = Array.from({ length: 9 }, (_, i) => match(`n${i}`, lineups[i % 3][0], lineups[i % 3][1], 21, 10 + i, (i + 1) * DAY));
    const cs = computeStandings(players, ms);
    expect(cs.ranked[0].id).toBe("a");
    expect(cs.st["a"].rank).toBe(1);
    expect(ids(cs.st["a"])).toContain("top-dog");
    expect(ids(cs.st["a"])).toContain("on-fire");
    expect(ids(cs.st["a"])).not.toContain("rookie");
  });

  it("marks a player under eight games as a rookie who is still being placed", () => {
    const cs = computeStandings(players, [match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY)]);
    expect(cs.st["a"].provisional).toBe(true);
    const rookie = computeBadges(cs.st["a"]).find((b) => b.id === "rookie");
    expect(rookie?.desc).toBe(`Getting placed · ${PROV_N - 1} more`);
    // One game in and at their high-water mark — but a peak only counts once you're placed.
    expect(cs.st["a"].rating).toBe(cs.st["a"].peak);
    expect(ids(cs.st["a"])).not.toContain("peak");
  });

  it("awards Veteran or Iron Arm but never both", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    expect(cs.all.some((p) => p.games >= 25)).toBe(true);
    expect(cs.all.some((p) => p.games >= 15 && p.games < 25)).toBe(true);
    for (const p of cs.all) {
      const got = ids(p);
      expect(got.includes("veteran") && got.includes("iron-arm")).toBe(false);
      if (p.games >= 25) expect(got).toContain("veteran");
      else if (p.games >= 15) expect(got).toContain("iron-arm");
    }
  });

  it("returns a stable order and unique ids for the same input", () => {
    const cs = computeStandings(players, history());
    const first = ids(cs.st["a"]);
    expect(ids(cs.st["a"])).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  // The post-log screen diffs id sets either side of one game to spot what was just
  // unlocked, so a badge that turns on with the deciding win has to show up in that diff.
  it("surfaces a newly earned badge when diffed across one more game", () => {
    const first2 = [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY),
      match("m2", ["a", "c"], ["b", "d"], 21, 5, 2 * DAY),
    ];
    const before = computeStandings(players, first2);
    const after = computeStandings(players, [...first2, match("m3", ["a", "d"], ["b", "c"], 21, 5, 3 * DAY)]);
    const had = new Set(ids(before.st["a"]));
    const unlocked = ids(after.st["a"]).filter((id) => !had.has(id));
    expect(had.has("on-fire")).toBe(false); // W2 going in
    expect(unlocked).toContain("on-fire"); // W3 coming out
  });
});

describe("explainRating / ratingStory", () => {
  it("splits into parts that add back to the exact rating, for everyone", () => {
    for (const cs of [computeStandings(players, history()), computeStandings(bigPlayers, bigHistory())]) {
      for (const p of cs.all) {
        const e = explainRating(p);
        expect(e.start + e.fromWins + e.fromLosses + e.revalued).toBe(p.rating);
        expect(e.rating).toBe(p.rating);
        expect(e.start).toBe(p.hist[0].r);
        expect(e.revalued).toBe(p.revalued);
        if (p.games === 0) expect(e).toMatchObject({ fromWins: 0, fromLosses: 0, revalued: 0, start: p.rating });
      }
    }
  });

  it("attributes every point of movement in your own games to a win or a loss", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    for (const p of cs.played) {
      const st = ratingStory(p);
      const total = st.climbFromWins + st.dropFromLosses;
      expect(total).toBe(p.matches.reduce((n, m) => n + m.delta, 0));
      // Every win pays at least WIN_MIN. No sign assertion on losses: a loss above par earns.
      expect(st.climbFromWins).toBeGreaterThanOrEqual(p.wins * WIN_MIN);
      expect(st.climbFromWins).toBe(p.matches.filter((m) => m.won).reduce((n, m) => n + m.delta, 0));
      expect(st.dropFromLosses).toBe(p.matches.filter((m) => !m.won).reduce((n, m) => n + m.delta, 0));
    }
  });

  it("counts down the games still needed to get placed, and stops at zero", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    for (const p of cs.ranked) expect(ratingStory(p).gamesToPlace).toBe(0);
    expect(ratingStory(cs.st["i"]).gamesToPlace).toBe(PROV_N - 3);
    expect(ratingStory(cs.st["z"]).gamesToPlace).toBe(PROV_N);
    const rookieCs = computeStandings(players, [match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY)]);
    expect(ratingStory(rookieCs.st["a"]).gamesToPlace).toBe(PROV_N - 1);
  });

  it("turns a share of the points into the scoreline the league expected", () => {
    expect(parScoreline(0.5)).toBe("21–21");
    expect(parScoreline(0.6)).toBe("21–14");
    expect(parScoreline(0.4)).toBe("14–21");
    // Clamped at the extremes so a near-certain game still reads as a scoreline.
    expect(parScoreline(1)).toBe("21–1");
    expect(parScoreline(0)).toBe("1–21");
    for (const s of [0.05, 0.2, 0.5, 0.77, 0.95]) expect(parScoreline(s)).toMatch(/^\d+–\d+$/);
  });

  it("names par, the actual score and the points in a match verdict", () => {
    const cs = computeStandings(players, history());
    for (const e of cs.ranked[0].matches) {
      const sign = e.delta >= 0 ? "+" : "";
      expect(matchVerdict(e)).toBe(`Par ${parScoreline(e.expShare)}, actual ${e.gf}–${e.ga} → ${sign}${e.delta}`);
    }
    // The very first game has no history to go on, so par is dead level.
    expect(matchVerdict(cs.st["a"].matches[0])).toMatch(/^Par 21–21, actual 21–12 → \+\d+$/);
  });
});

describe("explainDelta", () => {
  it("names all three levers in order, every time", () => {
    for (const cs of [computeStandings(players, history()), computeStandings(bigPlayers, bigHistory())]) {
      for (const p of cs.all) {
        for (const m of p.matches) {
          const b = explainDelta(m);
          expect(b.factors.map((f) => f.key)).toEqual(["odds", "margin", "pace"]);
          for (const f of b.factors) {
            expect(f.lift).toBeGreaterThanOrEqual(-1);
            expect(f.lift).toBeLessThanOrEqual(1);
            expect(f.effect.length).toBeGreaterThan(0);
            expect(f.label.length).toBeGreaterThan(0);
          }
          expect(b.delta).toBe(m.delta);
          expect(b.expShare).toBe(m.expShare);
          expect(b.pointShare).toBe(m.pointShare);
          expect(b.par).toBe(parScoreline(m.expShare));
          expect(b.par).toMatch(/^\d+–\d+$/);
          expect(b.headline.length).toBeGreaterThan(0);
          expect(b.compare).toBeNull(); // no partner supplied, nothing to compare
        }
      }
    }
  });

  it("flags under par exactly when a win needed topping up, and headlines both surprises", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    const entries = cs.all.flatMap((p) => p.matches);
    // Guards: the fixture has to contain a win the fit alone would have dropped and a loss
    // above par, or the assertions below would pass vacuously.
    expect(entries.some((m) => m.won && m.delta - m.held < 0)).toBe(true);
    expect(entries.some((m) => !m.won && m.delta > 0)).toBe(true);
    for (const m of entries) {
      const b = explainDelta(m);
      expect(b.underPar).toBe(m.won && m.delta - m.held < 0);
      if (b.underPar) expect(b.headline).toBe(`Won, but under par — a win always pays, so +${winFloor(m.gf, m.ga)}`);
      if (!m.won && m.delta > 0) expect(b.headline).toContain("above par");
    }
  });

  it("rates an upset above an expected win on the odds lever", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    const entries = cs.all.flatMap((p) => p.matches).filter((m) => m.won);
    const upset = entries.reduce((a, b) => (b.winProb < a.winProb ? b : a));
    const expected = entries.reduce((a, b) => (b.winProb > a.winProb ? b : a));
    const oddsLift = (m: MatchEntry) => explainDelta(m).factors.find((f) => f.key === "odds")!.lift;
    expect(upset.winProb).toBeLessThan(0.5);
    expect(expected.winProb).toBeGreaterThan(0.5);
    expect(oddsLift(upset)).toBeGreaterThan(0);
    expect(oddsLift(expected)).toBeLessThan(0);
    expect(oddsLift(upset)).toBeGreaterThan(oddsLift(expected));
    // And the margin lever points the same way as the points did.
    for (const m of cs.all.flatMap((p) => p.matches)) {
      const lift = explainDelta(m).factors.find((f) => f.key === "margin")!.lift;
      if (m.pointShare > m.expShare + 0.01) expect(lift).toBeGreaterThan(0);
      if (m.pointShare < m.expShare - 0.01) expect(lift).toBeLessThan(0);
    }
  });

  it("compares partners only when they moved differently enough, and names the one who moved further", () => {
    // Same par, same result: the comparison is purely about who swung further off it. It
    // stays null below 1.15× — there's nothing to explain and saying so is noise.
    const cs = computeStandings(bigPlayers, bigHistory());
    let named = 0, quiet = 0;
    for (const p of cs.all) {
      for (const m of p.matches) {
        const partner = partnerEntry(cs, m);
        const name = cs.st[m.partner].name;
        const b = explainDelta(m, { entry: partner, name });
        const mine = Math.abs(m.delta), theirs = Math.abs(partner.delta);
        const theyMoved = mine >= 1 && theirs / mine >= 1.15;
        const iMoved = theirs >= 1 && mine / theirs >= 1.15;
        if (!theyMoved && !iMoved) { expect(b.compare).toBeNull(); quiet++; continue; }
        named++;
        expect(b.compare).not.toBeNull();
        // Names who moved further, states the rule, then gives the first reason that applies.
        const [far, near] = theyMoved ? [partner, m] : [m, partner];
        expect(b.compare!.startsWith(theyMoved ? `${name} moved ~` : `You moved ~`)).toBe(true);
        expect(b.compare).toContain(theyMoved ? "further than you off the same result" : `further than ${name} off the same result`);
        expect(b.compare).toContain("ratings don't decide the split");
        if (far.gamesBefore < near.gamesBefore) {
          expect(b.compare).toContain(theyMoved
            ? `It has ${far.gamesBefore} game${far.gamesBefore === 1 ? "" : "s"} on ${name} to ${near.gamesBefore} on you.`
            : `It has ${far.gamesBefore} game${far.gamesBefore === 1 ? "" : "s"} on you to ${near.gamesBefore} on ${name}.`);
        } else if (far.daysOff !== null && near.daysOff !== null && far.daysOff > near.daysOff) {
          expect(b.compare).toContain(`${far.daysOff} days off`);
        } else if (far.earlierToday < near.earlierToday) {
          expect(b.compare).toContain(`already played ${near.earlierToday} game`);
        } else {
          expect(b.compare).toContain("how the rest of");
        }
      }
    }
    expect(named).toBeGreaterThan(0);
    expect(quiet).toBeGreaterThan(0);
  });

  it("answers the rookie-and-veteran comparison from both sides", () => {
    // i's first ever game is alongside a, who the league has 26 games on. The newcomer is the
    // one still being worked out, so the same result moves them several times further.
    const cs = computeStandings(bigPlayers, bigHistory());
    const rookie = cs.st["i"].matches[0];
    const vet = cs.st["a"].matches.find((m) => m.id === rookie.id)!;
    expect(rookie.gamesBefore).toBe(0);
    expect(vet.gamesBefore).toBeGreaterThanOrEqual(PROV_N);
    expect(Math.abs(rookie.delta)).toBeGreaterThan(1.15 * Math.abs(vet.delta));
    expect(explainDelta(vet, { entry: rookie, name: "I" }).compare).toMatch(/^I moved ~[\d.]+× further/);
    expect(explainDelta(rookie, { entry: vet, name: "A" }).compare).toMatch(/^You moved ~[\d.]+× further than A/);
  });

  it("says ratings don't decide the split when the higher-rated partner took more off a win", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    let seen = 0;
    for (const p of cs.all) for (const m of p.matches) {
      const partner = partnerEntry(cs, m);
      if (!m.won || m.ratingBefore <= partner.ratingBefore || m.delta < 1.15 * partner.delta || partner.delta < 1) continue;
      // m is the higher-rated partner and took more off the win: the lower-rated one's view.
      const b = explainDelta(partner, { entry: m, name: p.name });
      expect(b.compare!.startsWith(`${p.name} moved ~`)).toBe(true);
      expect(b.compare).toContain("ratings don't decide the split");
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("records days off and games already played that day on every entry", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    for (const p of cs.played) {
      let lastDay: string | null = null, today = 0;
      p.matches.forEach((m, k) => {
        const d = dayKey(m.t);
        if (k === 0) { expect(m.daysOff).toBeNull(); expect(m.earlierToday).toBe(0); }
        if (d === lastDay) { today++; expect(m.earlierToday).toBe(today); }
        else { today = 0; expect(m.earlierToday).toBe(0); if (lastDay) expect(m.daysOff).toBe(Math.round((Date.parse(d) - Date.parse(lastDay)) / DAY)); }
        if (k > 0 && d === lastDay) expect(m.daysOff).toBe(p.matches[k - 1].daysOff);
        lastDay = d;
      });
    }
  });

  it("stays quiet when both partners moved the same", () => {
    // The league's first game: nobody has history, so the two winners are interchangeable
    // and move by exactly the same amount. There is nothing to explain, and it must not
    // invent any.
    const cs = computeStandings(players, [match("m1", ["a", "b"], ["c", "d"], 21, 10, DAY)]);
    const a = cs.st["a"].matches[0], b = cs.st["b"].matches[0];
    expect(a.delta).toBe(b.delta);
    expect(a.delta).toBeGreaterThan(0);
    expect(explainDelta(a, { entry: b, name: "B" }).compare).toBeNull();
  });
});

describe("leagueRecords / leaderboards", () => {
  it("names real players and points single-game records at real games", () => {
    const ms = history();
    const cs = computeStandings(players, ms);
    const { records, totals } = leagueRecords(cs, ms);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      for (const id of r.playerIds) expect(cs.st[id]).toBeDefined();
      if (r.matchId) expect(ms.some((m) => m.id === r.matchId)).toBe(true);
    }
    expect(totals.games).toBe(ms.length);
    expect(totals.points).toBe(ms.reduce((n, m) => n + m.scoreA + m.scoreB, 0));
  });

  it("keeps provisional players off the all-time rating board", () => {
    // e and f play once, so their rating is noise — it must not top "highest ever".
    const six: LeaguePlayer[] = [
      ...players,
      { id: "e", name: "E", color: "#fff", active: true },
      { id: "f", name: "F", color: "#fff", active: true },
    ];
    const ms = [...history(), match("blowout", ["e", "f"], ["a", "b"], 21, 0, 99 * DAY)];
    const cs = computeStandings(six, ms);
    expect(cs.st["e"].provisional).toBe(true);
    const peak = leagueRecords(cs, ms).records.find((r) => r.key === "peak");
    expect(peak).toBeDefined();
    expect(peak!.playerIds).not.toContain("e");
    expect(peak!.playerIds).not.toContain("f");
  });

  it("survives an empty league without throwing", () => {
    const cs = computeStandings(players, []);
    const { records, totals } = leagueRecords(cs, []);
    expect(records).toEqual([]);
    expect(totals).toEqual({ games: 0, players: 0, points: 0 });
    expect(leaderboards(cs)).toEqual([]);
  });

  it("orders every leaderboard descending and caps it at the top N", () => {
    const cs = computeStandings(players, history());
    for (const b of leaderboards(cs, 3)) {
      expect(b.rows.length).toBeLessThanOrEqual(3);
      for (let i = 1; i < b.rows.length; i++) expect(b.rows[i - 1].value).toBeGreaterThanOrEqual(b.rows[i].value);
    }
  });
});

describe("previewMatch", () => {
  const hypo = { teamA: ["a", "b"], teamB: ["c", "d"], scoreA: 21, scoreB: 12 };

  it("predicts exactly what actually logging that game would do", () => {
    const ms = history();
    const cs = computeStandings(players, ms);
    const pv = previewMatch(players, ms, cs, hypo);
    const real = computeStandings(players, [...ms, match("real", ["a", "b"], ["c", "d"], 21, 12, cs.lastMatchAt + 1)]);
    for (const row of pv.rows) {
      expect(row.ratingAfter).toBe(real.st[row.id].rating);
      expect(row.delta).toBe(real.st[row.id].rating - cs.st[row.id].rating);
      expect(row.rankAfter).toBe(real.st[row.id].rank);
    }
    expect(pv.winProb).toBe(real.st["a"].matches[real.st["a"].matches.length - 1].winProb);
  });

  it("agrees with a full replay across several scorelines", () => {
    const ms = history();
    const cs = computeStandings(players, ms);
    for (const [sa, sb] of [[21, 0], [21, 19], [12, 21]] as const) {
      const pv = previewMatch(players, ms, cs, { ...hypo, scoreA: sa, scoreB: sb });
      const real = computeStandings(players, [...ms, match("real", ["a", "b"], ["c", "d"], sa, sb, cs.lastMatchAt + 1)]);
      for (const row of pv.rows) expect(row.ratingAfter).toBe(real.st[row.id].rating);
    }
  });

  it("agrees with a full replay on the wider league too, ripples and all", () => {
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const pv = previewMatch(bigPlayers, ms, cs, { teamA: ["h", "g"], teamB: ["a", "b"], scoreA: 21, scoreB: 19 });
    const real = computeStandings(bigPlayers, [...ms, match("real", ["h", "g"], ["a", "b"], 21, 19, cs.lastMatchAt + 1)]);
    for (const row of pv.rows) {
      expect(row.ratingAfter).toBe(real.st[row.id].rating);
      expect(row.rankAfter).toBe(real.st[row.id].rank);
    }
  });

  it("moves every winner further up than any loser when the result beats par", () => {
    const ms = history();
    const cs = computeStandings(players, ms);
    const pv = previewMatch(players, ms, cs, hypo);
    const winners = pv.rows.filter((r) => hypo.teamA.includes(r.id));
    const losers = pv.rows.filter((r) => hypo.teamB.includes(r.id));
    // 21–12 from a roughly level pair is comfortably above par, so it pays the winners and
    // costs the losers. (That is NOT a general law any more: a favourite scraping home under
    // par loses points — see "rating model".) What always holds is winners above losers.
    expect(winners.every((r) => r.delta > 0)).toBe(true);
    expect(losers.every((r) => r.delta < 0)).toBe(true);
    const worstWinner = Math.min(...winners.map((r) => r.delta));
    const bestLoser = Math.max(...losers.map((r) => r.delta));
    expect(worstWinner).toBeGreaterThan(bestLoser);
  });

  it("moves the underlying skill the same way as the rating", () => {
    const ms = history();
    const cs = computeStandings(players, ms);
    const real = computeStandings(players, [...ms, match("real", ["a", "b"], ["c", "d"], 21, 12, cs.lastMatchAt + 1)]);
    for (const id of hypo.teamA) expect(real.st[id].mu).toBeGreaterThan(cs.st[id].mu);
    for (const id of hypo.teamB) expect(real.st[id].mu).toBeLessThan(cs.st[id].mu);
    // The rating is a fixed affine map of mu plus the win top-up, which only ever adds.
    for (const p of real.all) expect(p.rating).toBe(disp(p.mu) + p.held);
  });

  it("does not mutate the inputs it was given", () => {
    const ms = history();
    const cs = computeStandings(players, ms);
    const snapshot = () => cs.all.map((p) => [p.id, p.mu, p.rating, p.share, p.matches.length, p.hist.length] as const);
    const before = snapshot();
    const matchCount = ms.length, ledgerLen = cs.ledger.snaps.length;
    previewMatch(players, ms, cs, hypo);
    expect(ms.length).toBe(matchCount);
    expect(cs.ledger.snaps.length).toBe(ledgerLen);
    expect(snapshot()).toEqual(before);
  });

  it("returns nothing for an invalid line-up rather than guessing", () => {
    const cs = computeStandings(players, history());
    expect(previewMatch(players, history(), cs, { ...hypo, teamB: ["c", "c"] }).rows).toEqual([]);
    expect(previewMatch(players, history(), cs, { ...hypo, teamB: ["c", "zzz"] }).rows).toEqual([]);
  });
});

describe("headToHead", () => {
  it("keeps games against and games alongside as separate records", () => {
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY), // a WITH b
      match("m2", ["a", "c"], ["b", "d"], 21, 8, 2 * DAY), // a AGAINST b, a wins
      match("m3", ["a", "d"], ["b", "c"], 10, 21, 3 * DAY), // a AGAINST b, a loses
    ]);
    const h = headToHead(cs.st["a"], "b");
    expect(h.with).toMatchObject({ games: 1, wins: 1, losses: 0 });
    expect(h.vs).toMatchObject({ games: 2, wins: 1, losses: 1 });
    expect(h.games.length).toBe(3);
    // the two lists partition the shared games, in the same order
    expect(h.vsGames.map((e) => e.id)).toEqual(["m2", "m3"]);
    expect(h.withGames.map((e) => e.id)).toEqual(["m1"]);
    expect(h.vsGames.length + h.withGames.length).toBe(h.games.length);
  });

  it("counts points and rating swing only from games they were opposed in", () => {
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY),
      match("m2", ["a", "c"], ["b", "d"], 21, 8, 2 * DAY),
    ]);
    const h = headToHead(cs.st["a"], "b");
    expect(h.vs.pf).toBe(21);
    expect(h.vs.pa).toBe(8);
    expect(h.swing).toBe(cs.st["a"].matches[1].delta);
  });

  it("is empty for someone they have never shared a court with", () => {
    const six: LeaguePlayer[] = [...players, { id: "z", name: "Z", color: "#fff", active: true }];
    const cs = computeStandings(six, history());
    const h = headToHead(cs.st["a"], "z");
    expect(h.games).toEqual([]);
    expect(h.vsGames).toEqual([]);
    expect(h.withGames).toEqual([]);
    expect(h.vs.games).toBe(0);
    expect(h.with.games).toBe(0);
  });
});

describe("comparePlayers", () => {
  // a wins both of theirs, b loses both — a leads on everything that's a merit.
  const cs = () => computeStandings(players, [
    match("m1", ["a", "c"], ["b", "d"], 21, 10, DAY),
    match("m2", ["a", "d"], ["b", "c"], 21, 12, 2 * DAY),
  ]);
  const row = (k: string) => comparePlayers(cs().st["a"], cs().st["b"]).find((r) => r.key === k)!;

  it("gives every line to whoever is actually ahead on it", () => {
    expect(row("rating").lead).toBe("a");
    expect(row("winPct")).toMatchObject({ a: "100%", b: "0%", lead: "a" });
    expect(row("record")).toMatchObject({ a: "2–0", b: "0–2" });
    expect(row("diff").lead).toBe("a");
    // Two games in, neither has a rank to compare — the line is a dash, not a guess.
    expect(row("rank")).toMatchObject({ a: "–", b: "–", lead: null });
  });

  it("awards the rank line to the lower number once both are placed", () => {
    const full = computeStandings(players, history());
    const rows = comparePlayers(full.st["a"], full.st["d"]);
    expect(full.st["a"].rank).toBe(1);
    expect(rows.find((r) => r.key === "rank")).toMatchObject({ a: "#1", b: `#${full.st["d"].rank}`, lead: "a" });
    expect(rows.find((r) => r.key === "rating")!.lead).toBe("a");
  });

  it("calls a level line level, and never awards games played", () => {
    expect(row("games")).toMatchObject({ a: "2", b: "2", lead: null });
    const same = comparePlayers(cs().st["a"], cs().st["a"]);
    expect(same.every((r) => r.lead === null)).toBe(true);
  });

  it("leads nothing when one of them has never played", () => {
    const six: LeaguePlayer[] = [...players, { id: "z", name: "Z", color: "#fff", active: true }];
    const rows = comparePlayers(computeStandings(six, history()).st["a"], computeStandings(six, history()).st["z"]);
    expect(rows.every((r) => r.lead === null)).toBe(true);
    expect(rows.find((r) => r.key === "rank")!.b).toBe("–");
    expect(rows.find((r) => r.key === "ppg")!.b).toBe("–");
  });
});

describe("isDormant", () => {
  // b and d play only the opening game, then sit out — the gap is theirs alone.
  const six: LeaguePlayer[] = [
    ...players,
    { id: "e", name: "E", color: "#fff", active: true },
    { id: "f", name: "F", color: "#fff", active: true },
  ];

  it("is measured against the league's last game, not wall clock", () => {
    const cs = computeStandings(six, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY),
      match("m2", ["a", "c"], ["e", "f"], 21, 5, DAY + 40 * DAY),
    ]);
    expect(isDormant(cs.st["b"], cs)).toBe(true);
    expect(daysSincePlayed(cs.st["b"], cs)).toBe(40);
  });

  it("never marks a player from the most recent game as dormant", () => {
    const cs = computeStandings(six, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY),
      match("m2", ["a", "c"], ["e", "f"], 21, 5, DAY + 40 * DAY),
    ]);
    for (const id of ["a", "c", "e", "f"]) expect(isDormant(cs.st[id], cs)).toBe(false);
  });

  it("holds just inside the threshold and trips just outside it", () => {
    const inside = computeStandings(six, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY),
      match("m2", ["a", "c"], ["e", "f"], 21, 5, DAY + DORMANT_DAYS * DAY),
    ]);
    expect(isDormant(inside.st["b"], inside)).toBe(false);
    const outside = computeStandings(six, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, DAY),
      match("m2", ["a", "c"], ["e", "f"], 21, 5, DAY + (DORMANT_DAYS + 1) * DAY),
    ]);
    expect(isDormant(outside.st["b"], outside)).toBe(true);
  });

  it("marks nobody dormant when the whole league has been quiet", () => {
    const cs = computeStandings(players, history());
    for (const p of cs.ranked) expect(isDormant(p, cs)).toBe(false);
  });

  describe("resting players give up their rank", () => {
    // a–d play the closed foursome (12 games each), then a and b play eight more with e and f
    // six weeks later. c and d are placed but haven't played in over DORMANT_DAYS.
    const later = (): LeagueMatch[] => {
      const out = history();
      for (let i = 0; i < 8; i++) {
        const t1: [string, string] = i % 2 ? ["a", "e"] : ["a", "f"];
        const t2: [string, string] = i % 2 ? ["b", "f"] : ["b", "e"];
        out.push(match(`l${i}`, t1, t2, 21, 10 + i, (50 + i) * DAY));
      }
      return out;
    };

    it("numbers the rest of the ladder with no gap", () => {
      const cs = computeStandings(six, later());
      expect(isDormant(cs.st["c"], cs)).toBe(true);
      expect(isDormant(cs.st["d"], cs)).toBe(true);
      expect(cs.st["c"].rank).toBeUndefined();
      expect(cs.st["d"].rank).toBeUndefined();
      const ranks = cs.ranked.map((p) => p.rank).filter((r) => r !== undefined).sort();
      expect(ranks).toEqual([1, 2, 3, 4]);
      // Still placed and still rated: only the number goes.
      expect(cs.ranked.map((p) => p.id)).toContain("c");
      expect(cs.st["c"].provisional).toBe(false);
    });

    it("gives the rank back on their next game", () => {
      const ms = [...later(), match("back", ["c", "e"], ["d", "f"], 21, 15, 60 * DAY)];
      const cs = computeStandings(six, ms);
      expect(cs.st["c"].rank).toBeDefined();
      expect(cs.st["d"].rank).toBeDefined();
      expect(cs.ranked.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("ranks everyone who placed in a finished season's final table — nobody rests there", () => {
      const ms = later();
      const fin = computeStandings(six, ms, { final: true });
      expect(fin.final).toBe(true);
      expect(fin.ranked.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6]);
      for (const p of fin.ranked) expect(isDormant(p, fin)).toBe(false);
      expect(Object.keys(rankRanges(six, ms, 20, undefined, {}, true)).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
      // The same games as a live view still rest c and d.
      expect(computeStandings(six, ms).ranked.filter((p) => p.rank).length).toBe(4);
    });

    it("leaves them out of the rank ranges", () => {
      const ms = later();
      const rr = rankRanges(six, ms, 20);
      expect(Object.keys(rr).sort()).toEqual(["a", "b", "e", "f"]);
      for (const [, hi] of Object.values(rr)) expect(hi).toBeLessThanOrEqual(4);
    });
  });

  it("never marks a player with no games at all — they are unranked, not resting", () => {
    const cs = computeStandings([...players, { id: "z", name: "Z", color: "#fff", active: true }], history());
    expect(isDormant(cs.st["z"], cs)).toBe(false);
  });
});

describe("genSession", () => {
  const choose = (n: number, k: number) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return Math.round(r); };
  const roster = (n: number): LeaguePlayer[] =>
    Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i, color: "#fff", active: true }));
  const plan = (n: number, rounds = DEFAULT_ROUNDS, opts: SessionOpts = {}) => {
    const players = roster(n);
    const ids = players.map((p) => p.id);
    return { ids, plan: genSession(ids, computeStandings(players, []), { ...opts, rounds }) };
  };
  const planWithHistory = (n: number, history: LeagueMatch[], rounds = DEFAULT_ROUNDS, opts: SessionOpts = {}) => {
    const players = roster(n);
    const ids = players.map((p) => p.id);
    return { ids, plan: genSession(ids, computeStandings(players, history), { ...opts, rounds }) };
  };
  const partners = (p: SessionPlan) =>
    p.rounds.flatMap((rd) => rd.games.flatMap((g) => [[...g.A].sort().join("|"), [...g.B].sort().join("|")]));
  const teamed = (p: SessionPlan, a: string, b: string) => partners(p).includes([a, b].sort().join("|"));
  const shape = (p: SessionPlan) => JSON.stringify(p.rounds.map((rd) => rd.games.map((g) => [g.A, g.B])));

  it("needs at least four players and at least one round", () => {
    expect(genSession([], computeStandings([], []))).toEqual({ rounds: [], courts: 0, perPlayer: {} });
    expect(plan(3).plan.rounds).toEqual([]);
    expect(plan(6, 0).plan.rounds).toEqual([]);
    expect(plan(6).plan.rounds.length).toBe(DEFAULT_ROUNDS); // the default is 6 games
  });

  // A seeded run of past games. Empty-league fixtures make every novelty term tie, which
  // hides anything that only goes wrong once the cost landscape is uneven — see the
  // round-count regression below.
  const seededHistory = (n: number, games: number, seed: number): LeagueMatch[] => {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const ids = roster(n).map((p) => p.id);
    const out: LeagueMatch[] = [];
    for (let i = 0; i < games; i++) {
      const pool = [...ids], pick: string[] = [];
      for (let k = 0; k < 4; k++) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      out.push({ id: "m" + i, date: "x", order: i + 1, teamA: [pick[0], pick[1]], teamB: [pick[2], pick[3]], scoreA: 21, scoreB: 10 + (i % 11) });
    }
    return out;
  };

  it("emits exactly the rounds asked for, even on a league with history", () => {
    // Regression: the court search used to order courts by position in its candidate table,
    // which made pruned partial assignments unextendable — so with three or more courts it
    // silently returned fewer rounds than asked for, and at 16 or 20 players often none at
    // all, surfacing as "Couldn't build a plan for that group." Only reproduces with real
    // history; an empty league ties every score and the search survives by luck.
    // 12 / 16 / 20 are where it bit hardest (they returned 0 rounds) and are also cheap to
    // plan, since a multiple of four has only one possible bench. 17 and 18 reproduced it too
    // but cost about a second each — the perf test below covers that end.
    for (const n of [8, 11, 12, 13, 16, 20]) {
      for (const seed of [1, 42, 777]) {
        const players = roster(n);
        const cs = computeStandings(players, seededHistory(n, 80, seed));
        const p = genSession(players.map((x) => x.id), cs, { rounds: 6 });
        expect({ n, seed, rounds: p.rounds.length }).toEqual({ n, seed, rounds: 6 });
        expect(p.rounds.every((rd) => rd.games.length === Math.floor(n / 4))).toBe(true);
      }
    }
  }, 20000);

  it("refuses a roster too big for its player bitmask rather than emitting nonsense", () => {
    // 1 << 32 wraps to 1 in JS, so beyond 31 players the masks stop meaning anything.
    const big = roster(32);
    expect(genSession(big.map((p) => p.id), computeStandings(big, []), { rounds: 6 }))
      .toEqual({ rounds: [], courts: 0, perPlayer: {} });
  });

  it("emits exactly the rounds asked for, each an exact partition of the roster", () => {
    for (const n of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      for (const R of [1, 3, 6, 10]) {
        const { ids, plan: p } = plan(n, R);
        expect(p.courts).toBe(Math.floor(n / 4));
        expect(p.rounds.length).toBe(R);
        p.rounds.forEach((rd, i) => {
          expect(rd.index).toBe(i);
          expect(rd.games.length).toBe(p.courts);
          const playing = rd.games.flatMap((g) => [...g.A, ...g.B]);
          for (const g of rd.games) { expect(g.A.length).toBe(2); expect(g.B.length).toBe(2); }
          expect(new Set(playing).size).toBe(playing.length); // nobody on two courts at once
          expect(rd.out.length).toBe(n % 4);
          expect([...playing, ...rd.out].sort()).toEqual([...ids].sort());
        });
      }
    }
  });

  it("runs as many games at once as the headcount allows", () => {
    expect(plan(7).plan.courts).toBe(1); // 1 game, 3 sitting — 7 can't fill two nets
    expect(plan(8).plan.courts).toBe(2); // 2 games, nobody sits
    expect(plan(8).plan.rounds[0].out).toEqual([]);
    expect(plan(9).plan.courts).toBe(2); // 2 games, 1 sitting
    expect(plan(9).plan.rounds[0].out.length).toBe(1);
  });

  it("keeps games and sit-outs within one of each other, at every point in the night", () => {
    for (const n of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      for (const R of [1, 2, 3, 5, 6, 10]) {
        const { ids, plan: p } = plan(n, R);
        const games: Record<string, number> = {}, sits: Record<string, number> = {};
        ids.forEach((id) => { games[id] = 0; sits[id] = 0; });
        for (const rd of p.rounds) {
          for (const g of rd.games) for (const id of [...g.A, ...g.B]) games[id]++;
          for (const id of rd.out) sits[id]++;
          // Fair after every round, not just at the end — stopping early is still fair.
          const gs = Object.values(games), ss = Object.values(sits);
          expect(Math.max(...gs) - Math.min(...gs)).toBeLessThanOrEqual(1);
          expect(Math.max(...ss) - Math.min(...ss)).toBeLessThanOrEqual(1);
        }
        ids.forEach((id) => {
          expect(p.perPlayer[id]).toEqual({ games: games[id], sits: sits[id] });
          expect(games[id] + sits[id]).toBe(R);
        });
      }
    }
  });

  it("never benches the same player two rounds running, at any headcount", () => {
    for (const n of [5, 6, 7, 9, 10, 11]) {
      const { plan: p } = plan(n, 8);
      for (let i = 1; i < p.rounds.length; i++) {
        const prev = new Set(p.rounds[i - 1].out);
        expect(p.rounds[i].out.some((id) => prev.has(id))).toBe(false);
      }
    }
  });

  // ---- priorities, highest first ----

  it("puts the pairings that haven't played in the longest time first (LEAGUE history)", () => {
    // p0+p1 partnered in two of the last three league matches; nobody else ever has.
    // Six rounds of ten players is 24 partnership slots against 45 possible pairs, so
    // leaving the hot pair alone is comfortably avoidable.
    const { plan: p } = planWithHistory(10, [
      match("m1", ["p0", "p1"], ["p2", "p3"], 21, 15, 1),
      match("m2", ["p4", "p5"], ["p6", "p7"], 21, 15, 2),
      match("m3", ["p0", "p1"], ["p8", "p9"], 21, 12, 3),
    ]);
    expect(teamed(p, "p0", "p1")).toBe(false);
    // And every partnership it did pick is one with no history at all.
    expect(p.rounds[0].games.every((g) => g.fresh === 2)).toBe(true);
  });

  it("takes the fresher pairing over the better-balanced one", () => {
    // Four players, so the only choice is how to split them. p0 is strong and p1 weak, which
    // makes p0+p1 vs p2+p3 the *most balanced* of the three splits — and it's also the pair
    // who partnered most recently. Novelty has to win, lopsided teams and all.
    const four = roster(4);
    const cs = computeStandings(four, [
      match("m1", ["p0", "p2"], ["p1", "p3"], 21, 5, 1),
      match("m2", ["p0", "p3"], ["p1", "p2"], 21, 5, 2),
      match("m3", ["p0", "p1"], ["p2", "p3"], 21, 19, 3),
    ]);
    const mu = (id: string) => cs.st[id].mu;
    const gapOf = (A: string[], B: string[]) => Math.abs(mu(A[0]) + mu(A[1]) - mu(B[0]) - mu(B[1]));
    const repeatSplit = gapOf(["p0", "p1"], ["p2", "p3"]);
    const freshSplit = gapOf(["p0", "p2"], ["p1", "p3"]);
    // Premise: the stale pairing genuinely is the fairer game.
    expect(repeatSplit).toBeLessThan(freshSplit);
    expect(repeatSplit).toBeLessThan(gapOf(["p0", "p3"], ["p1", "p2"]));

    const p = genSession(four.map((x) => x.id), cs, { rounds: 1 });
    expect(teamed(p, "p0", "p1")).toBe(false);
    expect(teamed(p, "p0", "p2")).toBe(true); // the freshest split, two games since either pair
  });

  it("holds the rotation even when every freshest pairing wants the same player", () => {
    // p0 has never partnered anyone; everyone else has partnered everyone else recently.
    // So every pairing involving p0 is maximally novel — but p0 still has to sit their turn.
    const five = roster(5);
    const history: LeagueMatch[] = [
      match("m1", ["p1", "p2"], ["p3", "p4"], 21, 15, 1),
      match("m2", ["p1", "p3"], ["p2", "p4"], 21, 15, 2),
      match("m3", ["p1", "p4"], ["p2", "p3"], 21, 15, 3),
    ];
    const p = genSession(five.map((x) => x.id), computeStandings(five, history), { rounds: 5 });
    expect(p.perPlayer["p0"].sits).toBe(1); // 5 rounds, 1 sitting each — exactly their share
  });

  it("weighs partners above opponents", () => {
    // p0+p1 and p2+p3 have never partnered, but the four have faced each other a lot.
    // p0+p2 / p1+p3 have partnered recently and never met as opponents. Fresh partners win.
    const four = roster(4);
    const history: LeagueMatch[] = [
      match("m1", ["p0", "p2"], ["p1", "p3"], 21, 15, 1),
      match("m2", ["p0", "p2"], ["p1", "p3"], 21, 17, 2),
      match("m3", ["p0", "p3"], ["p1", "p2"], 21, 15, 3),
    ];
    const p = genSession(four.map((x) => x.id), computeStandings(four, history), { rounds: 1 });
    expect(teamed(p, "p0", "p1")).toBe(true);
    expect(teamed(p, "p2", "p3")).toBe(true);
  });

  it("mixes up the session: no repeated partnerships while fresh ones remain", () => {
    // 4·courts·R partnership slots vs C(n,2) available pairs — repeats are avoidable.
    for (const n of [6, 8, 12]) {
      const { plan: p } = plan(n, 6);
      const ps = partners(p);
      expect(ps.length).toBeLessThanOrEqual(choose(n, 2)); // premise of the assertion
      expect(new Set(ps).size).toBe(ps.length);
    }
    // Five players over six rounds is 12 slots against 10 pairs, so a couple must repeat.
    const ps5 = partners(plan(5, 6).plan);
    expect(ps5.length - new Set(ps5).size).toBeLessThanOrEqual(2);
  });

  it("still mixes up the session when the league already has history", () => {
    // Regression: with a real match history, league staleness varies from pair to pair, and
    // an early version let whichever matchup scored best on paper come up round after round
    // (rounds 3 and 5 came out identical) because tonight's repeats were ranked below league
    // history rather than counted as part of it. A pairing used tonight has just played.
    const history: LeagueMatch[] = [];
    const ids7 = Array.from({ length: 7 }, (_, i) => "p" + i);
    // 20 games of lopsided, uneven history so no two pairings look alike.
    for (let i = 0; i < 20; i++) {
      const a = ids7[i % 7], b = ids7[(i * 3 + 1) % 7], c = ids7[(i * 5 + 2) % 7], d = ids7[(i * 2 + 4) % 7];
      if (new Set([a, b, c, d]).size !== 4) continue;
      history.push(match("h" + i, [a, b], [c, d], 21, 8 + (i % 12), i + 1));
    }
    for (const n of [5, 6, 7, 8]) {
      const { plan: p } = planWithHistory(n, history, 6);
      const ps = partners(p);
      const forced = Math.max(0, ps.length - choose(n, 2)); // pigeonhole: slots vs pairs
      expect(ps.length - new Set(ps).size).toBe(forced); // repeats only where unavoidable
      if (!forced) {
        const games = p.rounds.flatMap((rd) => rd.games.map((g) => g.key));
        expect(new Set(games).size).toBe(games.length); // and no matchup twice in one night
      }
    }
  });

  it("balances teams once nothing above it can decide", () => {
    // Empty league: every pairing is equally novel and every rating identical, so the only
    // term left is balance — and with equal ratings every game comes out level.
    expect(plan(8, 6).plan.rounds.every((rd) => rd.games.every((g) => g.diff === 0))).toBe(true);
  });

  // ---- determinism ----

  it("gives the same plan for the same inputs, whatever order the ids arrive in", () => {
    const ten = roster(10);
    const cs = computeStandings(ten, [match("m1", ["p0", "p1"], ["p2", "p3"], 21, 9, 1)]);
    const ids = ten.map((p) => p.id);
    const a = genSession(ids, cs, { rounds: 6 });
    expect(shape(genSession(ids, cs, { rounds: 6 }))).toBe(shape(a));
    expect(shape(genSession([...ids].reverse(), cs, { rounds: 6 }))).toBe(shape(a));
  });

  it("stays deterministic on a league with history, at every court count", () => {
    for (const n of [6, 9, 12, 13, 16]) {
      const players = roster(n);
      const cs = computeStandings(players, seededHistory(n, 80, 42));
      const ids = players.map((x) => x.id);
      const a = shape(genSession(ids, cs, { rounds: 6 }));
      expect(shape(genSession(ids, cs, { rounds: 6 }))).toBe(a);
      expect(shape(genSession([...ids].reverse(), cs, { rounds: 6 }))).toBe(a);
    }
  }, 20000);

  it("plans a big session without blocking for seconds", () => {
    // Generation happens in a server action, so it holds the event loop. This is a
    // sanity bound to catch order-of-magnitude regressions, not a benchmark — an earlier
    // version took 24 seconds at 18 players.
    const players = roster(18);
    const cs = computeStandings(players, seededHistory(18, 80, 1));
    const t0 = Date.now();
    genSession(players.map((x) => x.id), cs, { rounds: DEFAULT_ROUNDS });
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 20000);

  it("never reaches for randomness", () => {
    const real = Math.random;
    Math.random = () => { throw new Error("genSession must be deterministic"); };
    try { for (const n of [4, 6, 8, 9, 12]) expect(plan(n, 6).plan.rounds.length).toBe(6); }
    finally { Math.random = real; }
  });

  // ---- replanning mid-session ----

  it("reproduces the rounds already played and only rewrites the rest", () => {
    const { ids, plan: first } = plan(10, 6);
    const players = roster(10);
    const cs = computeStandings(players, []);
    const played = first.rounds.slice(0, 2).flatMap((rd) => rd.games.map((g) => ({ A: g.A, B: g.B, round: rd.index })));
    const again = genSession(ids, cs, { rounds: 6, played });
    expect(again.rounds.length).toBe(6);
    expect(shape({ ...again, rounds: again.rounds.slice(0, 2) } as SessionPlan))
      .toBe(shape({ ...first, rounds: first.rounds.slice(0, 2) } as SessionPlan));
    expect(again.rounds.slice(0, 2).every((rd) => rd.locked)).toBe(true);
    expect(again.rounds.slice(0, 2).every((rd) => rd.games.every((g) => g.locked))).toBe(true);
    expect(again.rounds.slice(2).every((rd) => !rd.locked)).toBe(true);
    // Nothing about the night has changed, so the tail should land the same way too.
    expect(shape({ ...again, rounds: again.rounds.slice(2) } as SessionPlan))
      .toBe(shape({ ...first, rounds: first.rounds.slice(2) } as SessionPlan));
  });

  it("works a late arrival into the rounds that haven't started", () => {
    const eight = roster(8);
    const first = genSession(eight.map((p) => p.id), computeStandings(eight, []), { rounds: 6 });
    const nine = roster(9);
    const played = first.rounds[0].games.map((g) => ({ A: g.A, B: g.B, round: 0 }));
    const p = genSession(nine.map((x) => x.id), computeStandings(nine, []), { rounds: 6, played });
    expect(p.courts).toBe(2);
    expect(shape({ ...p, rounds: p.rounds.slice(0, 1) } as SessionPlan))
      .toBe(shape({ ...first, rounds: first.rounds.slice(0, 1) } as SessionPlan));
    expect(p.rounds[0].out).toEqual(["p8"]); // they weren't there for round 1
    expect(p.perPlayer["p8"].games).toBe(5); // and play every round after it
    for (let i = 1; i < p.rounds.length; i++) expect(p.rounds[i].out.length).toBe(1);
  });

  it("keeps a departed player in the games they played and out of the ones to come", () => {
    const eight = roster(8);
    const first = genSession(eight.map((p) => p.id), computeStandings(eight, []), { rounds: 6 });
    const played = first.rounds[0].games.map((g) => ({ A: g.A, B: g.B, round: 0 }));
    const gone = first.rounds[0].games[0].A[0];
    const rest = eight.filter((p) => p.id !== gone);
    const p = genSession(rest.map((x) => x.id), computeStandings(eight, []), { rounds: 6, played });
    const inRound0 = p.rounds[0].games.flatMap((g) => [...g.A, ...g.B]);
    expect(inRound0).toContain(gone); // history is history
    const later = p.rounds.slice(1).flatMap((rd) => [...rd.games.flatMap((g) => [...g.A, ...g.B]), ...rd.out]);
    expect(later).not.toContain(gone);
  });
});

describe("opponent history", () => {
  it("records how often and how recently each pair has faced each other", () => {
    expect(computeStandings(players, []).foe).toEqual({});
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 10, 1),
      match("m2", ["a", "c"], ["b", "d"], 21, 15, 2),
    ]);
    // Four cross-team pairings per match, so a pair can be partners one game and rivals the
    // next: a|b and c|d were partners in m1, then faced each other in m2.
    expect(cs.foe["a|c"]).toEqual({ a: "a", b: "c", games: 1, lastIdx: 0 });
    expect(cs.foe["a|b"]).toEqual({ a: "a", b: "b", games: 1, lastIdx: 1 });
    expect(cs.foe["c|d"]).toEqual({ a: "c", b: "d", games: 1, lastIdx: 1 });
    expect(cs.foe["a|d"]).toEqual({ a: "a", b: "d", games: 2, lastIdx: 1 }); // rivals both games
    expect(Object.keys(cs.foe).length).toBe(6); // every pair has met by now
  });
});

describe("win probability", () => {
  it("is 50/50 for the very first game (no rating history yet)", () => {
    // Every founder shares one prior, so the two teams are indistinguishable going in.
    const cs = computeStandings(players, [match("m1", ["a", "b"], ["c", "d"], 21, 10, 1)]);
    expect(cs.st["a"].matches[0].winProb).toBeCloseTo(0.5, 6);
    expect(cs.st["c"].matches[0].winProb).toBeCloseTo(0.5, 6);
    expect(cs.st["a"].matches[0].expShare).toBeCloseTo(0.5, 6);
  });

  it("gives the two teams complementary probabilities within [0,1]", () => {
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 10, 1),
      match("m2", ["a", "c"], ["b", "d"], 21, 18, 2),
    ]);
    for (const p of cs.all) for (const mm of p.matches) {
      expect(mm.winProb).toBeGreaterThanOrEqual(0);
      expect(mm.winProb).toBeLessThanOrEqual(1);
    }
    // Same game, opposite sides — the two teams' chances sum to 1.
    expect(cs.st["a"].matches[0].winProb + cs.st["c"].matches[0].winProb).toBeCloseTo(1, 10);
  });

  it("favours the team with the stronger record going in", () => {
    const cs = computeStandings(players, [
      match("m1", ["a", "b"], ["c", "d"], 21, 5, 1),
      match("m2", ["a", "b"], ["c", "d"], 21, 6, 2),
      match("m3", ["a", "b"], ["c", "d"], 21, 7, 3),
    ]);
    // By the third meeting a&b are clearly stronger, so their pre-game chance > 50%.
    expect(cs.st["a"].matches[2].winProb).toBeGreaterThan(0.5);
    expect(cs.st["c"].matches[2].winProb).toBeLessThan(0.5);
  });
});

describe("tierOf", () => {
  it("names tiers by rating threshold", () => {
    expect(tierOf(0, false).name).toBe("Whiff Merchant");
    expect(tierOf(349, false).name).toBe("Whiff Merchant");
    expect(tierOf(350, false).name).toBe("Tacky Boomer");
    expect(tierOf(499, false).name).toBe("Tacky Boomer");
    expect(tierOf(500, false).name).toBe("Soft Touch");
    expect(tierOf(599, false).name).toBe("Soft Touch");
    expect(tierOf(600, false).name).toBe("Lob Goblin");
    expect(tierOf(699, false).name).toBe("Lob Goblin");
    expect(tierOf(700, false).name).toBe("Roll-Shot Rascal");
    expect(tierOf(799, false).name).toBe("Roll-Shot Rascal");
    expect(tierOf(800, false).name).toBe("Pocket Sniper");
    expect(tierOf(899, false).name).toBe("Pocket Sniper");
    expect(tierOf(900, false).name).toBe("Spike Lee");
    expect(tierOf(999, false).name).toBe("Spike Lee");
    expect(tierOf(1000, false).name).toBe("Tomahawk");
    expect(tierOf(1099, false).name).toBe("Tomahawk");
    expect(tierOf(1100, false).name).toBe("Block-ness Monster");
    expect(tierOf(1399, false).name).toBe("Block-ness Monster");
    expect(tierOf(1400, false).name).toBe("Scotty Beeks");
    expect(tierOf(9999, false).name).toBe("Scotty Beeks");
  });

  it("matches the TIERS table exactly, in ascending order", () => {
    expect(TIERS.map((t) => [t.min, t.name])).toEqual([
      [0, "Whiff Merchant"], [350, "Tacky Boomer"], [500, "Soft Touch"], [600, "Lob Goblin"],
      [700, "Roll-Shot Rascal"], [800, "Pocket Sniper"], [900, "Spike Lee"], [1000, "Tomahawk"],
      [1100, "Block-ness Monster"], [1400, "Scotty Beeks"],
    ]);
    for (const t of TIERS) {
      expect(tierOf(t.min, false).name).toBe(t.name);
      expect(tierOf(t.min - 1, false).name).not.toBe(t.min === 0 ? "" : t.name);
    }
  });

  it("starts everyone in Pocket Sniper, mid-list", () => {
    expect(tierOf(START, false).name).toBe("Pocket Sniper");
    expect(tierOf(disp(MODEL.MU0), false).name).toBe("Pocket Sniper");
    const idx = TIERS.findIndex((t) => t.name === "Pocket Sniper");
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(TIERS.length - 1);
  });

  it("keeps the top tier mythical: nobody in the closed foursome reaches it", () => {
    const cs = computeStandings(players, history());
    for (const p of cs.all) {
      expect(p.rating).toBeLessThan(1400);
      expect(p.peak).toBeLessThan(1400);
      expect(tierOf(p.rating, p.provisional).name).not.toBe("Scotty Beeks");
    }
  });

  it("shows Fresh Meat for provisional players regardless of rating", () => {
    expect(tierOf(50, true).name).toBe("Fresh Meat");
    expect(tierOf(1500, true).name).toBe("Fresh Meat");
    const cs = computeStandings(bigPlayers, bigHistory());
    expect(cs.st["i"].provisional).toBe(true);
    expect(tierOf(cs.st["i"].rating, cs.st["i"].provisional).name).toBe("Fresh Meat");
  });

  it("returns an icon and a 6-digit hex color for every tier", () => {
    for (const r of [0, 400, 550, 850, 1200, 1500]) {
      const t = tierOf(r, false);
      expect(t.icon).toBeTruthy();
      expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("rating model", () => {
  it("anchors the display scale on the founders' prior", () => {
    expect(disp(MODEL.MU0)).toBe(START);
    expect(disp(MODEL.MU0 + 1)).toBe(START + 80);
    expect(disp(MODEL.MU0 - 2.5)).toBe(START - 200);
  });

  it("turns a per-point edge into a race-to-21 win chance", () => {
    expect(gameWinProb(0.5)).toBeCloseTo(0.5, 12);
    expect(gameWinProb(0.6)).toBeGreaterThan(0.85);
    expect(gameWinProb(0)).toBe(0);
    expect(gameWinProb(1)).toBe(1);
    // Never decreasing anywhere, and strictly increasing wherever it hasn't saturated.
    for (let i = 1; i < 99; i++) expect(gameWinProb((i + 1) / 100)).toBeGreaterThanOrEqual(gameWinProb(i / 100));
    for (let i = 5; i < 90; i++) expect(gameWinProb((i + 1) / 100)).toBeGreaterThan(gameWinProb(i / 100));
    for (const p of [0.3, 0.45, 0.5, 0.62, 0.8]) expect(gameWinProb(p) + gameWinProb(1 - p)).toBeCloseTo(1, 10);
  });

  it("expects a symmetric share of the points", () => {
    // Φ is an odd-symmetric erf approximation, so the two sides are exact mirrors for any
    // non-zero gap; dead level sits 1e-9 off because erf(0) is not quite 0 in that formula.
    for (const [a0, a1, b0, b1] of [[27, 24, 25, 22], [20, 30, 31, 17], [40, 40, 10, 10], [25, 26, 25, 25]]) {
      expect(expectedShare(a0, a1, b0, b1) + expectedShare(b0, b1, a0, a1)).toBeCloseTo(1, 12);
    }
    expect(expectedShare(25, 25, 25, 25) + expectedShare(25, 25, 25, 25)).toBeCloseTo(1, 8);
    expect(expectedShare(25, 25, 25, 25)).toBeCloseTo(0.5, 8);
    expect(expectedShare(30, 30, 25, 25)).toBeGreaterThan(0.5);
    expect(expectedShare(30, 30, 25, 25)).toBeGreaterThan(expectedShare(27, 27, 25, 25));
  });

  it("does not care what order the matches arrive in", () => {
    const ms = bigHistory();
    const base = computeStandings(bigPlayers, ms);
    const reversed = computeStandings(bigPlayers, [...ms].reverse());
    const interleaved = computeStandings(bigPlayers, [...ms.filter((_, i) => i % 2), ...ms.filter((_, i) => !(i % 2))]);
    for (const p of base.all) {
      expect(reversed.st[p.id].mu).toBe(p.mu);
      expect(interleaved.st[p.id].mu).toBe(p.mu);
      expect(reversed.st[p.id].rating).toBe(p.rating);
      expect(reversed.st[p.id].rank).toBe(p.rank);
    }
    expect(reversed.ledger.sigs).toEqual(base.ledger.sigs);
  });

  it("does not care what order the games were played in within one day", () => {
    // Skill is one node per player per DAY, so the games of an evening are one joint
    // observation: swap their timestamps around inside the day and the fit is identical.
    const ms = bigHistory();
    const flipped = ms.map((m) => {
      const hour = Math.round(((m.order - T0) % DAY) / HOUR);
      return { ...m, order: m.order - hour * HOUR + (5 - hour) * HOUR };
    });
    for (let i = 0; i < ms.length; i++) expect(dayKey(flipped[i].order)).toBe(dayKey(ms[i].order)); // premise
    expect(flipped.map((m) => m.order).sort().join()).not.toBe(ms.map((m) => m.order).sort().join());
    // The two runs warm-start along different prefix paths (each prefix now holds a
    // different subset of the day's games), so they agree to the solver's step tolerance
    // (1e-7 in μ) rather than bit for bit — and exactly at display resolution.
    // The win top-up (held) is the one path-dependent part: which of an evening's wins came
    // in under par depends on the order they were logged. The fit underneath is not.
    const base = computeStandings(bigPlayers, ms), other = computeStandings(bigPlayers, flipped);
    for (const p of base.all) {
      expect(Math.abs(other.st[p.id].mu - p.mu)).toBeLessThan(1e-6);
      expect(other.st[p.id].rating - other.st[p.id].held).toBe(p.rating - p.held);
    }
  });

  it("starts founders on 800 and late joiners on the fitted late-joiner mean of the day they arrived", () => {
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const founders = foundersOf(toGames(ms));
    expect([...founders].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    for (const id of founders) expect(cs.st[id].hist[0].r).toBe(START);
    for (const id of ["g", "h", "i"]) {
      expect(founders.has(id)).toBe(false);
      const p = cs.st[id];
      const k = p.matches[0].idx;
      // Their baseline is the late-joiner mean as it stood BEFORE their first game (the
      // final cs.late has moved on since), and the ledger's previous snapshot holds it.
      expect(k).toBeGreaterThan(0);
      expect(p.hist[0].r).toBe(disp(cs.ledger.snaps[k - 1].late));
      expect(p.matches[0].ratingBefore).toBe(p.hist[0].r);
    }
    // g is the very first late joiner, so nothing had yet pulled the mean off the founders'
    // prior; h and i arrive after g has been placed well below the pack, and start lower.
    expect(cs.st["g"].hist[0].r).toBe(START);
    expect(cs.st["h"].hist[0].r).not.toBe(START);
    expect(cs.st["i"].hist[0].r).not.toBe(START);
    expect(cs.late).not.toBe(MODEL.MU0);
    // A player who has never played is shown on today's late-joiner mean.
    expect(cs.st["z"].rating).toBe(disp(cs.late));
    expect(cs.st["z"].hist).toEqual([{ i: 0, r: disp(cs.late), t: 0 }]);
    // A league with no late joiners keeps the mean on the prior.
    expect(computeStandings(players, history()).late).toBe(MODEL.MU0);
  });

  it("rates two players with identical evidence identically, however their games are interleaved", () => {
    // Volume-bias guard. Duplicating games is NOT a fair test (three copies of a result are
    // genuinely more information than one), so this is a mirror instead: x and y each play
    // the same eight games — same partner, same opponents, same score, same day — as two
    // separate matches. Relabelling x↔y maps the match list onto itself, so the posterior is
    // symmetric in them and its unique maximum has skill_x = skill_y. Any gap is solver
    // tolerance, and it has to be invisible at display resolution.
    const roster: LeaguePlayer[] = ["x", "y", "p", "q", "r", "s"].map((id) => ({ id, name: id.toUpperCase(), color: "#fff", active: true }));
    const script: [string, [string, string], number, number][] = [
      ["p", ["q", "r"], 21, 15], ["q", ["r", "s"], 17, 21], ["s", ["p", "q"], 21, 19], ["r", ["p", "s"], 21, 12],
      ["p", ["r", "s"], 14, 21], ["q", ["p", "s"], 21, 18], ["r", ["q", "s"], 21, 16], ["s", ["q", "r"], 21, 20],
    ];
    const ms: LeagueMatch[] = [];
    script.forEach(([partner, opps, sa, sb], i) => {
      ms.push(match(`x${i}`, ["x", partner], opps, sa, sb, T0 + i * DAY));
      ms.push(match(`y${i}`, ["y", partner], opps, sa, sb, T0 + i * DAY + HOUR));
    });
    const cs = computeStandings(roster, ms);
    expect(cs.st["x"].games).toBe(8);
    expect(cs.st["y"].games).toBe(8);
    expect(Math.abs(cs.st["x"].mu - cs.st["y"].mu)).toBeLessThan(1e-6);
    // Only the fit is symmetric: the win top-up depends on which of an evening's identical
    // wins was logged first, so compare the ratings without it.
    expect(cs.st["x"].rating - cs.st["x"].held).toBe(cs.st["y"].rating - cs.st["y"].held);
  });

  it("pays a bigger winning margin more", () => {
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const at = cs.lastMatchAt + DAY;
    const narrow = computeStandings(bigPlayers, [...ms, match("x", ["a", "b"], ["g", "h"], 21, 19, at)]);
    const wide = computeStandings(bigPlayers, [...ms, match("x", ["a", "b"], ["g", "h"], 21, 7, at)]);
    // Both may be under a rout's par, but the floor grows with the margin, so the ladder
    // still tells them apart, and so does the fit underneath.
    for (const id of ["a", "b"]) {
      expect(wide.st[id].mu).toBeGreaterThan(narrow.st[id].mu);
      expect(wide.st[id].rating).toBeGreaterThan(narrow.st[id].rating);
    }
    for (const id of ["g", "h"]) expect(wide.st[id].rating).toBeLessThan(narrow.st[id].rating);
  });

  it("pays a heavy favourite only the win minimum for winning too narrowly", () => {
    // a&b have flattened g&h all season; par is a rout. Scraping a 22–20 is well below it.
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const after = computeStandings(bigPlayers, [...ms, match("fav", ["a", "b"], ["g", "h"], 22, 20, cs.lastMatchAt + DAY)]);
    for (const id of ["a", "b"]) {
      const e = after.st[id].matches[after.st[id].matches.length - 1];
      expect(e.id).toBe("fav");
      expect(e.won).toBe(true);
      expect(e.winProb).toBeGreaterThan(0.9);
      expect(e.expShare).toBeGreaterThan(e.pointShare);
      // The fit drops them (that's what keeps the odds honest); the ladder pays the minimum.
      expect(after.st[id].mu).toBeLessThan(cs.st[id].mu);
      expect(e.delta - e.held).toBeLessThan(0);
      expect(e.delta).toBe(WIN_MIN);
      expect(after.st[id].rating).toBe(cs.st[id].rating + WIN_MIN);
      expect(explainDelta(e).underPar).toBe(true);
    }
    // ...and the losers, having beaten par, come out ahead of where they went in.
    for (const id of ["g", "h"]) {
      const e = after.st[id].matches[after.st[id].matches.length - 1];
      expect(e.won).toBe(false);
      expect(e.delta).toBeGreaterThan(0);
    }
  });

  it("converges to the same fit warm or cold", () => {
    const games = toGames(bigHistory());
    const cold = fitSkills(games);
    const warmFromFit = fitSkills(games, fitSkills(games.slice(0, -1)));
    const warmFromSnap = fitSkills(games, snapshotOf(fitSkills(games.slice(0, -1))));
    expect(warmFromFit.keys).toEqual(cold.keys);
    expect(warmFromSnap.keys).toEqual(cold.keys);
    for (let i = 0; i < cold.x.length; i++) {
      expect(Math.abs(warmFromFit.x[i] - cold.x[i])).toBeLessThan(1e-6);
      expect(Math.abs(warmFromSnap.x[i] - cold.x[i])).toBeLessThan(1e-6);
    }
    expect(Math.abs(warmFromFit.late - cold.late)).toBeLessThan(1e-6);
    expect(warmFromFit.iterations).toBeLessThanOrEqual(cold.iterations);
    expect(cold.converged && warmFromFit.converged && warmFromSnap.converged).toBe(true);
  });

  it("can score a lopsided pair below its sum (GAP), and the plain sum is GAP 0", () => {
    const gap = { ...RATING_MODEL, GAP: 0.3 };
    // Same total, one strong and one weak against two in the middle.
    expect(teamSkill(30, 20)).toBe(teamSkill(25, 25));
    expect(expectedShare(30, 20, 25, 25)).toBe(0.5);
    expect(teamSkill(30, 20, gap)).toBeLessThan(teamSkill(25, 25, gap));
    expect(expectedShare(30, 20, 25, 25, gap)).toBeLessThan(0.5);
    // Order within a pair doesn't matter, the two sides still mirror, and level partners pay nothing.
    expect(teamSkill(20, 30, gap)).toBe(teamSkill(30, 20, gap));
    expect(expectedShare(30, 20, 25, 25, gap) + expectedShare(25, 25, 30, 20, gap)).toBeCloseTo(1, 12);
    expect(teamSkill(25, 25, gap)).toBe(50);
    // At GAP g the weaker partner counts for (1+g)/2 once they're well apart.
    expect(teamSkill(35, 15, gap)).toBeCloseTo(0.65 * 2 * 15 + 0.35 * 2 * 35 + 0.3 * 0.5, 2);
  });

  it("lets the backtest build the ladder under another model, never reusing a ledger across models", () => {
    const ms = bigHistory();
    const base = computeStandings(bigPlayers, ms);
    const same = computeStandings(bigPlayers, ms, { model: { ...RATING_MODEL } });
    const gap = computeStandings(bigPlayers, ms, { model: { ...RATING_MODEL, GAP: 0.3 } });
    // The app's ledger is ignored under another model: otherwise this would just be `base`.
    const gapLed = computeStandings(bigPlayers, ms, { model: { ...RATING_MODEL, GAP: 0.3 }, ledger: base.ledger });
    // ...and the other way round: a ledger built under GAP 0.3 is ignored by the app's model.
    const backLed = computeStandings(bigPlayers, ms, { ledger: gap.ledger });
    expect(gap.ledger.model).toBe(JSON.stringify({ ...RATING_MODEL, GAP: 0.3 }));
    expect(base.ledger.model).toBeUndefined();
    for (const p of base.played) {
      expect(same.st[p.id].rating).toBe(p.rating);
      expect(gapLed.st[p.id].rating).toBe(gap.st[p.id].rating);
      expect(backLed.st[p.id].rating).toBe(p.rating);
      expect(explainRating(gap.st[p.id]).rating).toBe(gap.st[p.id].rating);
    }
    expect(base.played.some((p) => gap.st[p.id].rating !== p.rating)).toBe(true);
  });

  it("fits the posterior that expectedShare defines, with or without a GAP", () => {
    // One night, all founders: the posterior is a prior per player plus each game's points under
    // expectedShare. The fit has to sit flat on it, so the fit and the odds can't drift onto
    // different team maths.
    const ids = ["p", "q", "r", "s", "t", "u"];
    const ms: LeagueMatch[] = [
      match("n1", ["p", "q"], ["r", "s"], 21, 12, T0),
      match("n2", ["p", "r"], ["t", "u"], 21, 17, T0 + HOUR),
      match("n3", ["q", "u"], ["s", "t"], 15, 21, T0 + 2 * HOUR),
      match("n4", ["p", "u"], ["q", "r"], 19, 21, T0 + 3 * HOUR),
      match("n5", ["s", "t"], ["p", "q"], 21, 18, T0 + 4 * HOUR),
    ];
    for (const GAP of [0, 0.3]) {
      const m = { ...RATING_MODEL, GAP };
      const fit = fitSkills(toGames(ms), undefined, m);
      expect(fit.converged).toBe(true);
      const posterior = (v: Record<string, number>) => {
        let f = 0;
        for (const id of ids) f -= (v[id] - m.MU0) ** 2 / (2 * m.S0 * m.S0);
        for (const g of ms) {
          const p = expectedShare(v[g.teamA[0]], v[g.teamA[1]], v[g.teamB[0]], v[g.teamB[1]], m);
          f += (g.scoreA * Math.log(p) + g.scoreB * Math.log(1 - p)) / m.RHO;
        }
        return f;
      };
      const x = Object.fromEntries(ids.map((id) => [id, fit.x[fit.last[id]]]));
      const h = 1e-4;
      for (const id of ids) {
        const slope = (posterior({ ...x, [id]: x[id] + h }) - posterior({ ...x, [id]: x[id] - h })) / (2 * h);
        expect(Math.abs(slope)).toBeLessThan(1e-5);
      }
    }
  });

  it("splits a level pair once the GAP is big enough, which is why it stays 0", () => {
    // c & d beat a & b twice on one night. a and b have identical records, so they belong level,
    // and at GAP 0 every start comes back there. With a GAP, pulling them apart makes their team
    // weaker on paper, which explains the losses better. Past roughly 20 ÷ (rating points the pair
    // sits below the start), ~0.18 for this pair, a start nudged 0.01 μ towards a runs off to one
    // of two mirror-image fits. Ratings would then hang on fitting order.
    const ms = [match("s1", ["a", "b"], ["c", "d"], 9, 21, T0), match("s2", ["a", "b"], ["c", "d"], 11, 21, T0 + HOUR)];
    for (const GAP of [0, 0.3]) {
      const m = { ...RATING_MODEL, GAP };
      const cold = fitSkills(toGames(ms), undefined, m);
      expect(Math.abs(cold.x[cold.last.a] - cold.x[cold.last.b])).toBeLessThan(1e-9);
      const snap = snapshotOf(cold);
      const nudged = fitSkills(toGames(ms), { ...snap, skill: { ...snap.skill, a: snap.skill.a + 0.01 } }, m);
      const split = nudged.x[nudged.last.a] - nudged.x[nudged.last.b];
      if (GAP === 0) expect(Math.abs(split)).toBeLessThan(1e-6);
      else expect(split).toBeGreaterThan(0.5);
    }
  });
});

describe("ledger", () => {
  it("signs every match with its id, score and time, in play order", () => {
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, [...ms].reverse());
    const sorted = [...ms].sort((a, b) => a.order - b.order);
    expect(cs.ledger.sigs).toEqual(sorted.map(matchSig));
    expect(cs.ledger.snaps.length).toBe(cs.count);
    expect(matchSig(ms[0])).toBe(`${ms[0].id}:${ms[0].scoreA}:${ms[0].scoreB}:${ms[0].order}`);
  });

  it("reproduces a cold compute from its own ledger without refitting anything", () => {
    const ms = bigHistory();
    const cold = computeStandings(bigPlayers, ms);
    const warm = computeStandings(bigPlayers, ms, { ledger: cold.ledger });
    for (const p of cold.all) {
      expect(warm.st[p.id].mu).toBe(p.mu);
      expect(warm.st[p.id].rating).toBe(p.rating);
      expect(warm.st[p.id].rank).toBe(p.rank);
      expect(warm.st[p.id].matches).toEqual(p.matches);
      expect(warm.st[p.id].ripples).toEqual(p.ripples);
    }
    // Every prefix was reused as-is: the snapshots are the same objects, not recomputed copies.
    warm.ledger.snaps.forEach((s, i) => expect(s).toBe(cold.ledger.snaps[i]));
    expect(warm.late).toBe(cold.late);
  });

  it("extends a ledger by one match and still matches the cold compute", () => {
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const extra = match("extra", ["a", "h"], ["b", "g"], 21, 17, cs.lastMatchAt + DAY);
    const extended = computeStandings(bigPlayers, [...ms, extra], { ledger: cs.ledger });
    const cold = computeStandings(bigPlayers, [...ms, extra]);
    for (const p of cold.all) {
      expect(extended.st[p.id].rating).toBe(p.rating);
      expect(extended.st[p.id].rank).toBe(p.rank);
      expect(Math.abs(extended.st[p.id].mu - p.mu)).toBeLessThan(1e-6);
    }
    // Only the new match was fitted; the old prefix is reused by identity.
    cs.ledger.snaps.forEach((s, i) => expect(extended.ledger.snaps[i]).toBe(s));
    expect(extended.ledger.snaps.length).toBe(cs.ledger.snaps.length + 1);
    expect(extended.ledger.sigs[extended.ledger.sigs.length - 1]).toBe(matchSig(extra));
  });

  it("refuses to trust a stale ledger once a score has been edited", () => {
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const at = ms.findIndex((m) => m.id === "g20");
    const edited = ms.map((m) => (m.id === "g20" ? { ...m, scoreA: m.scoreB, scoreB: m.scoreA } : m));
    const stale = computeStandings(bigPlayers, edited, { ledger: cs.ledger });
    const cold = computeStandings(bigPlayers, edited);
    for (const p of cold.all) {
      expect(stale.st[p.id].rating).toBe(p.rating);
      expect(stale.st[p.id].rank).toBe(p.rank);
      // Refitted from the last good snapshot rather than from scratch: same answer to
      // well inside solver tolerance, identical once rounded to a rating.
      expect(Math.abs(stale.st[p.id].mu - p.mu)).toBeLessThan(1e-9);
    }
    // The edit actually changed something, so "equal to cold" is not "equal to the old ledger".
    expect(cold.all.some((p) => p.rating !== cs.st[p.id].rating)).toBe(true);
    // Everything before the edit is still reusable; from the edit onwards it is refitted.
    for (let i = 0; i < at; i++) expect(stale.ledger.snaps[i]).toBe(cs.ledger.snaps[i]);
    for (let i = at; i < stale.ledger.snaps.length; i++) expect(stale.ledger.snaps[i]).not.toBe(cs.ledger.snaps[i]);
    expect(stale.ledger.sigs[at]).not.toBe(cs.ledger.sigs[at]);
  });

  it("pays every win at least its floor, and keeps the top-up on top of the fit", () => {
    for (const cs of [computeStandings(players, history()), computeStandings(bigPlayers, bigHistory())]) {
      for (const p of cs.all) {
        expect(p.rating).toBe(disp(p.mu) + p.held);
        expect(p.held).toBe(p.matches.reduce((n, m) => n + m.held, 0));
        for (const m of p.matches) {
          expect(m.held).toBeGreaterThanOrEqual(0);
          if (m.won) {
            expect(m.delta).toBeGreaterThanOrEqual(winFloor(m.gf, m.ga));
            // Topped up only when the fit alone paid less than the floor, and only to it.
            if (m.held > 0) expect(m.delta).toBe(winFloor(m.gf, m.ga));
          } else expect(m.held).toBe(0);
        }
      }
    }
    // The fixture has to actually exercise the top-up.
    expect(computeStandings(bigPlayers, bigHistory()).all.some((p) => p.held > 0)).toBe(true);
  });

  it("starts the win floor at WIN_MIN for a win by two and grows it with the margin", () => {
    expect(WIN_MIN).toBe(2);
    expect(winFloor(21, 19)).toBe(WIN_MIN);
    expect(winFloor(25, 23)).toBe(WIN_MIN); // deuce: still a win by two
    expect(winFloor(21, 20)).toBe(WIN_MIN); // never below the minimum, even off a bad score
    for (let ga = 19; ga > 0; ga--) expect(winFloor(21, ga - 1)).toBeGreaterThanOrEqual(winFloor(21, ga));
    expect(winFloor(21, 0)).toBeGreaterThan(winFloor(21, 12));
    expect(winFloor(21, 12)).toBeGreaterThan(winFloor(21, 19));
  });

  it("pays an under-par win more the bigger its margin", () => {
    // a&b have flattened g&h all season, so par is a rout and every one of these is under it.
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const at = cs.lastMatchAt + DAY;
    const pays = [19, 16, 13].map((ga) => {
      const after = computeStandings(bigPlayers, [...ms, match("w", ["a", "b"], ["g", "h"], 21, ga, at)]);
      const e = after.st["a"].matches[after.st["a"].matches.length - 1];
      expect(explainDelta(e).underPar).toBe(true);
      return e.delta;
    });
    expect(pays[0]).toBe(WIN_MIN);
    expect(pays[1]).toBeGreaterThan(pays[0]);
    expect(pays[2]).toBeGreaterThan(pays[1]);
  });

  it("reads rank ranges off the same number the ladder ranks by", () => {
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const held = Object.fromEntries(cs.all.map((p) => [p.id, p.held]));
    const bottom = cs.ranked[cs.ranked.length - 1];
    // A top-up big enough to lift the bottom player past everyone puts their range at the top.
    const rr = rankRanges(bigPlayers, ms, 40, undefined, { ...held, [bottom.id]: 100_000 });
    expect(rr[bottom.id]).toEqual([1, 1]);
    expect(rankRanges(bigPlayers, ms, 40, undefined, {})).toEqual(rankRanges(bigPlayers, ms, 40));
  });

  it("passes server-computed rank ranges straight through to the players", () => {
    const ms = bigHistory();
    const rr = rankRanges(bigPlayers, ms, 40);
    const cs = computeStandings(bigPlayers, ms, { rankRanges: rr });
    for (const p of cs.ranked) expect(p.rankRange).toEqual(rr[p.id]);
    for (const p of [...cs.placing, ...cs.unranked]) expect(p.rankRange).toBeUndefined();
    for (const p of computeStandings(bigPlayers, ms).all) expect(p.rankRange).toBeUndefined();
  });
});

describe("placement", () => {
  it("hands out ranks only from PROV_N games, and files everyone else as placing or unranked", () => {
    expect(PROV_N).toBe(8);
    const cs = computeStandings(bigPlayers, bigHistory());
    for (const p of cs.all) {
      if (p.games === 0) {
        expect(p.provisional).toBe(false);
        expect(p.rank).toBeUndefined();
        expect(cs.unranked).toContain(p);
        expect(cs.played).not.toContain(p);
      } else if (p.games < PROV_N) {
        expect(p.provisional).toBe(true);
        expect(p.rank).toBeUndefined();
        expect(cs.placing).toContain(p);
        expect(cs.ranked).not.toContain(p);
      } else {
        expect(p.provisional).toBe(false);
        expect(p.rank).toBeGreaterThanOrEqual(1);
        expect(cs.ranked).toContain(p);
        expect(cs.placing).not.toContain(p);
      }
    }
    expect(cs.ranked.map((p) => p.id).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(cs.placing.map((p) => p.id)).toEqual(["i"]);
    expect(cs.unranked.map((p) => p.id)).toEqual(["z"]);
    expect(cs.played).toEqual([...cs.ranked, ...cs.placing]);
    expect(cs.played.length + cs.unranked.length).toBe(cs.all.length);
  });

  it("numbers ranks 1..n contiguously by rating, with placing players sorted but unnumbered", () => {
    const cs = computeStandings(bigPlayers, bigHistory());
    cs.ranked.forEach((p, i) => {
      expect(p.rank).toBe(i + 1);
      if (i) expect(p.rating).toBeLessThanOrEqual(cs.ranked[i - 1].rating);
    });
    for (let i = 1; i < cs.placing.length; i++) expect(cs.placing[i].rating).toBeLessThanOrEqual(cs.placing[i - 1].rating);
  });

  it("crosses the line at exactly eight games", () => {
    const lineups: [[string, string], [string, string]][] = [[["a", "b"], ["c", "d"]], [["a", "c"], ["b", "d"]], [["a", "d"], ["b", "c"]]];
    const ms = Array.from({ length: PROV_N }, (_, i) => match(`n${i}`, lineups[i % 3][0], lineups[i % 3][1], 21, 10 + i, (i + 1) * DAY));
    const seven = computeStandings(players, ms.slice(0, PROV_N - 1));
    expect(seven.ranked).toEqual([]);
    expect(seven.placing.length).toBe(4);
    expect(seven.all.every((p) => p.provisional && p.rank === undefined)).toBe(true);
    const eight = computeStandings(players, ms);
    expect(eight.placing).toEqual([]);
    expect(eight.ranked.length).toBe(4);
    expect(eight.all.every((p) => !p.provisional && p.rank !== undefined)).toBe(true);
  });

  it("brackets every placed player's rank, deterministically, and pins the clear #1", () => {
    const ms = bigHistory();
    const cs = computeStandings(bigPlayers, ms);
    const rr = rankRanges(bigPlayers, ms, 60);
    const placed = cs.ranked.map((p) => p.id);
    expect(Object.keys(rr).sort()).toEqual([...placed].sort());
    for (const id of placed) {
      const [lo, hi] = rr[id];
      expect(Number.isInteger(lo) && Number.isInteger(hi)).toBe(true);
      expect(lo).toBeGreaterThanOrEqual(1);
      expect(lo).toBeLessThanOrEqual(hi);
      expect(hi).toBeLessThanOrEqual(placed.length);
    }
    expect(rr["i"]).toBeUndefined(); // placing
    expect(rr["z"]).toBeUndefined(); // never played
    expect(rankRanges(bigPlayers, ms, 60)).toEqual(rr); // same seed, same answer
    expect(rankRanges(bigPlayers, ms, 60, 7)).toEqual(rankRanges(bigPlayers, ms, 60, 7));
    // a has beaten everyone all season: no resample of the history puts anyone above them.
    expect(cs.ranked[0].id).toBe("a");
    expect(rr["a"][0]).toBe(1);
  });

  it("gives no rank ranges to a league with fewer than two placed players", () => {
    expect(rankRanges(players, [])).toEqual({});
    expect(rankRanges(players, history().slice(0, 3))).toEqual({});
    expect(rankRanges(players, [...history()].reverse())).toEqual(rankRanges(players, history()));
  });
});

describe("planText", () => {
  const nameOf = (id: string) => ({ t: "Tim", bl: "Ben L", w: "Will", e: "Euan", s: "Sarah" })[id] ?? "?";

  it("formats one game per line as 'X & Y vs. Z & W'", () => {
    const txt = planText(
      [{ roundNo: 0, out: [], games: [{ courtNo: 0, teamA: ["t", "bl"], teamB: ["w", "e"] }] }],
      nameOf,
    );
    expect(txt).toBe("🏐 *TONIGHT* · 1 game\n\n*Round 1*\nTim & Ben L vs. Will & Euan");
  });

  it("lists whoever sits, and the score of anything already played", () => {
    const txt = planText(
      [
        { roundNo: 0, out: ["s"], games: [{ courtNo: 0, teamA: ["t", "bl"], teamB: ["w", "e"], result: "21–15" }] },
        { roundNo: 1, out: ["t"], games: [{ courtNo: 0, teamA: ["s", "bl"], teamB: ["w", "e"] }] },
      ],
      nameOf,
    );
    expect(txt.split("\n\n")).toEqual([
      "🏐 *TONIGHT* · 2 games",
      "*Round 1*\nTim & Ben L vs. Will & Euan ✅ 21–15\n🪑 Sarah",
      "*Round 2*\nSarah & Ben L vs. Will & Euan\n🪑 Tim",
    ]);
  });

  it("labels courts only when more than one game runs at a time", () => {
    const one = planText([{ roundNo: 0, out: [], games: [{ courtNo: 0, teamA: ["t", "bl"], teamB: ["w", "e"] }] }], nameOf);
    expect(one).not.toContain("Court");
    const two = planText(
      [{
        roundNo: 0,
        out: [],
        games: [
          { courtNo: 0, teamA: ["t", "bl"], teamB: ["w", "e"] },
          { courtNo: 1, teamA: ["s", "t"], teamB: ["w", "bl"] },
        ],
      }],
      nameOf,
    );
    expect(two).toContain("🏐 *TONIGHT* · 1 round, 2 games");
    expect(two).toContain("Court 1 — Tim & Ben L vs. Will & Euan");
    expect(two).toContain("Court 2 — Sarah & Tim vs. Will & Ben L");
  });
});

// ---- seasons ----
// The big fixture plays six games a night from 12:00 UTC on days 1–8, then i's three games two
// days later. Season 2 starts the evening before day 5, so both seasons have a real history.
const SEASON2 = T0 + 4 * DAY - HOUR;
const twoSeasons = seasonsFrom([SEASON2]);

describe("seasons", () => {
  const ms = bigHistory();

  it("splits the league into back-to-back windows, the last one still open", () => {
    expect(twoSeasons).toEqual([{ n: 1, start: 0, end: SEASON2, to: 21 }, { n: 2, start: SEASON2, end: null, to: 21 }]);
    expect(currentSeason(twoSeasons).n).toBe(2);
    // No rows yet: the whole league is Season 1, and it's the one in progress.
    expect(seasonsFrom([])).toEqual([{ n: 1, start: 0, end: null, to: FIRST_SEASON_TO }]);
    // Rows can arrive in any order.
    expect(seasonsFrom([SEASON2 + DAY, SEASON2]).map((s) => s.start)).toEqual([0, SEASON2, SEASON2 + DAY]);
  });

  it("starts a season at midnight London time, summer or winter", () => {
    expect(new Date(dayStart("2026-10-06")).toISOString()).toBe("2026-10-05T23:00:00.000Z"); // BST
    expect(new Date(dayStart("2026-12-01")).toISOString()).toBe("2026-12-01T00:00:00.000Z"); // GMT
    expect(new Date(dayStart("2027-03-28")).toISOString()).toBe("2027-03-28T00:00:00.000Z"); // clocks go forward at 01:00
    expect(new Date(dayStart("2026-10-25")).toISOString()).toBe("2026-10-24T23:00:00.000Z"); // clocks go back at 02:00
    expect(dayKey(dayStart("2026-10-06"))).toBe("2026-10-06");
    expect(dayKey(dayStart("2026-10-06") - 1)).toBe("2026-10-05");
    expect(() => dayStart("6 Oct")).toThrow();
    expect(() => dayStart("2026-02-30")).toThrow(); // would otherwise roll into March
  });

  it("keeps SEASON_STARTS to real days in order, so a typo can't ship", () => {
    const ts = SEASON_STARTS.map((d) => dayStart(d.day));
    ts.forEach((t, i) => i && expect(t).toBeGreaterThan(ts[i - 1]));
    // …and a sensible game length: an integer, short enough to play, long enough to deuce.
    for (const d of SEASON_STARTS) expect(Number.isInteger(d.to) && d.to >= 11 && d.to <= 25).toBe(true);
  });

  it("only opens a season once its day has arrived, so one can be merged ahead of time", () => {
    const days = [{ day: "2026-10-06", to: 17 }, { day: "2027-01-05", to: 21 }];
    expect(seasonsAt(dayStart("2026-10-06") - 1, days)).toHaveLength(1);
    expect(seasonsAt(dayStart("2026-10-06"), days).map((x) => x.n)).toEqual([1, 2]);
    expect(currentSeason(seasonsAt(dayStart("2026-12-25"), days))).toEqual({ n: 2, start: dayStart("2026-10-06"), end: null, to: 17 });
    expect(seasonsAt(dayStart("2027-01-05"), days)).toHaveLength(3);
  });

  it("puts every game in exactly one season, and a game on the boundary in the new one", () => {
    const s1 = scopeMatches(ms, 1, twoSeasons), s2 = scopeMatches(ms, 2, twoSeasons);
    expect(s1.length).toBeGreaterThan(PROV_N);
    expect(s2.length).toBeGreaterThan(PROV_N);
    expect(s1.length + s2.length).toBe(ms.length);
    expect(new Set([...s1, ...s2].map((m) => m.id)).size).toBe(ms.length);
    expect(scopeMatches(ms, "all", twoSeasons)).toHaveLength(ms.length);
    expect(seasonAt(twoSeasons, SEASON2).n).toBe(2);
    expect(seasonAt(twoSeasons, SEASON2 - 1).n).toBe(1);
    expect(inScope(3, twoSeasons, SEASON2 + DAY)).toBe(false); // no such season
    expect(scopeKey("all")).toBe("all");
    expect(scopeKey(2)).toBe("s2");
  });

  it("rates the opening season exactly as All time stood when it ended, without fitting anything", () => {
    const all = computeStandings(bigPlayers, ms);
    const s1 = computeStandings(bigPlayers, scopeMatches(ms, 1, twoSeasons), { ledger: all.ledger });
    const then = computeStandings(bigPlayers, ms.filter((m) => m.order < SEASON2));
    for (const p of then.all) {
      expect(s1.st[p.id].rating).toBe(p.rating);
      expect(s1.st[p.id].rank).toBe(p.rank);
    }
    // Its games are a prefix of All time's, so every snapshot is All time's own.
    expect(s1.ledger.snaps.length).toBeGreaterThan(0);
    s1.ledger.snaps.forEach((snap, i) => expect(snap).toBe(all.ledger.snaps[i]));
  });

  it("starts a later season afresh: everyone back on the start rating, placement to play, the last season forgotten", () => {
    const s2ms = scopeMatches(ms, 2, twoSeasons);
    expect(isFresh(2, twoSeasons)).toBe(true);
    expect(isFresh(1, twoSeasons)).toBe(false); // the opening season keeps the league's own priors
    const s2 = computeStandings(bigPlayers, s2ms, { fresh: true });
    const all = computeStandings(bigPlayers, ms);
    // Everyone starts it on START, whatever they'd reached before — including anyone who missed
    // the first night, who in the league proper would start on the fitted late-joiner prior.
    const openers = foundersOf(toGames(s2ms));
    const missedNightOne = s2.played.filter((p) => !openers.has(p.id));
    expect(missedNightOne.length).toBeGreaterThan(0);
    for (const p of s2.played) expect(p.hist[0].r).toBe(START);
    // (Without `fresh` they'd start on the fitted late-joiner mean, which is a different number.)
    expect(s2.late).toBe(MODEL.MU0);
    expect(computeStandings(bigPlayers, s2ms).late).not.toBe(MODEL.MU0);
    // So a season score — rating minus START — is exactly what their games did to them.
    for (const p of s2.played) {
      const parts = explainRating(p);
      expect(p.rating - START).toBe(parts.fromWins + parts.fromLosses + parts.revalued);
    }
    // Games count from zero again, and placement goes by this season's games alone.
    for (const p of s2.played) {
      expect(p.games).toBe(s2ms.filter((m) => [...m.teamA, ...m.teamB].includes(p.id)).length);
      expect(p.provisional).toBe(p.games < PROV_N);
    }
    // After the season's first night, a veteran with dozens of games is placing like anyone else.
    const firstNight = s2ms.filter((m) => dayKey(m.order) === dayKey(Math.min(...s2ms.map((x) => x.order))));
    const vet = computeStandings(bigPlayers, firstNight).played.find((p) => all.st[p.id].games >= 2 * PROV_N);
    expect(vet).toBeDefined();
    expect(vet!.provisional).toBe(true);
    expect(vet!.rank).toBeUndefined();
    // Last season's results don't reach into this one: flip every one of them and nothing moves.
    const flipped = ms.map((m) => (m.order < SEASON2 ? { ...m, scoreA: m.scoreB, scoreB: m.scoreA } : m));
    const s2again = computeStandings(bigPlayers, scopeMatches(flipped, 2, twoSeasons), { fresh: true });
    for (const p of s2.all) expect(s2again.st[p.id].rating).toBe(p.rating);
  });
});

describe("packed ledger", () => {
  const ms = bigHistory();
  const cs = computeStandings(bigPlayers, ms);

  it("survives JSON exactly and reproduces the standings bit for bit, without refitting", () => {
    const back = unpackLedger(JSON.parse(JSON.stringify(packLedger(cs.ledger))));
    expect(back).toEqual(cs.ledger);
    back.snaps.forEach((snap, i) => {
      for (const id of Object.keys(cs.ledger.snaps[i].skill)) expect(snap.skill[id]).toBe(cs.ledger.snaps[i].skill[id]);
      expect(snap.late).toBe(cs.ledger.snaps[i].late);
    });
    const again = computeStandings(bigPlayers, ms, { ledger: back });
    for (const p of cs.all) {
      expect(again.st[p.id].rating).toBe(p.rating);
      expect(again.st[p.id].matches).toEqual(p.matches);
      expect(again.st[p.id].ripples).toEqual(p.ripples);
    }
    again.ledger.snaps.forEach((snap, i) => expect(snap).toBe(back.snaps[i]));
  });

  it("writes each player id once rather than once per game, which halves a real ledger", () => {
    // Real ids are UUIDs, and they're most of what an unpacked snapshot weighs.
    const uuid = (id: string) => `${id}0000000-0000-4000-8000-000000000000`.slice(0, 36);
    const P = bigPlayers.map((p) => ({ ...p, id: uuid(p.id) }));
    const M = ms.map((m) => ({ ...m, teamA: m.teamA.map(uuid), teamB: m.teamB.map(uuid) }));
    const ledger = computeStandings(P, M).ledger;
    const packed = packLedger(ledger);
    expect(packed.ids).toHaveLength(new Set(packed.ids).size);
    expect(JSON.stringify(packed).split(packed.ids[0]).length - 1).toBe(1);
    expect(JSON.stringify(packed).length).toBeLessThan(0.6 * JSON.stringify(ledger).length);
  });

  it("packs an empty league", () => {
    const empty: Ledger = { sigs: [], snaps: [] };
    expect(unpackLedger(packLedger(empty))).toEqual(empty);
  });
});

describe("ledgerStillFits", () => {
  const ms = bigHistory();
  const cs = computeStandings(bigPlayers, ms);

  it("trusts a ledger this model built", () => {
    expect(ledgerStillFits(bigPlayers, ms, cs.ledger)).toBe(true);
    expect(ledgerStillFits(bigPlayers, [], { sigs: [], snaps: [] })).toBe(true);
  });

  it("refuses one built under different maths", () => {
    const games = toGames(ms);
    const other = { ...RATING_MODEL, DRIFT: RATING_MODEL.DRIFT * 2 };
    const snaps = games.map((_, i) => snapshotOf(fitSkills(games.slice(0, i + 1), undefined, other)));
    expect(ledgerStillFits(bigPlayers, ms, { sigs: cs.ledger.sigs, snaps })).toBe(false);
  });

  it("doesn't call a ledger with nothing in common with the games a model change", () => {
    const edited = ms.map((m) => (m.id === "g0" ? { ...m, scoreA: m.scoreB, scoreB: m.scoreA } : m));
    expect(ledgerStillFits(bigPlayers, edited, cs.ledger)).toBe(true);
  });

  it("checks the part that still matches the games, so a stale tail isn't mistaken for a bad model", () => {
    const edited = ms.map((m) => (m.id === "g40" ? { ...m, scoreA: m.scoreB, scoreB: m.scoreA } : m));
    expect(ledgerStillFits(bigPlayers, edited, cs.ledger)).toBe(true);
  });
});

describe("rating cache", () => {
  const ms = bigHistory();
  const build = (matches: LeagueMatch[], prev = new Map<string, CachedScope>(), seasons = twoSeasons) =>
    buildRatings(bigPlayers, matches, seasons, prev);
  const first = build(ms);

  it("builds every view, and what the phones rebuild from it matches a cold compute", () => {
    expect(Object.keys(first.ratings)).toEqual(["all", "s1", "s2"]);
    expect(first.changed).toEqual(["all", "s1", "s2"]);
    // The opening season borrows All time's ledger rather than shipping a copy of it.
    expect(first.ratings.s1.ledger).toBeNull();
    expect(first.ratings.s2.ledger).not.toBeNull();
    const allLedger = unpackLedger(first.ratings.all.ledger!);
    for (const scope of ["all", 1, 2] as const) {
      const r = first.ratings[scopeKey(scope)];
      const sm = scopeMatches(ms, scope, twoSeasons);
      const view = { final: isFinal(scope, twoSeasons), fresh: isFresh(scope, twoSeasons) };
      const wire = computeStandings(bigPlayers, sm, { ledger: r.ledger ? unpackLedger(r.ledger) : allLedger, rankRanges: r.rankRanges, ...view });
      const cold = computeStandings(bigPlayers, sm, view);
      for (const p of cold.all) {
        expect(wire.st[p.id].rating).toBe(p.rating);
        expect(wire.st[p.id].rank).toBe(p.rank);
      }
      expect(Object.keys(r.rankRanges).length).toBeGreaterThan(0);
    }
  });

  it("does nothing at all when nothing has changed", () => {
    const again = build(ms, first.cache);
    expect(again.changed).toEqual([]);
    for (const [k, c] of first.cache) expect(again.cache.get(k)).toBe(c);
  });

  it("only touches the views a new game falls in, and extends rather than rebuilds them", () => {
    const last = ms.reduce((t, m) => Math.max(t, m.order), 0);
    const next = build([...ms, match("new", ["a", "h"], ["b", "g"], 21, 17, last + DAY)], first.cache);
    expect(next.changed).toEqual(["all", "s2"]);
    expect(next.cache.get("s1")).toBe(first.cache.get("s1"));
    for (const k of ["all", "s2"]) {
      const was = first.cache.get(k)!.ledger!.snaps, now = next.cache.get(k)!.ledger!.snaps;
      expect(now.length).toBe(was.length + 1);
      was.forEach((snap, i) => expect(now[i]).toBe(snap));
    }
  });

  it("reopens a finished season when one of its games is edited, and leaves the next one alone", () => {
    const edited = ms.map((m) => (m.id === "g3" ? { ...m, scoreA: m.scoreB, scoreB: m.scoreA } : m));
    const next = build(edited, first.cache);
    expect(next.changed).toEqual(["all", "s1"]);
    expect(next.cache.get("s2")).toBe(first.cache.get("s2"));
    expect(next.ratings.s1.ledger).toBeNull(); // still a prefix of All time
  });

  it("ignores anything cached under a different model, rather than building on it", () => {
    const shift = (l: Ledger | null): Ledger | null =>
      l && { sigs: l.sigs, snaps: l.snaps.map((s) => ({ late: s.late, skill: Object.fromEntries(Object.entries(s.skill).map(([id, v]) => [id, v + 3])) })) };
    const poisoned = new Map([...first.cache].map(([k, c]) => [k, { ...c, model: "an older model", ledger: shift(c.ledger) }]));
    const r = build(ms, poisoned);
    expect(r.changed).toEqual(["all", "s1", "s2"]);
    const cold = computeStandings(bigPlayers, ms);
    const all = computeStandings(bigPlayers, ms, { ledger: unpackLedger(r.ratings.all.ledger!) });
    for (const p of cold.all) expect(all.st[p.id].rating).toBe(p.rating);
    expect(r.cache.get("all")!.model).toBe(RATING_KEY);
  });

  it("shares All time's ratings outright while there's only one season", () => {
    const r = build(ms, new Map(), seasonsFrom([]));
    expect(r.ratings.s1).toEqual({ ledger: null, rankRanges: r.ratings.all.rankRanges });
  });

  it("gives a season that hasn't had a game yet nothing to fit", () => {
    const last = ms.reduce((t, m) => Math.max(t, m.order), 0);
    const r = build(ms, first.cache, seasonsFrom([SEASON2, last + DAY]));
    // Nothing to fit, and its own (empty) ledger: a later season never borrows All time's.
    expect(r.ratings.s3.rankRanges).toEqual({});
    expect(unpackLedger(r.ratings.s3.ledger!).snaps).toHaveLength(0);
    // Season 2 keeps every game but is now finished, so its table is renumbered (nobody rests in
    // a final table) — without refitting a single game.
    expect(r.changed).toEqual(["s2", "s3"]);
    first.cache.get("s2")!.ledger!.snaps.forEach((snap, i) => expect(r.cache.get("s2")!.ledger!.snaps[i]).toBe(snap));
  });

  it("fingerprints a match list by its parts, not by their concatenation", () => {
    expect(fingerprint(["ab", "c"])).not.toBe(fingerprint(["a", "bc"]));
    expect(fingerprint(["x", "y"])).toBe(fingerprint(["x", "y"]));
    expect(fingerprint([])).not.toBe(fingerprint([""]));
  });
});

describe("splitRoster", () => {
  it("offers whoever has played lately or not at all, and folds away the resting, in roster order", () => {
    const later = [...history(), match("late", ["a", "b"], ["c", "e"], 21, 15, 12 * DAY + (DORMANT_DAYS + 3) * DAY)];
    const roster = [...players, { id: "e", name: "E", color: "#fff", active: true }, { id: "new", name: "New", color: "#fff", active: true }];
    const cs = computeStandings(roster, later);
    const { regulars, others } = splitRoster(roster, cs);
    expect(regulars.map((p) => p.id)).toEqual(["a", "b", "c", "e", "new"]);
    expect(others.map((p) => p.id)).toEqual(["d"]); // last played a month before the league's last game
  });
});

describe("computeBadges in a season", () => {
  const ms = bigHistory();
  const s2 = computeStandings(bigPlayers, scopeMatches(ms, 2, twoSeasons));
  const firstNight = scopeMatches(ms, 2, twoSeasons).filter((m) => dayKey(m.order) === dayKey(SEASON2 + HOUR * 2));
  const opening = computeStandings(bigPlayers, firstNight);

  it("calls a veteran placing again 'Placing', not a rookie, and a finished season's non-placer 'Didn't place'", () => {
    const p = opening.placing[0];
    expect(computeBadges(p).find((b) => b.id === "rookie")!.label).toBe("Rookie");
    expect(computeBadges(p, { period: "this season", final: false }).find((b) => b.id === "rookie")!.label).toBe("Placing");
    expect(computeBadges(p, { period: "in Season 2", final: true }).find((b) => b.id === "rookie")!.label).toBe("Didn't place");
  });

  it("says a season's counts and peaks are the season's", () => {
    const p = s2.ranked[0];
    const view = { period: "this season", final: false };
    for (const b of computeBadges(p, view)) {
      if (b.id === "veteran" || b.id === "iron-arm") expect(b.desc).toMatch(/this season$/);
      if (b.id === "peak") expect(b.desc).toBe("Highest rating this season");
    }
    // Badge ids don't change with the view, so diffing before/after a game still works.
    expect(computeBadges(p, view).map((b) => b.id)).toEqual(computeBadges(p).map((b) => b.id));
  });
});

describe("fresh seasons never reuse All time's snapshots", () => {
  const ms = bigHistory();

  it("refits a fresh season even when its games are exactly All time's", () => {
    const all = computeStandings(bigPlayers, ms);
    const viaAll = computeStandings(bigPlayers, ms, { ledger: all.ledger, fresh: true });
    const cold = computeStandings(bigPlayers, ms, { fresh: true });
    expect(viaAll.ledger.fresh).toBe(true);
    viaAll.ledger.snaps.forEach((snap, i) => expect(snap).not.toBe(all.ledger.snaps[i]));
    for (const p of cold.all) expect(viaAll.st[p.id].rating).toBe(p.rating);
    // …and the packed form keeps the flag, so a stored season ledger can't be mistaken either.
    expect(unpackLedger(JSON.parse(JSON.stringify(packLedger(cold.ledger)))).fresh).toBe(true);
    expect(unpackLedger(packLedger(all.ledger)).fresh).toBeUndefined();
  });

  it("gives a later season its own ledger when every earlier season is empty", () => {
    const seasons = seasonsFrom([ms[0].order - DAY]); // Season 1 has no games at all
    const r = buildRatings(bigPlayers, ms, seasons, new Map());
    expect(r.ratings.s2.ledger).not.toBeNull();
    const wire = computeStandings(bigPlayers, ms, { ledger: unpackLedger(r.ratings.s2.ledger!), fresh: true });
    const cold = computeStandings(bigPlayers, ms, { fresh: true });
    for (const p of cold.all) expect(wire.st[p.id].rating).toBe(p.rating);
    // Every player started Season 2 on START — which All time's priors would not have given them.
    for (const p of wire.played) expect(p.hist[0].r).toBe(START);
  });
});

describe("games to 17", () => {
  it("Season 2 is played to 17, Season 1 was to 21, and every game takes its season's rule", () => {
    expect(SEASON_STARTS[0]).toEqual({ day: "2026-10-06", to: 17 });
    const seasons = seasonsAt(dayStart("2026-10-07"));
    expect(seasons.map((x) => x.to)).toEqual([21, 17]);
    expect(targetAt(seasons, dayStart("2026-10-06") - 1)).toBe(21);
    expect(targetAt(seasons, dayStart("2026-10-06"))).toBe(17);
  });

  it("works out the odds of a race to 17: even stays even, and a shorter game helps the underdog", () => {
    expect(gameWinProb(0.5, 17)).toBeCloseTo(0.5, 12);
    for (const p of [0.52, 0.55, 0.6]) {
      expect(gameWinProb(p, 17)).toBeGreaterThan(0.5);
      expect(gameWinProb(p, 17)).toBeLessThan(gameWinProb(p, 21));
      expect(gameWinProb(1 - p, 17)).toBeCloseTo(1 - gameWinProb(p, 17), 12);
    }
    expect(gameWinProb(0.55)).toBe(gameWinProb(0.55, 21)); // 21 stays the default
  });

  it("states par as a game to 17", () => {
    expect(parScoreline(0.6, 17)).toBe("17–11");
    expect(parScoreline(0.4, 17)).toBe("11–17");
    expect(parScoreline(0.6)).toBe("21–14");
  });

  it("accepts a game to 17 with a win by two, and nothing short of it", () => {
    expect(validWinBy2(17, 15, 17)).toBe(true);
    expect(validWinBy2(19, 17, 17)).toBe(true); // deuce
    expect(validWinBy2(17, 16, 17)).toBe(false);
    expect(validWinBy2(16, 10, 17)).toBe(false);
    expect(validWinBy2(17, 10)).toBe(false); // still 21 unless told otherwise
  });

  it("gives each game the win chance and par of its own rule, and leaves the ratings to the points", () => {
    const base = history();
    const tail = base.length - 1;
    const as21 = computeStandings(players, base);
    const as17 = computeStandings(players, base.map((m, i) => (i === tail ? { ...m, to: 17 } : m)));
    const e21 = as21.st.a.matches[as21.st.a.matches.length - 1];
    const e17 = as17.st.a.matches[as17.st.a.matches.length - 1];
    expect(e17.to).toBe(17);
    expect(e21.to).toBe(21);
    expect(e17.winProb).toBeCloseTo(gameWinProb(e17.expShare, 17), 12);
    expect(Math.abs(e17.winProb - 0.5)).toBeLessThan(Math.abs(e21.winProb - 0.5));
    expect(explainDelta(e17).par).toMatch(/17/);
    // Same scores, same fit: what a game was played to changes the odds shown, not the ratings.
    for (const p of as21.all) expect(as17.st[p.id].rating).toBe(p.rating);
  });

  it("previews a hypothetical game to 17 with a race-to-17 win chance", () => {
    const ms = history();
    const cs = computeStandings(players, ms);
    const p21 = previewMatch(players, ms, cs, { teamA: ["a", "b"], teamB: ["c", "d"], scoreA: 21, scoreB: 15 });
    const p17 = previewMatch(players, ms, cs, { teamA: ["a", "b"], teamB: ["c", "d"], scoreA: 17, scoreB: 15, to: 17 });
    expect(Math.abs(p17.winProb - 0.5)).toBeLessThanOrEqual(Math.abs(p21.winProb - 0.5));
  });
});
