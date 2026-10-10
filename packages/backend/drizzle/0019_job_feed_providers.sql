-- oxy:deploy-phase=pre
CREATE TABLE "clarity_job_feed_listings" (
	"feed_id" text NOT NULL,
	"document_id" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "clarity_job_feed_listings_feed_id_document_id_pk" PRIMARY KEY("feed_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "clarity_job_feeds" DROP CONSTRAINT "clarity_job_feeds_kind_check";--> statement-breakpoint
ALTER TABLE "clarity_job_feeds" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "clarity_job_feeds" ADD COLUMN "discovered_from_feed_id" text;--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD COLUMN "seniority" text;--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD COLUMN "benefits" text;--> statement-breakpoint
ALTER TABLE "clarity_job_feed_listings" ADD CONSTRAINT "clarity_job_feed_listings_feed_id_clarity_job_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."clarity_job_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_job_feed_listings" ADD CONSTRAINT "clarity_job_feed_listings_document_id_clarity_search_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."clarity_search_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clarity_job_feed_listings_document_idx" ON "clarity_job_feed_listings" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "clarity_job_postings_seniority_idx" ON "clarity_job_postings" USING btree ("seniority");--> statement-breakpoint
ALTER TABLE "clarity_job_feeds" ADD CONSTRAINT "clarity_job_feeds_kind_check" CHECK ("clarity_job_feeds"."kind" in ('greenhouse', 'lever', 'lever_eu', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'personio', 'breezy', 'gem', 'pinpoint', 'teamtailor', 'manatal', 'rippling', 'bamboohr', 'polymer', 'workday', 'remoteok', 'remotive', 'arbeitnow', 'aidevboard', 'jobicy', 'workingnomads', 'devitjobs', 'artificialintelligencejobs', 'freehire', 'fourdayweek', 'jobtech', 'weworkremotely', 'oracle', 'phenom', 'eightfold', 'successfactors', 'jobvite', 'hireology', 'softgarden', 'jibe', 'homerun', 'madgex', 'getonboard', 'eures', 'feinaactiva', 'karrierenrw', 'jobsadminch', 'rss', 'rss_jsonld', 'sitemap', 'indeed_xml', 'dvinci', 'hrmanager', 'eploy', 'jobscore', 'keka', 'hirehive', 'emply', 'easycruit', 'zvoove', 'jobsoid', 'kalibrr', 'hiringthing', 'trakstar', 'crelate', 'wp_job_manager', 'directory', 'jobboardly'));--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD CONSTRAINT "clarity_job_postings_seniority_check" CHECK ("clarity_job_postings"."seniority" is null or "clarity_job_postings"."seniority" in ('intern', 'entry', 'mid', 'senior', 'lead', 'director', 'executive'));