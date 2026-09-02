-- oxy:deploy-phase=pre
ALTER TABLE "clarity_runtime_state" ADD COLUMN "alia_agent_id_sha256" text;
