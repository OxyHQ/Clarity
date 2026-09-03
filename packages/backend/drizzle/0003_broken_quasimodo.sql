-- oxy:deploy-phase=pre
ALTER TABLE "clarity_plan_features" ADD COLUMN "id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clarity_plan_features" ADD CONSTRAINT "clarity_plan_features_id_unique" UNIQUE("id");
