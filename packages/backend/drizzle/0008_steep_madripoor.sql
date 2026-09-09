-- oxy:deploy-phase=pre
CREATE TABLE "clarity_job_clusters" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_job_posting_id" text,
	"member_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_job_clusters_member_count_check" CHECK ("clarity_job_clusters"."member_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "clarity_job_posting_signatures" (
	"job_posting_id" text NOT NULL,
	"signature" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_job_posting_signatures_pk" PRIMARY KEY("job_posting_id","signature"),
	CONSTRAINT "clarity_job_posting_signatures_kind_check" CHECK ("clarity_job_posting_signatures"."kind" in ('identifier', 'listing_url', 'content'))
);
--> statement-breakpoint
CREATE TABLE "clarity_job_postings" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"source_key" text NOT NULL,
	"cluster_id" text,
	"canonical_url" text NOT NULL,
	"apply_url" text,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"description" text,
	"description_fingerprint" text,
	"employer_name" text NOT NULL,
	"employer_url" text,
	"employer_domain" text,
	"employer_logo_url" text,
	"employer_key" text,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"location_regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"location_localities" text[] DEFAULT '{}'::text[] NOT NULL,
	"applicant_location_requirements" text[] DEFAULT '{}'::text[] NOT NULL,
	"workplace_type" text,
	"employment_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"salary_min" double precision,
	"salary_max" double precision,
	"salary_currency" text,
	"salary_interval" text,
	"salary_annual_min" double precision,
	"salary_annual_max" double precision,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"qualifications" text,
	"responsibilities" text,
	"education_requirements" text,
	"experience_requirements" text,
	"industry" text,
	"occupational_category" text,
	"identifier" text,
	"direct_apply" boolean,
	"published_at" timestamp with time zone,
	"valid_through" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"closure_reason" text,
	"closed_at" timestamp with time zone,
	"source_type" text DEFAULT 'web' NOT NULL,
	"source_domain" text NOT NULL,
	"submitted_by_application_id" text,
	"field_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_vector" "tsvector" NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_job_postings_document_source_unique" UNIQUE("document_id","source_key"),
	CONSTRAINT "clarity_job_postings_status_check" CHECK ("clarity_job_postings"."status" in ('active', 'expired', 'closed', 'removed', 'stale')),
	CONSTRAINT "clarity_job_postings_workplace_check" CHECK ("clarity_job_postings"."workplace_type" is null or "clarity_job_postings"."workplace_type" in ('remote', 'hybrid', 'onsite')),
	CONSTRAINT "clarity_job_postings_source_type_check" CHECK ("clarity_job_postings"."source_type" in ('web', 'verified_site', 'first_party')),
	CONSTRAINT "clarity_job_postings_salary_interval_check" CHECK ("clarity_job_postings"."salary_interval" is null or "clarity_job_postings"."salary_interval" in ('hour', 'day', 'week', 'month', 'year')),
	CONSTRAINT "clarity_job_postings_salary_currency_check" CHECK ("clarity_job_postings"."salary_currency" is null or "clarity_job_postings"."salary_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "clarity_job_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"job_posting_id" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_job_reports_reason_check" CHECK ("clarity_job_reports"."reason" in ('scam', 'already_filled', 'duplicate', 'misleading', 'discriminatory', 'other')),
	CONSTRAINT "clarity_job_reports_status_check" CHECK ("clarity_job_reports"."status" in ('open', 'reviewed', 'actioned', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "clarity_search_documents" DROP CONSTRAINT "clarity_search_documents_type_check";--> statement-breakpoint
ALTER TABLE "clarity_job_posting_signatures" ADD CONSTRAINT "clarity_job_posting_signatures_job_posting_id_clarity_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."clarity_job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD CONSTRAINT "clarity_job_postings_document_id_clarity_search_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."clarity_search_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD CONSTRAINT "clarity_job_postings_cluster_id_clarity_job_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clarity_job_clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_job_reports" ADD CONSTRAINT "clarity_job_reports_job_posting_id_clarity_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."clarity_job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clarity_job_posting_signatures_signature_idx" ON "clarity_job_posting_signatures" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_status_published_idx" ON "clarity_job_postings" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_status_last_seen_idx" ON "clarity_job_postings" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_valid_through_idx" ON "clarity_job_postings" USING btree ("valid_through");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_cluster_idx" ON "clarity_job_postings" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_employer_idx" ON "clarity_job_postings" USING btree ("employer_key");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_source_domain_idx" ON "clarity_job_postings" USING btree ("source_domain");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_canonical_url_idx" ON "clarity_job_postings" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_search_idx" ON "clarity_job_postings" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_countries_idx" ON "clarity_job_postings" USING gin ("location_countries");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_employment_types_idx" ON "clarity_job_postings" USING gin ("employment_types");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_skills_idx" ON "clarity_job_postings" USING gin ("skills");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_title_trgm_idx" ON "clarity_job_postings" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clarity_job_reports_status_created_idx" ON "clarity_job_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "clarity_job_reports_posting_idx" ON "clarity_job_reports" USING btree ("job_posting_id");--> statement-breakpoint
ALTER TABLE "clarity_search_documents" ADD CONSTRAINT "clarity_search_documents_type_check" CHECK ("clarity_search_documents"."document_type" in ('page', 'article', 'news', 'job', 'product', 'video', 'event', 'recipe', 'profile', 'documentation', 'other'));