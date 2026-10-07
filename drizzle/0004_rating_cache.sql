CREATE TABLE "rating_cache" (
	"scope" text NOT NULL,
	"model" text NOT NULL,
	"sig" text NOT NULL,
	"ledger" jsonb,
	"rank_ranges" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rating_cache_scope_model_pk" PRIMARY KEY("scope","model")
);
