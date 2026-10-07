// Demo data: a realistic-looking league so you can show friends what it looks like.
// WIPES existing matches + availability, then generates ~10 games per active player
// (valid win-by-2 scores) over the last few weeks, plus availability for 2 weeks.
//
// Local databases only (it refuses anything else): npm run db:demo
import { assertLocalDatabase } from "./local-only.mjs";
import { db } from "../src/db/index.ts";
import { players, matches, matchTeams, matchPlayers, availability } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";

const GAMES_EACH = 10;

// Deterministic PRNG so the demo looks the same each run.
let seed = 424242;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pickInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function main() {
  assertLocalDatabase();
  const roster = await db.select({ id: players.id, name: players.name }).from(players).where(eq(players.isActive, true));
  if (roster.length < 4) throw new Error("Need at least 4 active players. Run db:seed first.");
  console.log(`Generating demo for ${roster.length} players…`);

  // Clear existing matches (cascades to teams/players) + availability.
  await db.delete(matches);
  await db.delete(availability);

  const byName = Object.fromEntries(roster.map((p) => [p.name, p.id]));
  // Hidden skill spread + a couple of planted chemistries for interesting results.
  const skill = new Map();
  roster.forEach((p, i) => skill.set(p.id, 0.3 + ((i * 0.11) % 0.6)));
  const chem = (a, b) => {
    const key = [a, b].sort().join("|");
    if (byName.tim && byName.joss && key === [byName.tim, byName.joss].sort().join("|")) return 0.22;
    if (byName.benl && byName.will && key === [byName.benl, byName.will].sort().join("|")) return -0.22;
    return 0;
  };

  // A valid win-by-2 score to 21 given a target loser score.
  const score = (winnerStrong) => {
    const deuce = rnd() < 0.18; // sometimes it goes to deuce
    if (deuce) { const lo = pickInt(20, 24); return [lo + 2, lo]; }
    const lo = winnerStrong ? pickInt(6, 15) : pickInt(14, 19);
    return [21, lo];
  };

  const targetMatches = Math.round((roster.length * GAMES_EACH) / 4);
  const sessionsCount = 6;
  const perSession = Math.ceil(targetMatches / sessionsCount);
  const dayOffsets = [2, 5, 9, 13, 17, 21]; // days ago, most recent first
  const now = new Date();
  const played = Object.fromEntries(roster.map((p) => [p.id, 0]));

  let made = 0;
  for (let i = 0; i < targetMatches; i++) {
    const sIdx = Math.min(sessionsCount - 1, Math.floor(i / perSession));
    const base = new Date(now);
    base.setDate(now.getDate() - dayOffsets[sIdx]);
    base.setHours(19, 0, 0, 0);

    // Pick the four least-played players (with a little jitter) to keep games even.
    const pool = [...roster].sort((a, b) => (played[a.id] + rnd()) - (played[b.id] + rnd()));
    const four = shuffle(pool.slice(0, Math.min(roster.length, 5))).slice(0, 4);
    const A = [four[0].id, four[1].id], B = [four[2].id, four[3].id];
    const sA = skill.get(A[0]) + skill.get(A[1]) + chem(A[0], A[1]);
    const sB = skill.get(B[0]) + skill.get(B[1]) + chem(B[0], B[1]);
    const pA = 1 / (1 + Math.exp(-(sA - sB) * 5));
    const aWon = rnd() < pA;
    const [w, l] = score(Math.abs(sA - sB) > 0.25);
    const scoreA = aWon ? w : l, scoreB = aWon ? l : w;
    const playedAt = new Date(base.getTime() + (i % perSession) * 22 * 60000);
    four.forEach((p) => played[p.id]++);

    await db.transaction(async (tx) => {
      const [mt] = await tx.insert(matches).values({ enteredById: A[0], status: "confirmed", winningTeamNo: aWon ? 1 : 2, playedAt }).returning({ id: matches.id });
      const [t1] = await tx.insert(matchTeams).values({ matchId: mt.id, teamNo: 1, score: scoreA, isWinner: aWon }).returning({ id: matchTeams.id });
      const [t2] = await tx.insert(matchTeams).values({ matchId: mt.id, teamNo: 2, score: scoreB, isWinner: !aWon }).returning({ id: matchTeams.id });
      await tx.insert(matchPlayers).values([
        { matchId: mt.id, matchTeamId: t1.id, teamNo: 1, playerId: A[0] },
        { matchId: mt.id, matchTeamId: t1.id, teamNo: 1, playerId: A[1] },
        { matchId: mt.id, matchTeamId: t2.id, teamNo: 2, playerId: B[0] },
        { matchId: mt.id, matchTeamId: t2.id, teamNo: 2, playerId: B[1] },
      ]);
    });
    made++;
  }

  // Availability for the next 14 days. A couple of popular evenings, otherwise scattered.
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    const day = isoDay(d);
    const popular = i === 2 || i === 5 || i === 9; // a few well-attended days
    for (const p of roster) {
      const prob = popular ? 0.8 : 0.3;
      if (rnd() < prob) rows.push({ playerId: p.id, day });
    }
  }
  if (rows.length) await db.insert(availability).values(rows).onConflictDoNothing();

  console.log(`Done: ${made} matches, ${rows.length} availability marks.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
