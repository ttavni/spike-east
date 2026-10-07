CREATE TYPE "public"."dispute_claim" AS ENUM('rim', 'pocket', 'other');--> statement-breakpoint
CREATE TYPE "public"."dispute_verdict" AS ENUM('rim', 'pocket', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."match_mode" AS ENUM('final_score', 'point_by_point');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('pending', 'confirmed', 'void');--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"emoji" text DEFAULT '🏅' NOT NULL,
	"criteria" jsonb,
	CONSTRAINT "badges_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "dispute_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"voter_id" uuid NOT NULL,
	"vote" "dispute_verdict" NOT NULL,
	CONSTRAINT "dispute_votes_uq" UNIQUE("dispute_id","voter_id")
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"point_id" uuid,
	"raised_by_id" uuid,
	"claim" "dispute_claim" NOT NULL,
	"description" text,
	"resolved_verdict" "dispute_verdict",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"match_team_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"team_no" integer NOT NULL,
	"is_server_first" boolean,
	CONSTRAINT "match_players_match_player_uq" UNIQUE("match_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "match_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"team_no" integer NOT NULL,
	"score" integer NOT NULL,
	"is_winner" boolean DEFAULT false NOT NULL,
	"rating_rank" integer NOT NULL,
	CONSTRAINT "match_teams_match_team_uq" UNIQUE("match_id","team_no")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entered_by_id" uuid,
	"mode" "match_mode" DEFAULT 'final_score' NOT NULL,
	"status" "match_status" DEFAULT 'confirmed' NOT NULL,
	"winning_team_no" integer,
	"client_match_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_client_match_id_unique" UNIQUE("client_match_id")
);
--> statement-breakpoint
CREATE TABLE "player_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"badge_id" uuid NOT NULL,
	"season_id" uuid,
	"context_match_id" uuid,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_badges_uq" UNIQUE("player_id","badge_id","season_id")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"emoji" text DEFAULT '🎯' NOT NULL,
	"color" text DEFAULT '#22c55e' NOT NULL,
	"pin_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"serving_team_no" integer,
	"serving_player_id" uuid,
	"won_by_team_no" integer NOT NULL,
	"score_team1_after" integer NOT NULL,
	"score_team2_after" integer NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_match_seq_uq" UNIQUE("match_id","seq")
);
--> statement-breakpoint
CREATE TABLE "rating_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"mu_before" double precision NOT NULL,
	"sigma_before" double precision NOT NULL,
	"mu_after" double precision NOT NULL,
	"sigma_after" double precision NOT NULL,
	"ordinal_after" double precision NOT NULL,
	"match_played_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rating_snapshots_match_player_uq" UNIQUE("match_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"soft_reset" boolean DEFAULT false NOT NULL,
	"carryover_weight" double precision DEFAULT 0.3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispute_votes" ADD CONSTRAINT "dispute_votes_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_votes" ADD CONSTRAINT "dispute_votes_voter_id_players_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_point_id_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_id_players_id_fk" FOREIGN KEY ("raised_by_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_team_id_match_teams_id_fk" FOREIGN KEY ("match_team_id") REFERENCES "public"."match_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_teams" ADD CONSTRAINT "match_teams_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_entered_by_id_players_id_fk" FOREIGN KEY ("entered_by_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_badges" ADD CONSTRAINT "player_badges_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_badges" ADD CONSTRAINT "player_badges_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_badges" ADD CONSTRAINT "player_badges_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_badges" ADD CONSTRAINT "player_badges_context_match_id_matches_id_fk" FOREIGN KEY ("context_match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points" ADD CONSTRAINT "points_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points" ADD CONSTRAINT "points_serving_player_id_players_id_fk" FOREIGN KEY ("serving_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_snapshots" ADD CONSTRAINT "rating_snapshots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_snapshots" ADD CONSTRAINT "rating_snapshots_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_snapshots" ADD CONSTRAINT "rating_snapshots_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_players_player_idx" ON "match_players" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "match_players_team_idx" ON "match_players" USING btree ("match_team_id");--> statement-breakpoint
CREATE INDEX "match_teams_match_idx" ON "match_teams" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "matches_season_idx" ON "matches" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "matches_played_at_idx" ON "matches" USING btree ("played_at");--> statement-breakpoint
CREATE INDEX "rating_snapshots_season_player_idx" ON "rating_snapshots" USING btree ("season_id","player_id");--> statement-breakpoint
CREATE INDEX "rating_snapshots_played_at_idx" ON "rating_snapshots" USING btree ("match_played_at");