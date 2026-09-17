-- oxy:deploy-phase=pre
CREATE TABLE "clarity_places" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"ascii_name" text NOT NULL,
	"search_name" text NOT NULL,
	"match_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"country_code" text NOT NULL,
	"admin1_code" text,
	"admin1_name" text,
	"subdivision_code" text,
	"population" bigint,
	"latitude" double precision,
	"longitude" double precision,
	"timezone" text,
	"feature_code" text,
	"source_modified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_places_kind_check" CHECK ("clarity_places"."kind" in ('city', 'region')),
	CONSTRAINT "clarity_places_country_code_check" CHECK ("clarity_places"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "clarity_places_population_check" CHECK ("clarity_places"."population" is null or "clarity_places"."population" >= 0)
);
--> statement-breakpoint
CREATE INDEX "clarity_places_country_kind_idx" ON "clarity_places" USING btree ("country_code","kind");--> statement-breakpoint
CREATE INDEX "clarity_places_search_name_prefix_idx" ON "clarity_places" USING btree ("search_name" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "clarity_places_search_name_trgm_idx" ON "clarity_places" USING gin ("search_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clarity_places_match_names_idx" ON "clarity_places" USING gin ("match_names");--> statement-breakpoint
CREATE INDEX "clarity_places_population_idx" ON "clarity_places" USING btree ("population");