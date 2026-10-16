-- oxy:deploy-phase=post
-- Owner decision 2026-10-16: Clarity's own conversation history is deleted, not
-- migrated (a person's conversations with the Clarity agent are Alia's). Plans
-- unlock Alia power levels through plan features, so the Clarity model ids are
-- gone, and readiness no longer pins an Alia agent id. Post: the previous image
-- still reads and writes all four until it stops serving.
DROP TABLE "clarity_messages" CASCADE;--> statement-breakpoint
DROP TABLE "clarity_conversations" CASCADE;--> statement-breakpoint
ALTER TABLE "clarity_plans" DROP COLUMN "model_ids";--> statement-breakpoint
ALTER TABLE "clarity_runtime_state" DROP COLUMN "alia_agent_id_sha256";
