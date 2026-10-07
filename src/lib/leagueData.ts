import { eq, asc, gte, lte, and } from "drizzle-orm";
import { db } from "@/db";
import { players, matches, matchTeams, matchPlayers, availability, sessionPlans, sessionGames } from "@/db/schema";
import { getSession } from "@/lib/auth/session";
import { adminActive } from "@/lib/auth/admin";
import { sharedCodeLength } from "@/lib/auth/pin";
import type { LeaguePlayer, LeagueMatch } from "@/lib/league";
import { getRatings } from "@/lib/ratingLedger";
import type { ScopeRatings } from "@/lib/ratingCache";
import { seasonsAt, targetAt, type Season } from "@/lib/season";

export const AVAILABILITY_DAYS = 14;

/** Tonight's schedule as stored. A game with a `matchId` has been played. */
export type SessionPlanData = {
  day: string;
  roster: string[];
  roundCount: number;
  games: {
    id: string;
    roundNo: number;
    courtNo: number;
    teamA: string[];
    teamB: string[];
    matchId: string | null;
  }[];
};

export type LeagueData = {
  players: LeaguePlayer[];
  matches: LeagueMatch[];
  currentUserId: string | null;
  adminIds: string[];
  /** When this session's admin unlock runs out (epoch ms), or null if it isn't unlocked. Admin
   *  controls show only while it's set; the server re-checks on every admin action regardless. */
  adminUntil: number | null;
  /** Digits in the shared sign-in code (4–8), so the keypad knows when to check. Never the code. */
  pinLength: number;
  days: string[]; // next 14 ISO day strings (YYYY-MM-DD)
  availabilityByDay: Record<string, string[]>; // day -> playerIds free
  sessionPlan: SessionPlanData | null; // today's plan, if one has been generated
  /** Every season that has begun, oldest first; the last one is in progress. From SEASON_STARTS. */
  seasons: Season[];
  /**
   * Per view of the league, keyed by `scopeKey` ("all", "s1", "s2"…): the rating ledger (one
   * whole-history fit per prefix of that view's games, packed) and the 5–95% rank ranges.
   * Built and cached on the server; the client unpacks a view's ledger into `computeStandings`,
   * which then costs one warm fit for an optimistic match and nothing otherwise. A null ledger
   * means the view's games are a prefix of All time's, so All time's ledger serves it.
   */
  ratings: Record<string, ScopeRatings>;
  /**
   * "Now" as decided by the server. Anything that buckets by calendar day (the activity
   * heatmap) must use this rather than Date.now(), or the SSR pass and the hydrated client
   * disagree about which day it is and React tears the tree down.
   */
  now: number;
};

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateLabel(d: Date): string {
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

export async function getLeagueData(): Promise<LeagueData> {
  // Availability window (next 14 days) is pure date maths — compute it up front so its
  // query doesn't have to wait for anything else.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: string[] = [];
  for (let i = 0; i < AVAILABILITY_DAYS; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(isoDay(d));
  }

  // A single fan-out: every query is independent (the team/player rows join back to
  // `matches` on status rather than depending on a list of match ids from a prior query),
  // so this is ONE round trip to the DB instead of three sequential ones.
  const [session, roster, matchRows, teamRows, mpRows, availRows, planRows, planGameRows] = await Promise.all([
    getSession(),
    db
      .select({ id: players.id, name: players.displayName, color: players.color, active: players.isActive, isAdmin: players.isAdmin })
      .from(players)
      .orderBy(asc(players.displayName)),
    db
      .select()
      .from(matches)
      .where(eq(matches.status, "confirmed"))
      .orderBy(asc(matches.playedAt)),
    db
      .select({ matchId: matchTeams.matchId, teamNo: matchTeams.teamNo, score: matchTeams.score })
      .from(matchTeams)
      .innerJoin(matches, eq(matches.id, matchTeams.matchId))
      .where(eq(matches.status, "confirmed")),
    db
      .select({ matchId: matchPlayers.matchId, playerId: matchPlayers.playerId, teamNo: matchPlayers.teamNo })
      .from(matchPlayers)
      .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
      .where(eq(matches.status, "confirmed")),
    db
      .select({ playerId: availability.playerId, day: availability.day })
      .from(availability)
      .where(and(gte(availability.day, days[0]), lte(availability.day, days[days.length - 1]))),
    db
      .select({ day: sessionPlans.day, roster: sessionPlans.roster, roundCount: sessionPlans.roundCount })
      .from(sessionPlans)
      .where(eq(sessionPlans.day, days[0])),
    // Joins back to today's plan on the day, so this doesn't have to wait for the row above.
    db
      .select({
        id: sessionGames.id,
        roundNo: sessionGames.roundNo,
        courtNo: sessionGames.courtNo,
        teamA: sessionGames.teamA,
        teamB: sessionGames.teamB,
        matchId: sessionGames.matchId,
      })
      .from(sessionGames)
      .innerJoin(sessionPlans, eq(sessionPlans.id, sessionGames.planId))
      .where(eq(sessionPlans.day, days[0]))
      .orderBy(asc(sessionGames.roundNo), asc(sessionGames.courtNo)),
  ]);

  const scoreByTeam = new Map<string, number>();
  for (const t of teamRows) scoreByTeam.set(`${t.matchId}:${t.teamNo}`, t.score);
  const playersByMatch = new Map<string, typeof mpRows>();
  for (const mp of mpRows) {
    const arr = playersByMatch.get(mp.matchId) ?? [];
    arr.push(mp);
    playersByMatch.set(mp.matchId, arr);
  }
  // One clock for the whole response: which seasons have begun, what each game was played to,
  // and the `now` the heatmap uses.
  const now = Date.now();
  const leagueSeasons = seasonsAt(now);
  const leagueMatches: LeagueMatch[] = matchRows
    .map((m): LeagueMatch | null => {
      const mps = playersByMatch.get(m.id) ?? [];
      const teamA = mps.filter((p) => p.teamNo === 1).map((p) => p.playerId);
      const teamB = mps.filter((p) => p.teamNo === 2).map((p) => p.playerId);
      if (teamA.length !== 2 || teamB.length !== 2) return null;
      return {
        id: m.id,
        date: dateLabel(m.playedAt),
        order: m.playedAt.getTime(),
        teamA,
        teamB,
        scoreA: scoreByTeam.get(`${m.id}:1`) ?? 0,
        scoreB: scoreByTeam.get(`${m.id}:2`) ?? 0,
        clientMatchId: m.clientMatchId,
        to: targetAt(leagueSeasons, m.playedAt.getTime()),
      };
    })
    .filter((x): x is LeagueMatch => x !== null);

  const availabilityByDay: Record<string, string[]> = {};
  for (const d of days) availabilityByDay[d] = [];
  for (const r of availRows) {
    if (availabilityByDay[r.day]) availabilityByDay[r.day].push(r.playerId);
  }

  const adminIds = roster.filter((p) => p.isAdmin).map((p) => p.id);

  const plan = planRows[0];
  const sessionPlan: SessionPlanData | null = plan
    ? { day: plan.day, roster: plan.roster, roundCount: plan.roundCount, games: planGameRows }
    : null;

  const leaguePlayers = roster.map(({ id, name, color, active }) => ({ id, name, color, active }));
  const ratings = await getRatings(leaguePlayers, leagueMatches, leagueSeasons);
  const adminUntil =
    session && adminIds.includes(session.playerId) && adminActive(session.adminUntil, now) ? session.adminUntil! : null;

  return {
    players: leaguePlayers,
    matches: leagueMatches,
    seasons: leagueSeasons,
    ratings,
    currentUserId: session?.playerId ?? null,
    adminIds,
    adminUntil,
    pinLength: sharedCodeLength(),
    days,
    availabilityByDay,
    sessionPlan,
    now,
  };
}
