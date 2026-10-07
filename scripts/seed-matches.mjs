// Dev-only: generate varied matches so chemistry/matchmaker/charts have data.
// Usage: npx tsx --env-file=.env.local scripts/seed-matches.mjs [count]  (local databases only)
import { assertLocalDatabase } from "./local-only.mjs";
import { db } from "../src/db/index.ts";
import { players, matches, matchTeams, matchPlayers } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";

const COUNT = Number(process.argv[2] ?? 24);

// Deterministic PRNG so results are reproducible.
let s = 12345;
const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  assertLocalDatabase();
  const roster = await db.select().from(players).where(eq(players.isActive, true));

  // Hidden true skill + chemistry to make the data interesting.
  const skill = new Map();
  roster.forEach((p, i) => skill.set(p.id, 0.3 + ((i * 0.09) % 0.6)));
  // Tim+Joss have great chemistry; Ben L+Will are awkward together.
  const byName = Object.fromEntries(roster.map((p) => [p.name, p.id]));
  const chem = (a, b) => {
    const key = [a, b].sort().join("|");
    if (key === [byName.tim, byName.joss].sort().join("|")) return 0.25;
    if (key === [byName.benl, byName.will].sort().join("|")) return -0.25;
    return 0;
  };

  let inserted = 0;
  const base = Date.now() - COUNT * 3600_000;
  for (let i = 0; i < COUNT; i++) {
    const four = shuffle(roster).slice(0, 4);
    const t1 = [four[0].id, four[1].id];
    const t2 = [four[2].id, four[3].id];
    const str1 = skill.get(t1[0]) + skill.get(t1[1]) + chem(t1[0], t1[1]);
    const str2 = skill.get(t2[0]) + skill.get(t2[1]) + chem(t2[0], t2[1]);
    const p1 = str1 / (str1 + str2);
    const t1Wins = rand() < p1;
    const winScore = 21;
    const loseScore = Math.floor(rand() * 19);
    const score1 = t1Wins ? winScore : loseScore;
    const score2 = t1Wins ? loseScore : winScore;
    const playedAt = new Date(base + i * 3600_000);

    await db.transaction(async (tx) => {
      const [m] = await tx
        .insert(matches)
        .values({
          enteredById: four[0].id,
          status: "confirmed",
          winningTeamNo: t1Wins ? 1 : 2,
          playedAt,
        })
        .returning({ id: matches.id });
      const [mt1] = await tx
        .insert(matchTeams)
        .values({ matchId: m.id, teamNo: 1, score: score1, isWinner: t1Wins })
        .returning({ id: matchTeams.id });
      const [mt2] = await tx
        .insert(matchTeams)
        .values({ matchId: m.id, teamNo: 2, score: score2, isWinner: !t1Wins })
        .returning({ id: matchTeams.id });
      await tx.insert(matchPlayers).values([
        { matchId: m.id, matchTeamId: mt1.id, teamNo: 1, playerId: t1[0] },
        { matchId: m.id, matchTeamId: mt1.id, teamNo: 1, playerId: t1[1] },
        { matchId: m.id, matchTeamId: mt2.id, teamNo: 2, playerId: t2[0] },
        { matchId: m.id, matchTeamId: mt2.id, teamNo: 2, playerId: t2[1] },
      ]);
    });
    inserted++;
  }

  console.log(`Inserted ${inserted} matches.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
