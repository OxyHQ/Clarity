-- oxy:deploy-phase=pre
ALTER TABLE "clarity_job_feeds" DROP CONSTRAINT "clarity_job_feeds_kind_check";--> statement-breakpoint
ALTER TABLE "clarity_job_feeds" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD COLUMN "seniority" text;--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD COLUMN "benefits" text;--> statement-breakpoint
CREATE INDEX "clarity_job_postings_seniority_idx" ON "clarity_job_postings" USING btree ("seniority");--> statement-breakpoint
ALTER TABLE "clarity_job_feeds" ADD CONSTRAINT "clarity_job_feeds_kind_check" CHECK ("clarity_job_feeds"."kind" in ('greenhouse', 'lever', 'lever_eu', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'personio', 'breezy', 'gem', 'pinpoint', 'teamtailor', 'manatal', 'rippling', 'bamboohr', 'polymer', 'workday', 'remoteok', 'remotive', 'arbeitnow', 'aidevboard', 'jobicy', 'workingnomads', 'devitjobs', 'artificialintelligencejobs', 'freehire', 'fourdayweek', 'jobtech', 'weworkremotely', 'rss'));--> statement-breakpoint
ALTER TABLE "clarity_job_postings" ADD CONSTRAINT "clarity_job_postings_seniority_check" CHECK ("clarity_job_postings"."seniority" is null or "clarity_job_postings"."seniority" in ('intern', 'entry', 'mid', 'senior', 'lead', 'director', 'executive'));