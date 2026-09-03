-- oxy:deploy-phase=pre
CREATE TABLE "clarity_backfill_receipts" (
	"source_collection" text NOT NULL,
	"source_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_backfill_receipts_pk" PRIMARY KEY("source_collection","source_id")
);
--> statement-breakpoint
CREATE TABLE "clarity_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"is_manual_title" boolean DEFAULT false NOT NULL,
	"last_message" text,
	"source" text DEFAULT 'app' NOT NULL,
	"folder_id" text,
	"icon" text,
	"icon_color" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_conversations_user_conversation_unique" UNIQUE("oxy_user_id","conversation_id"),
	CONSTRAINT "clarity_conversations_source_check" CHECK ("clarity_conversations"."source" in ('app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack'))
);
--> statement-breakpoint
CREATE TABLE "clarity_credit_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"name" text NOT NULL,
	"credits" integer NOT NULL,
	"price" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"stripe_price_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_credit_packages_package_id_unique" UNIQUE("package_id"),
	CONSTRAINT "clarity_credit_packages_credits_check" CHECK ("clarity_credit_packages"."credits" > 0),
	CONSTRAINT "clarity_credit_packages_price_check" CHECK ("clarity_credit_packages"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "clarity_features" (
	"id" text PRIMARY KEY NOT NULL,
	"feature_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"icon" text,
	"category" text NOT NULL,
	"feature_type" text DEFAULT 'boolean' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible_on_pricing" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_features_feature_id_unique" UNIQUE("feature_id"),
	CONSTRAINT "clarity_features_type_check" CHECK ("clarity_features"."feature_type" in ('boolean', 'limit'))
);
--> statement-breakpoint
CREATE TABLE "clarity_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"vote" text,
	"tool_invocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_info" jsonb,
	"audio_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_messages_role_check" CHECK ("clarity_messages"."role" in ('user', 'assistant', 'system')),
	CONSTRAINT "clarity_messages_vote_check" CHECK ("clarity_messages"."vote" is null or "clarity_messages"."vote" in ('up', 'down'))
);
--> statement-breakpoint
CREATE TABLE "clarity_plan_features" (
	"plan_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit_value" integer,
	"display_label" text,
	"display_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_plan_features_pk" PRIMARY KEY("plan_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "clarity_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"name" text NOT NULL,
	"product" text NOT NULL,
	"credits_per_month" integer DEFAULT 0 NOT NULL,
	"daily_free_credits" integer DEFAULT 300 NOT NULL,
	"monthly_price" integer DEFAULT 0 NOT NULL,
	"annual_price" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"credits_label" text DEFAULT '' NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"model_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"stripe_product_id" text,
	"stripe_monthly_price_id" text,
	"stripe_annual_price_id" text,
	"description" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_plans_plan_id_unique" UNIQUE("plan_id"),
	CONSTRAINT "clarity_plans_product_check" CHECK ("clarity_plans"."product" in ('clarity', 'codea')),
	CONSTRAINT "clarity_plans_prices_check" CHECK ("clarity_plans"."monthly_price" >= 0 and "clarity_plans"."annual_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "clarity_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"suggestion_id" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"description" text,
	"is_template" boolean DEFAULT false NOT NULL,
	"template_variables" text[] DEFAULT '{}'::text[] NOT NULL,
	"type" text NOT NULL,
	"category" text,
	"trigger_words" text[] DEFAULT '{}'::text[] NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"oxy_user_id" text,
	"language" text DEFAULT 'en-US' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"is_ai_generated" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"occupations" text[] DEFAULT '{}'::text[] NOT NULL,
	"interests" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_suggestions_suggestion_id_unique" UNIQUE("suggestion_id"),
	CONSTRAINT "clarity_suggestions_type_check" CHECK ("clarity_suggestions"."type" in ('welcome', 'autocomplete')),
	CONSTRAINT "clarity_suggestions_scope_check" CHECK ("clarity_suggestions"."scope" in ('global', 'personal')),
	CONSTRAINT "clarity_suggestions_usage_count_check" CHECK ("clarity_suggestions"."usage_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "clarity_messages" ADD CONSTRAINT "clarity_messages_conversation_fk" FOREIGN KEY ("oxy_user_id","conversation_id") REFERENCES "public"."clarity_conversations"("oxy_user_id","conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_plan_features" ADD CONSTRAINT "clarity_plan_features_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."clarity_plans"("plan_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_plan_features" ADD CONSTRAINT "clarity_plan_features_feature_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."clarity_features"("feature_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clarity_conversations_user_updated_idx" ON "clarity_conversations" USING btree ("oxy_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "clarity_conversations_user_agent_idx" ON "clarity_conversations" USING btree ("oxy_user_id","agent_id");--> statement-breakpoint
CREATE INDEX "clarity_credit_packages_active_sort_idx" ON "clarity_credit_packages" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE INDEX "clarity_features_category_sort_idx" ON "clarity_features" USING btree ("category","sort_order");--> statement-breakpoint
CREATE INDEX "clarity_messages_conversation_created_idx" ON "clarity_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "clarity_messages_user_conversation_idx" ON "clarity_messages" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "clarity_plan_features_feature_idx" ON "clarity_plan_features" USING btree ("feature_id");--> statement-breakpoint
CREATE INDEX "clarity_plans_product_sort_idx" ON "clarity_plans" USING btree ("product","sort_order");--> statement-breakpoint
CREATE INDEX "clarity_plans_product_active_idx" ON "clarity_plans" USING btree ("product","is_active");--> statement-breakpoint
CREATE INDEX "clarity_suggestions_scope_language_type_idx" ON "clarity_suggestions" USING btree ("scope","language","type");--> statement-breakpoint
CREATE INDEX "clarity_suggestions_user_scope_idx" ON "clarity_suggestions" USING btree ("oxy_user_id","scope");--> statement-breakpoint
CREATE INDEX "clarity_suggestions_expires_idx" ON "clarity_suggestions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "clarity_suggestions_trigger_words_idx" ON "clarity_suggestions" USING gin ("trigger_words");
