DROP TABLE IF EXISTS "badges" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "dispute_votes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "disputes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "player_badges" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "points" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "rating_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "seasons" CASCADE;--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT IF EXISTS "matches_season_id_seasons_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "matches_season_idx";--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "color" SET DEFAULT '#CBFB4F';--> statement-breakpoint
ALTER TABLE "match_players" DROP COLUMN IF EXISTS "is_server_first";--> statement-breakpoint
ALTER TABLE "match_teams" DROP COLUMN IF EXISTS "rating_rank";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN IF EXISTS "season_id";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN IF EXISTS "mode";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN IF EXISTS "notes";--> statement-breakpoint
ALTER TABLE "players" DROP COLUMN IF EXISTS "emoji";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."dispute_claim";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."dispute_verdict";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."match_mode";
