-- oxy:deploy-phase=post
DROP INDEX "clarity_conversations_user_agent_idx";--> statement-breakpoint
ALTER TABLE "clarity_conversations" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "clarity_messages" DROP COLUMN "agent_info";
