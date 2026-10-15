-- oxy:deploy-phase=pre
CREATE TABLE "clarity_account_event_cursors" (
	"application_id" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_experience" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"title" text NOT NULL,
	"employer_oxy_account_id" text NOT NULL,
	"employment_type" text,
	"location" text,
	"start_date" text NOT NULL,
	"end_date" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_experience_start_month_check" CHECK ("clarity_experience"."start_date" ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "clarity_experience_end_month_check" CHECK ("clarity_experience"."end_date" is null or "clarity_experience"."end_date" ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "clarity_experience_period_check" CHECK ("clarity_experience"."end_date" is null or "clarity_experience"."end_date" >= "clarity_experience"."start_date"),
	CONSTRAINT "clarity_experience_employment_type_check" CHECK ("clarity_experience"."employment_type" is null or "clarity_experience"."employment_type" in ('full-time', 'part-time', 'self-employed', 'freelance', 'contract', 'internship', 'apprenticeship', 'seasonal'))
);
--> statement-breakpoint
CREATE TABLE "clarity_experience_erasures" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"erased_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "clarity_experience_user_start_idx" ON "clarity_experience" USING btree ("oxy_user_id","start_date");