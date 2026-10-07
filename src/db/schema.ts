import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  unique,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { PackedLedger } from "@/lib/league";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const matchStatusEnum = pgEnum("match_status", ["pending", "confirmed", "void"]);

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------
export const players = pgTable("players", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(), // login handle / slug, unique
  displayName: text("display_name").notNull(),
  color: text("color").notNull().default("#CBFB4F"),
  pinHash: text("pin_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Matches — the atomic event (a 2v2 game)
// ---------------------------------------------------------------------------
export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playedAt: timestamp("played_at", { withTimezone: true }).notNull().defaultNow(),
    enteredById: uuid("entered_by_id").references(() => players.id, { onDelete: "set null" }),
    status: matchStatusEnum("status").notNull().default("confirmed"),
    winningTeamNo: integer("winning_team_no"), // 1 | 2
    clientMatchId: text("client_match_id").unique(), // offline/dedupe guard
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("matches_played_at_idx").on(t.playedAt)],
);

export const matchTeams = pgTable(
  "match_teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    teamNo: integer("team_no").notNull(), // 1 | 2
    score: integer("score").notNull(),
    isWinner: boolean("is_winner").notNull().default(false),
  },
  (t) => [
    unique("match_teams_match_team_uq").on(t.matchId, t.teamNo),
    index("match_teams_match_idx").on(t.matchId),
  ],
);

export const matchPlayers = pgTable(
  "match_players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    matchTeamId: uuid("match_team_id")
      .notNull()
      .references(() => matchTeams.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    teamNo: integer("team_no").notNull(),
  },
  (t) => [
    unique("match_players_match_player_uq").on(t.matchId, t.playerId),
    index("match_players_player_idx").on(t.playerId),
    index("match_players_team_idx").on(t.matchTeamId),
  ],
);

// ---------------------------------------------------------------------------
// Availability — each row = a player marking themselves free on a given day
// ---------------------------------------------------------------------------
export const availability = pgTable(
  "availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    day: date("day").notNull(), // YYYY-MM-DD
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("availability_player_day_uq").on(t.playerId, t.day),
    index("availability_day_idx").on(t.day),
  ],
);

// ---------------------------------------------------------------------------
// Session plans — one night's schedule of 2v2 games, generated from who's present
// ---------------------------------------------------------------------------
export const sessionPlans = pgTable("session_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  day: date("day").notNull().unique(), // one plan per day, YYYY-MM-DD
  roster: uuid("roster").array().notNull(), // who was tapped in when it was generated
  roundCount: integer("round_count").notNull(),
  createdById: uuid("created_by_id").references(() => players.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionGames = pgTable(
  "session_games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => sessionPlans.id, { onDelete: "cascade" }),
    roundNo: integer("round_no").notNull(), // 0-based
    courtNo: integer("court_no").notNull(), // 0-based within the round
    teamA: uuid("team_a").array().notNull(), // 2 player ids
    teamB: uuid("team_b").array().notNull(),
    // Set once the game is logged — that's what crosses it off the plan. `set null` means
    // an admin deleting the match automatically un-crosses its slot.
    matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("session_games_slot_uq").on(t.planId, t.roundNo, t.courtNo),
    index("session_games_plan_idx").on(t.planId),
    index("session_games_match_idx").on(t.matchId),
  ],
);

// ---------------------------------------------------------------------------
// Rating cache — DERIVED, safe to truncate at any time. One row per view of the league
// ("all", "s1", "s2"…): its ledger and rank ranges, fingerprinted by the model they were
// computed under and the games they were computed from. See src/lib/ratingLedger.ts.
// (Seasons themselves aren't in the database: they're SEASON_STARTS in src/lib/season.ts.)
// ---------------------------------------------------------------------------
export const ratingCache = pgTable("rating_cache", {
  scope: text("scope").notNull(),
  model: text("model").notNull(), // keyed with the scope, so two deploys sharing a database never overwrite each other
  sig: text("sig").notNull(),
  ledger: jsonb("ledger").$type<PackedLedger | null>(), // null: borrows All time's (its games are a prefix of them)
  rankRanges: jsonb("rank_ranges").$type<Record<string, [number, number]>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.scope, t.model] })]);

// ---------------------------------------------------------------------------
// Rate limits: tries counted per bucket per window — guesses at the shared code and the admin
// code (per keyed-hash IP and league-wide), and writes by signed-in players (per IP), shared
// across serverless instances (src/lib/auth/limits.ts, src/lib/auth/rateLimit.ts). DERIVED and
// short-lived like rating_cache: truncating it only resets the counts. Day-old rows are swept.
// ---------------------------------------------------------------------------
export const rateLimits = pgTable("rate_limits", {
  bucket: text("bucket").primaryKey(), // "code:ip:<hmac>", "code:all", "admin:…", "log:ip:<hmac>", "plan:ip:<hmac>"
  hits: integer("hits").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------
export const matchesRelations = relations(matches, ({ one, many }) => ({
  enteredBy: one(players, { fields: [matches.enteredById], references: [players.id] }),
  teams: many(matchTeams),
  players: many(matchPlayers),
}));

export const matchTeamsRelations = relations(matchTeams, ({ one, many }) => ({
  match: one(matches, { fields: [matchTeams.matchId], references: [matches.id] }),
  players: many(matchPlayers),
}));

export const matchPlayersRelations = relations(matchPlayers, ({ one }) => ({
  match: one(matches, { fields: [matchPlayers.matchId], references: [matches.id] }),
  team: one(matchTeams, { fields: [matchPlayers.matchTeamId], references: [matchTeams.id] }),
  player: one(players, { fields: [matchPlayers.playerId], references: [players.id] }),
}));

export const sessionPlansRelations = relations(sessionPlans, ({ many }) => ({
  games: many(sessionGames),
}));

export const sessionGamesRelations = relations(sessionGames, ({ one }) => ({
  plan: one(sessionPlans, { fields: [sessionGames.planId], references: [sessionPlans.id] }),
  match: one(matches, { fields: [sessionGames.matchId], references: [matches.id] }),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type Match = typeof matches.$inferSelect;
export type MatchTeam = typeof matchTeams.$inferSelect;
export type MatchPlayer = typeof matchPlayers.$inferSelect;
export type SessionPlanRow = typeof sessionPlans.$inferSelect;
export type SessionGameRow = typeof sessionGames.$inferSelect;
