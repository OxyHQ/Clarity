-- oxy:deploy-phase=pre
CREATE TABLE "clarity_search_quota_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"metric" text NOT NULL,
	"additional_limit" integer NOT NULL,
	"reason" text NOT NULL,
	"granted_by" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_quota_grants_metric_check" CHECK ("clarity_search_quota_grants"."metric" in ('search_month', 'fetch_month', 'sites', 'active_crawls', 'pages_per_crawl', 'requests_minute_credential', 'requests_minute_application', 'concurrent_fetches')),
	CONSTRAINT "clarity_search_quota_grants_limit_check" CHECK ("clarity_search_quota_grants"."additional_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "clarity_search_rate_limit_buckets" (
	"dimension" text NOT NULL,
	"dimension_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clarity_search_rate_limit_buckets_pk" PRIMARY KEY("dimension","dimension_id","bucket_start"),
	CONSTRAINT "clarity_search_rate_limit_buckets_dimension_check" CHECK ("clarity_search_rate_limit_buckets"."dimension" in ('credential', 'application')),
	CONSTRAINT "clarity_search_rate_limit_buckets_quantity_check" CHECK ("clarity_search_rate_limit_buckets"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX "clarity_search_quota_grants_account_metric_idx" ON "clarity_search_quota_grants" USING btree ("owner_account_id","metric","expires_at");--> statement-breakpoint
CREATE INDEX "clarity_search_rate_limit_buckets_expiry_idx" ON "clarity_search_rate_limit_buckets" USING btree ("expires_at");
