CREATE TABLE "session_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"round_no" integer NOT NULL,
	"court_no" integer NOT NULL,
	"team_a" uuid[] NOT NULL,
	"team_b" uuid[] NOT NULL,
	"match_id" uuid,
	CONSTRAINT "session_games_slot_uq" UNIQUE("plan_id","round_no","court_no")
);
--> statement-breakpoint
CREATE TABLE "session_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"roster" uuid[] NOT NULL,
	"round_count" integer NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_plans_day_unique" UNIQUE("day")
);
--> statement-breakpoint
ALTER TABLE "session_games" ADD CONSTRAINT "session_games_plan_id_session_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."session_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_games" ADD CONSTRAINT "session_games_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_plans" ADD CONSTRAINT "session_plans_created_by_id_players_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_games_plan_idx" ON "session_games" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "session_games_match_idx" ON "session_games" USING btree ("match_id");