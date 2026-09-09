-- oxy:deploy-phase=pre
CREATE TABLE "clarity_crawl_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"credential_id" text,
	"site_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"pages_discovered" integer DEFAULT 0 NOT NULL,
	"pages_completed" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_detail" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_crawl_jobs_idempotency_unique" UNIQUE("owner_account_id","application_id","idempotency_key"),
	CONSTRAINT "clarity_crawl_jobs_status_check" CHECK ("clarity_crawl_jobs"."status" in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
	CONSTRAINT "clarity_crawl_jobs_kind_check" CHECK ("clarity_crawl_jobs"."kind" in ('urls', 'site', 'recrawl', 'removal'))
);
--> statement-breakpoint
CREATE TABLE "clarity_crawl_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"url" text NOT NULL,
	"discovery_source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_crawl_pages_job_url_unique" UNIQUE("job_id","url")
);
--> statement-breakpoint
CREATE TABLE "clarity_fetch_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"crawl_page_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"fetch_mode" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"bytes_received" bigint,
	"duration_ms" integer,
	"redirect_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "clarity_fetch_attempts_page_attempt_unique" UNIQUE("crawl_page_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "clarity_news_stories" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"language" text,
	"first_published_at" timestamp with time zone NOT NULL,
	"last_published_at" timestamp with time zone NOT NULL,
	"source_count" integer DEFAULT 1 NOT NULL,
	"publisher_diversity" integer DEFAULT 1 NOT NULL,
	"ranking_score" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_news_story_articles" (
	"story_id" text NOT NULL,
	"document_id" text NOT NULL,
	"similarity" double precision NOT NULL,
	CONSTRAINT "clarity_news_story_articles_pk" PRIMARY KEY("story_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "clarity_search_authors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"same_as" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_search_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"position" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"text" text NOT NULL,
	"search_vector" "tsvector" NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"extractor_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_chunks_document_position_unique" UNIQUE("document_id","position")
);
--> statement-breakpoint
CREATE TABLE "clarity_search_document_aliases" (
	"url" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"kind" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_search_document_authors" (
	"document_id" text NOT NULL,
	"author_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "clarity_search_document_authors_pk" PRIMARY KEY("document_id","author_id")
);
--> statement-breakpoint
CREATE TABLE "clarity_search_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"requested_url" text NOT NULL,
	"final_url" text,
	"canonical_url" text NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"document_type" text DEFAULT 'other' NOT NULL,
	"content_hash" text,
	"http_status" integer,
	"etag" text,
	"last_modified" text,
	"content_type" text,
	"language" text,
	"title" text,
	"description" text,
	"main_content" text,
	"structured_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"field_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publisher_name" text,
	"published_at" timestamp with time zone,
	"modified_at" timestamp with time zone,
	"image_url" text,
	"favicon_url" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"noindex" boolean DEFAULT false NOT NULL,
	"nofollow" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone,
	"indexed_at" timestamp with time zone,
	"next_fetch_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_documents_canonical_unique" UNIQUE("canonical_url"),
	CONSTRAINT "clarity_search_documents_status_check" CHECK ("clarity_search_documents"."status" in ('discovered', 'fetching', 'extracted', 'indexed', 'blocked', 'failed', 'removed')),
	CONSTRAINT "clarity_search_documents_type_check" CHECK ("clarity_search_documents"."document_type" in ('page', 'article', 'news', 'product', 'video', 'event', 'recipe', 'profile', 'documentation', 'other'))
);
--> statement-breakpoint
CREATE TABLE "clarity_search_outgoing_links" (
	"id" text PRIMARY KEY NOT NULL,
	"source_document_id" text NOT NULL,
	"target_url" text NOT NULL,
	"anchor_text" text,
	"rel" text[] DEFAULT '{}'::text[] NOT NULL,
	"discovery_source" text DEFAULT 'html' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_search_sites" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"origin" text NOT NULL,
	"verified_domain_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"crawl_enabled" boolean DEFAULT true NOT NULL,
	"recrawl_interval_seconds" integer DEFAULT 86400 NOT NULL,
	"max_pages_per_crawl" integer DEFAULT 5000 NOT NULL,
	"robots_text" text,
	"robots_fetched_at" timestamp with time zone,
	"sitemap_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"feed_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"next_crawl_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_sites_account_origin_unique" UNIQUE("owner_account_id","origin"),
	CONSTRAINT "clarity_search_sites_status_check" CHECK ("clarity_search_sites"."status" in ('active', 'paused', 'removed')),
	CONSTRAINT "clarity_search_sites_interval_check" CHECK ("clarity_search_sites"."recrawl_interval_seconds" >= 900),
	CONSTRAINT "clarity_search_sites_max_pages_check" CHECK ("clarity_search_sites"."max_pages_per_crawl" between 1 and 500000)
);
--> statement-breakpoint
CREATE TABLE "clarity_search_usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"credential_id" text,
	"operation" text NOT NULL,
	"idempotency_key" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_usage_idempotency_unique" UNIQUE("owner_account_id","operation","idempotency_key"),
	CONSTRAINT "clarity_search_usage_operation_check" CHECK ("clarity_search_usage_events"."operation" in ('search', 'fetch_started', 'page_indexed', 'browser_render')),
	CONSTRAINT "clarity_search_usage_quantity_check" CHECK ("clarity_search_usage_events"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "clarity_search_usage_rollups" (
	"owner_account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"credential_id" text DEFAULT '' NOT NULL,
	"operation" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"quantity" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_search_usage_rollups_pk" PRIMARY KEY("owner_account_id","application_id","credential_id","operation","period_start")
);
--> statement-breakpoint
ALTER TABLE "clarity_crawl_jobs" ADD CONSTRAINT "clarity_crawl_jobs_site_id_clarity_search_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."clarity_search_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_crawl_pages" ADD CONSTRAINT "clarity_crawl_pages_job_id_clarity_crawl_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."clarity_crawl_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_fetch_attempts" ADD CONSTRAINT "clarity_fetch_attempts_crawl_page_id_clarity_crawl_pages_id_fk" FOREIGN KEY ("crawl_page_id") REFERENCES "public"."clarity_crawl_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_news_story_articles" ADD CONSTRAINT "clarity_news_story_articles_story_id_clarity_news_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."clarity_news_stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_news_story_articles" ADD CONSTRAINT "clarity_news_story_articles_document_id_clarity_search_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."clarity_search_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_search_chunks" ADD CONSTRAINT "clarity_search_chunks_document_id_clarity_search_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."clarity_search_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_search_document_aliases" ADD CONSTRAINT "clarity_search_document_aliases_document_id_clarity_search_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."clarity_search_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_search_document_authors" ADD CONSTRAINT "clarity_search_document_authors_document_id_clarity_search_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."clarity_search_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_search_document_authors" ADD CONSTRAINT "clarity_search_document_authors_author_id_clarity_search_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."clarity_search_authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_search_documents" ADD CONSTRAINT "clarity_search_documents_site_id_clarity_search_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."clarity_search_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_search_outgoing_links" ADD CONSTRAINT "clarity_search_outgoing_links_source_document_id_clarity_search_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."clarity_search_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clarity_crawl_jobs_account_status_idx" ON "clarity_crawl_jobs" USING btree ("owner_account_id","status");--> statement-breakpoint
CREATE INDEX "clarity_crawl_pages_lease_idx" ON "clarity_crawl_pages" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "clarity_news_stories_rank_idx" ON "clarity_news_stories" USING btree ("last_published_at","ranking_score");--> statement-breakpoint
CREATE INDEX "clarity_search_chunks_fts_idx" ON "clarity_search_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "clarity_search_chunks_embedding_hnsw_idx" ON "clarity_search_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "clarity_search_document_aliases_document_idx" ON "clarity_search_document_aliases" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "clarity_search_documents_site_status_idx" ON "clarity_search_documents" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "clarity_search_documents_published_idx" ON "clarity_search_documents" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "clarity_search_documents_title_trgm_idx" ON "clarity_search_documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clarity_search_outgoing_links_source_idx" ON "clarity_search_outgoing_links" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "clarity_search_sites_next_crawl_idx" ON "clarity_search_sites" USING btree ("status","next_crawl_at");--> statement-breakpoint
CREATE INDEX "clarity_search_usage_account_time_idx" ON "clarity_search_usage_events" USING btree ("owner_account_id","occurred_at");
