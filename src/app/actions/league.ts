"use server";

import { revalidatePath } from "next/cache";
import { eq, and, gt, isNull, asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { players, matches, matchTeams, matchPlayers, availability, sessionPlans, sessionGames } from "@/db/schema";
import { hashPin, sharedCode, sharedCodeMatches } from "@/lib/auth/pin";
import { codeAttempt, writeAllowed } from "@/lib/auth/rateLimit";
import { createSession, destroySession, getSession } from "@/lib/auth/session";
import { adminActive, adminCodeMatches, ADMIN_CODE_MIN, ADMIN_HOURS } from "@/lib/auth/admin";
import { logMatchSchema, validWinBy2, type LogMatchInput } from "@/lib/validation";
import { seasonsAt, targetAt } from "@/lib/season";
import { dayNum, numKey } from "@/lib/day";
import { computeStandings, genSession, unpackLedger, MAX_ROUNDS, MAX_PLAYERS, type PlayedGame } from "@/lib/league";
import { getLeagueData, AVAILABILITY_DAYS } from "@/lib/leagueData";

export type ActionResult = { ok: true } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Server actions are public endpoints: anyone can call them with any arguments, not just what
// the app's own UI sends. So every argument is checked for type before it's used.
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 30;
/** A beat after every wrong code, on top of the attempt limits. */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLAYER_COLORS = ["#BEF264", "#5EEAD4", "#F9A8D4", "#93C5FD", "#FDA4AF", "#FCD34D", "#C4B5FD", "#FDBA74", "#67E8F9", "#A3E635", "#F0ABFC", "#FCA5A5"];

/** Admin actions need an admin player AND an unlocked session: the shared sign-in code lets
 *  anyone pick an admin's name, so the name alone proves nothing. Checked on every call. */
async function requireAdmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Admins only." };
  const [p] = await db.select({ isAdmin: players.isAdmin }).from(players).where(eq(players.id, session.playerId));
  if (!p?.isAdmin) return { ok: false, error: "Admins only." };
  if (!adminActive(session.adminUntil, Date.now())) return { ok: false, error: "Admin is locked. Enter the admin code." };
  return { ok: true };
}

/**
 * Unlock admin for ADMIN_HOURS with the admin code (SPIKE_ADMIN_CODE). Only an admin player can,
 * and the unlock is a claim in their signed session cookie, so it ends when they sign out or
 * sign in as someone else. A wrong code costs a beat, to make guessing slow.
 */
export async function unlockAdmin(code: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in first." };
  const [p] = await db.select({ isAdmin: players.isAdmin }).from(players).where(eq(players.id, session.playerId));
  if (!p?.isAdmin) return { ok: false, error: "Admins only." };
  const configured = process.env.SPIKE_ADMIN_CODE;
  if (!configured || configured.length < ADMIN_CODE_MIN) {
    return { ok: false, error: `No admin code is set up here (SPIKE_ADMIN_CODE, ${ADMIN_CODE_MIN}+ characters).` };
  }
  const attempt = await codeAttempt("admin");
  if (!attempt.ok) return attempt;
  if (typeof code !== "string" || !adminCodeMatches(code, configured)) {
    await pause(700);
    return { ok: false, error: "Wrong admin code." };
  }
  attempt.succeeded();
  await createSession(session.playerId, session.name, Date.now() + ADMIN_HOURS * 3_600_000);
  revalidatePath("/");
  return { ok: true };
}

/** Lock admin again before the unlock runs out. */
export async function lockAdmin(): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: true };
  await createSession(session.playerId, session.name);
  revalidatePath("/");
  return { ok: true };
}

/** Add a player (admin only). Gets the shared sign-in code and a free colour. */
export async function addPlayer(displayName: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  if (!isName(displayName)) return { ok: false, error: "Enter a name." };
  const trimmed = displayName.trim();
  const code = sharedCode();
  if (!code) return { ok: false, error: "Set SPIKE_PIN (4–8 digits) before adding players." };
  const baseSlug = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "") || "player";
  const existing = await db.select({ name: players.name, color: players.color }).from(players);
  const taken = new Set(existing.map((p) => p.name));
  let slug = baseSlug, n = 1;
  while (taken.has(slug)) slug = `${baseSlug}${++n}`;
  const usedColors = new Set(existing.map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !usedColors.has(c)) ?? PLAYER_COLORS[existing.length % PLAYER_COLORS.length];
  const pinHash = await hashPin(code);
  await db.insert(players).values({ name: slug, displayName: trimmed, color, pinHash });
  revalidatePath("/");
  return { ok: true };
}

/** Rename a player (admin only). Fixes misspellings; only the display name changes,
 * the login handle/slug stays put so sign-in keeps working. */
export async function renamePlayer(playerId: string, displayName: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  if (!isUuid(playerId)) return { ok: false, error: "Player not found." };
  if (!isName(displayName)) return { ok: false, error: "Enter a name." };
  const trimmed = displayName.trim();
  await db.update(players).set({ displayName: trimmed }).where(eq(players.id, playerId));
  revalidatePath("/");
  return { ok: true };
}

/** Edit a confirmed match's score (admin only). Keeps the two team rows, the
 * match winner and the per-team winner flags in sync. */
export async function editMatchScore(matchId: string, score1: number, score2: number): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  if (!Number.isInteger(score1) || !Number.isInteger(score2) || score1 < 0 || score2 < 0 || score1 > 99 || score2 > 99) {
    return { ok: false, error: "Invalid score." };
  }
  if (!isUuid(matchId)) return { ok: false, error: "Match not found." };
  const [match] = await db.select({ id: matches.id, playedAt: matches.playedAt }).from(matches).where(eq(matches.id, matchId));
  if (!match) return { ok: false, error: "Match not found." };
  // Judged by the rules of the season the game was played in, not today's.
  const to = targetAt(seasonsAt(Date.now()), match.playedAt.getTime());
  if (!validWinBy2(score1, score2, to)) return { ok: false, error: `Score must reach ${to} and win by 2.` };
  const team1Wins = score1 > score2;
  await db.transaction(async (tx) => {
    await tx
      .update(matchTeams)
      .set({ score: score1, isWinner: team1Wins })
      .where(and(eq(matchTeams.matchId, matchId), eq(matchTeams.teamNo, 1)));
    await tx
      .update(matchTeams)
      .set({ score: score2, isWinner: !team1Wins })
      .where(and(eq(matchTeams.matchId, matchId), eq(matchTeams.teamNo, 2)));
    await tx.update(matches).set({ winningTeamNo: team1Wins ? 1 : 2 }).where(eq(matches.id, matchId));
  });
  revalidatePath("/");
  return { ok: true };
}

/** Delete a match (admin only). The team and player rows cascade away with it. */
export async function deleteMatch(matchId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  if (!isUuid(matchId)) return { ok: false, error: "Match not found." };
  await db.delete(matches).where(eq(matches.id, matchId));
  revalidatePath("/");
  return { ok: true };
}

/** Toggle the signed-in player's availability for a given YYYY-MM-DD day. */
export async function toggleAvailability(day: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in to set availability." };
  // A real calendar day: "2026-02-30" would otherwise reach Postgres and fail there.
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || numKey(dayNum(day)) !== day) return { ok: false, error: "Bad date." };
  // And one the app offers (getLeagueData's window, a day's slack either side for clocks and
  // midnight), so nobody can fill the table with availability for the year 9999.
  const today = dayNum(isoDay(new Date()));
  if (dayNum(day) < today - 1 || dayNum(day) > today + AVAILABILITY_DAYS) return { ok: false, error: "Pick a day in the next two weeks." };
  const existing = await db
    .select({ id: availability.id })
    .from(availability)
    .where(and(eq(availability.playerId, session.playerId), eq(availability.day, day)));
  if (existing.length) {
    await db.delete(availability).where(eq(availability.id, existing[0].id));
  } else {
    await db.insert(availability).values({ playerId: session.playerId, day }).onConflictDoNothing();
  }
  revalidatePath("/");
  return { ok: true };
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Generate (or re-generate) today's schedule from whoever's present.
 *
 * Rounds that have already had a game logged are frozen — a replan only rewrites the part
 * of the night that hasn't started, so late arrivals can be worked in without disturbing
 * results or shuffling a game people are mid-way through. Anyone signed in can do this.
 *
 * The day is always the server's today, never a value from the client: a tab left open past
 * midnight would otherwise write a plan under yesterday's date, where nothing can read it.
 */
export async function generateSessionPlan(roster: string[], roundCount: number): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in to plan a session." };
  if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > MAX_ROUNDS) {
    return { ok: false, error: `Pick between 1 and ${MAX_ROUNDS} games.` };
  }
  if (!Array.isArray(roster) || roster.length > 4 * MAX_PLAYERS) return { ok: false, error: "Unknown player." };
  const ids = [...new Set(roster)];
  if (ids.length < 4) return { ok: false, error: "Need at least 4 players." };
  if (ids.length > MAX_PLAYERS) return { ok: false, error: `That's more than ${MAX_PLAYERS} players.` };
  if (!ids.every(isUuid)) return { ok: false, error: "Unknown player." };
  const known = await db
    .select({ id: players.id })
    .from(players)
    .where(and(inArray(players.id, ids), eq(players.isActive, true)));
  if (known.length !== ids.length) return { ok: false, error: "Unknown player." };
  // Planning holds row locks while the scheduler runs (~1 s at this league's size), so a script
  // can't be allowed to loop on it.
  const allowed = await writeAllowed("plan");
  if (!allowed.ok) return allowed;

  const day = isoDay(new Date());
  const data = await getLeagueData();
  // All time, always: the scheduler's "longest since they partnered" is league history, and
  // its team balance wants the best-informed skills, not a season that started last week.
  // With the server's ledger this is a derivation pass, not a refit of every game.
  const allLedger = data.ratings.all?.ledger;
  const cs = computeStandings(data.players, data.matches, { ledger: allLedger ? unpackLedger(allLedger) : undefined });

  // Read the existing plan, decide the frozen prefix, and rewrite the rest all inside one
  // transaction. Reading first and writing after would leave a window — the width of a
  // genSession call — in which a concurrent Clear or a logged score changes what we based
  // `frozenThrough` on, and we'd then delete a just-claimed round or insert a plan that
  // starts at round 4.
  // Today's games, oldest first — the plan has to account for whatever has already happened.
  const todaysMatches = data.matches.filter((m) => m.date === "Today").sort((a, b) => a.order - b.order);

  let ok = true;
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: sessionPlans.id })
      .from(sessionPlans)
      .where(eq(sessionPlans.day, day))
      .for("update");
    let frozenThrough = -1;
    let played: PlayedGame[] = [];
    const linked = new Set<string>();
    if (existing) {
      const prior = await tx
        .select({
          roundNo: sessionGames.roundNo,
          teamA: sessionGames.teamA,
          teamB: sessionGames.teamB,
          matchId: sessionGames.matchId,
        })
        .from(sessionGames)
        .where(eq(sessionGames.planId, existing.id))
        .orderBy(asc(sessionGames.roundNo), asc(sessionGames.courtNo))
        // Locked too, so a score being logged right now either lands before we read it (and
        // its round gets frozen) or waits until we've committed. Without this it could claim
        // a row in between and we'd delete it.
        .for("update");
      // Freeze up to and including the last round anything was logged in.
      for (const g of prior) if (g.matchId && g.roundNo > frozenThrough) frozenThrough = g.roundNo;
      played = prior
        .filter((g) => g.roundNo <= frozenThrough)
        .map((g) => ({ A: g.teamA, B: g.teamB, round: g.roundNo }));
      for (const g of prior) if (g.matchId) linked.add(g.matchId);
    }

    // Anything already played today that no slot accounts for — most obviously games logged
    // before anyone generated a plan — opens the night as its own rounds, in the order they
    // were played. Otherwise the plan would claim nothing had happened yet, re-schedule games
    // that are already in the books, and rotate as if everyone were fresh.
    const courts = Math.floor(ids.length / 4);
    const orphans = todaysMatches.filter((m) => !linked.has(m.id));
    const extra: PlayedGame[] = orphans.map((m, i) => ({
      A: m.teamA,
      B: m.teamB,
      round: frozenThrough + 1 + Math.floor(i / courts),
    }));
    // Where each of those lands, so the rows can be pointed back at their match below.
    const backLink = new Map<string, string>();
    orphans.forEach((m, i) => backLink.set(`${frozenThrough + 1 + Math.floor(i / courts)}:${i % courts}`, m.id));
    const prefixEnd = extra.length ? extra[extra.length - 1].round : frozenThrough;

    // Never drop a round that's already been played, even if the count was dialled down.
    const rounds = Math.max(roundCount, prefixEnd + 1);
    const plan = genSession(ids, cs, { rounds, played: [...played, ...extra] });
    if (plan.rounds.length !== rounds) { ok = false; return; }

    const [row] = await tx
      .insert(sessionPlans)
      .values({ day, roster: ids, roundCount: rounds, createdById: session.playerId })
      .onConflictDoUpdate({
        target: sessionPlans.day,
        set: { roster: ids, roundCount: rounds, updatedAt: new Date() },
      })
      .returning({ id: sessionPlans.id });
    await tx
      .delete(sessionGames)
      .where(and(eq(sessionGames.planId, row.id), gt(sessionGames.roundNo, frozenThrough)));
    const fresh = plan.rounds
      .filter((rd) => rd.index > frozenThrough)
      .flatMap((rd) =>
        rd.games.map((g) => ({
          planId: row.id,
          roundNo: rd.index,
          courtNo: g.court,
          teamA: g.A,
          teamB: g.B,
          // Carries the score straight in, so a game played before the plan existed shows
          // crossed off rather than as something still to come.
          matchId: backLink.get(`${rd.index}:${g.court}`) ?? null,
        })),
      );
    if (fresh.length) await tx.insert(sessionGames).values(fresh);
  });
  if (!ok) return { ok: false, error: "Couldn't build a plan for that group." };

  revalidatePath("/");
  return { ok: true };
}

/** Bin today's schedule entirely. The games cascade away with it. */
export async function clearSessionPlan(): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in to clear the plan." };
  await db.delete(sessionPlans).where(eq(sessionPlans.day, isoDay(new Date())));
  revalidatePath("/");
  return { ok: true };
}

/**
 * Check the shared code before showing the roster. Rate-limited per IP and league-wide (see
 * src/lib/auth/limits.ts): every try is counted before the code is compared, and a caller over
 * the limit is refused without a comparison, so there's nothing to learn from guessing on.
 */
export async function verifyGroupPin(pin: string): Promise<ActionResult> {
  return checkSharedCode(pin);
}

async function checkSharedCode(pin: unknown): Promise<ActionResult> {
  const configured = sharedCode();
  if (!configured) return { ok: false, error: "Sign-in isn't set up yet (SPIKE_PIN)." };
  const attempt = await codeAttempt("code");
  if (!attempt.ok) return attempt;
  if (!sharedCodeMatches(pin, configured)) {
    await pause(400);
    return { ok: false, error: "Wrong code." };
  }
  attempt.succeeded();
  return { ok: true };
}

/** Sign in as a player: the shared code again (it's the only thing the client can't fake), then
 *  a session for whoever was picked. */
export async function signIn(playerId: string, pin: string): Promise<ActionResult> {
  if (!isUuid(playerId)) return { ok: false, error: "Player not found." };
  const checked = await checkSharedCode(pin);
  if (!checked.ok) return checked;
  const [player] = await db
    .select({ id: players.id, name: players.name, isActive: players.isActive })
    .from(players)
    .where(eq(players.id, playerId));
  if (!player || !player.isActive) return { ok: false, error: "Player not found." };
  await createSession(player.id, player.name);
  revalidatePath("/");
  return { ok: true };
}

export async function signOut(): Promise<ActionResult> {
  await destroySession();
  revalidatePath("/");
  return { ok: true };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Cross a just-logged match off today's schedule. The matchmaker passes the exact slot it
 * came from; a score typed on the Log screen instead falls back to the earliest unplayed
 * slot with the same four players, so the plan keeps up either way.
 *
 * Only ever claims a slot that's still open, so a double-tap can't steal someone else's.
 */
async function crossOffPlan(tx: Tx, matchId: string, data: LogMatchInput): Promise<void> {
  const open = await tx
    .select({ id: sessionGames.id, teamA: sessionGames.teamA, teamB: sessionGames.teamB })
    .from(sessionGames)
    .innerJoin(sessionPlans, eq(sessionPlans.id, sessionGames.planId))
    .where(and(eq(sessionPlans.day, isoDay(new Date())), isNull(sessionGames.matchId)))
    .orderBy(asc(sessionGames.roundNo), asc(sessionGames.courtNo));

  // Match on the two TEAMS, not just the set of four. With four players present every round
  // holds the same faces in one of only three splits, so comparing the foursome alone would
  // cross off whichever round came first — the wrong game, and then the sheet renders its
  // score against the other split's teams.
  const key = (t: string[]) => [...t].sort().join(",");
  const wanted = [key(data.team1), key(data.team2)].sort().join("|");
  const sameTeams = (slot: { teamA: string[]; teamB: string[] }) =>
    [key(slot.teamA), key(slot.teamB)].sort().join("|") === wanted;

  // A slot named by the matchmaker still has to be one of today's open slots for these exact
  // teams — the id arrives from the client, so it can't be trusted on its own.
  const hit = data.planGameId
    ? open.find((slot) => slot.id === data.planGameId && sameTeams(slot))
    : open.find(sameTeams);
  if (!hit) return;
  await tx
    .update(sessionGames)
    .set({ matchId })
    .where(and(eq(sessionGames.id, hit.id), isNull(sessionGames.matchId)));
}

export async function logMatch(input: LogMatchInput): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in to log a match." };

  const parsed = logMatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid match." };
  const data = parsed.data;
  // The game is stamped with the server's clock below, so it's played to that moment's season rule.
  const to = targetAt(seasonsAt(Date.now()), Date.now());
  if (!validWinBy2(data.score1, data.score2, to)) return { ok: false, error: `Score must reach ${to} and win by 2.` };

  if (data.clientMatchId) {
    const [existing] = await db
      .select({ id: matches.id })
      .from(matches)
      .where(eq(matches.clientMatchId, data.clientMatchId));
    if (existing) return { ok: true };
  }
  // After the retry check, so re-sending a game that already saved always succeeds.
  const allowed = await writeAllowed("log");
  if (!allowed.ok) return allowed;

  const team1Wins = data.score1 > data.score2;
  try {
    await db.transaction(async (tx) => {
      const [match] = await tx
        .insert(matches)
        .values({
          enteredById: session.playerId,
          status: "confirmed",
          winningTeamNo: team1Wins ? 1 : 2,
          clientMatchId: data.clientMatchId,
          // Always the server's clock: a game's time decides its season and who's resting, so
          // it can't be something a client gets to choose.
          playedAt: new Date(),
        })
        .returning({ id: matches.id });
      const [t1] = await tx
        .insert(matchTeams)
        .values({ matchId: match.id, teamNo: 1, score: data.score1, isWinner: team1Wins })
        .returning({ id: matchTeams.id });
      const [t2] = await tx
        .insert(matchTeams)
        .values({ matchId: match.id, teamNo: 2, score: data.score2, isWinner: !team1Wins })
        .returning({ id: matchTeams.id });
      await tx.insert(matchPlayers).values([
        ...data.team1.map((playerId) => ({ matchId: match.id, matchTeamId: t1.id, teamNo: 1, playerId })),
        ...data.team2.map((playerId) => ({ matchId: match.id, matchTeamId: t2.id, teamNo: 2, playerId })),
      ]);
      await crossOffPlan(tx, match.id, data);
    });
  } catch (e) {
    if (data.clientMatchId) {
      const [existing] = await db
        .select({ id: matches.id })
        .from(matches)
        .where(eq(matches.clientMatchId, data.clientMatchId));
      if (existing) return { ok: true };
    }
    console.error("logMatch failed", e);
    return { ok: false, error: "Could not save the match." };
  }

  revalidatePath("/");
  return { ok: true };
}
