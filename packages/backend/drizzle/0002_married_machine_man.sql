-- oxy:deploy-phase=pre
CREATE TABLE "clarity_billing_customers" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_billing_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "clarity_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"rating" integer,
	"message" text NOT NULL,
	"email" text,
	"metadata" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_feedback_type_check" CHECK ("clarity_feedback"."type" in ('bug', 'feature', 'improvement', 'other')),
	CONSTRAINT "clarity_feedback_status_check" CHECK ("clarity_feedback"."status" in ('pending', 'reviewed', 'resolved')),
	CONSTRAINT "clarity_feedback_rating_check" CHECK ("clarity_feedback"."rating" is null or "clarity_feedback"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "clarity_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"delivery_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"trigger_id" text,
	"conversation_id" text,
	"expires_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_notifications_type_check" CHECK ("clarity_notifications"."type" in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service')),
	CONSTRAINT "clarity_notifications_status_check" CHECK ("clarity_notifications"."status" in ('pending', 'sent', 'read', 'dismissed')),
	CONSTRAINT "clarity_notifications_priority_check" CHECK ("clarity_notifications"."priority" in ('low', 'normal', 'high', 'urgent'))
);
--> statement-breakpoint
CREATE TABLE "clarity_push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"token" text NOT NULL,
	"device_id" text,
	"platform" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_push_tokens_user_token_unique" UNIQUE("oxy_user_id","token"),
	CONSTRAINT "clarity_push_tokens_platform_check" CHECK ("clarity_push_tokens"."platform" is null or "clarity_push_tokens"."platform" in ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "clarity_runtime_state" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"reconciled_at" timestamp with time zone NOT NULL,
	"source_counts" jsonb NOT NULL,
	"target_counts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_runtime_state_status_check" CHECK ("clarity_runtime_state"."status" in ('reconciled', 'cutover'))
);
--> statement-breakpoint
CREATE TABLE "clarity_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"plan_id" text,
	"billing_period" text DEFAULT 'monthly' NOT NULL,
	"plan_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "clarity_subscriptions_status_check" CHECK ("clarity_subscriptions"."status" in ('active', 'canceled', 'past_due', 'unpaid', 'trialing', 'incomplete', 'incomplete_expired')),
	CONSTRAINT "clarity_subscriptions_period_check" CHECK ("clarity_subscriptions"."billing_period" in ('monthly', 'annual'))
);
--> statement-breakpoint
CREATE TABLE "clarity_web_push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_web_push_user_endpoint_unique" UNIQUE("oxy_user_id","endpoint")
);
--> statement-breakpoint
CREATE INDEX "clarity_feedback_user_created_idx" ON "clarity_feedback" USING btree ("oxy_user_id","created_at");--> statement-breakpoint
CREATE INDEX "clarity_feedback_status_idx" ON "clarity_feedback" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clarity_feedback_type_idx" ON "clarity_feedback" USING btree ("type");--> statement-breakpoint
CREATE INDEX "clarity_notifications_user_status_created_idx" ON "clarity_notifications" USING btree ("oxy_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "clarity_notifications_expires_idx" ON "clarity_notifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "clarity_push_tokens_token_idx" ON "clarity_push_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "clarity_subscriptions_user_status_idx" ON "clarity_subscriptions" USING btree ("oxy_user_id","status");--> statement-breakpoint
CREATE INDEX "clarity_subscriptions_user_plan_status_idx" ON "clarity_subscriptions" USING btree ("oxy_user_id","plan_id","status");--> statement-breakpoint
CREATE INDEX "clarity_subscriptions_customer_idx" ON "clarity_subscriptions" USING btree ("stripe_customer_id");
