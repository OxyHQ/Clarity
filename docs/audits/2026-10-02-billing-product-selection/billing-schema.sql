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
CREATE INDEX "clarity_plans_product_sort_idx" ON "clarity_plans" USING btree ("product","sort_order");
CREATE INDEX "clarity_plans_product_active_idx" ON "clarity_plans" USING btree ("product","is_active");
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
CREATE INDEX "clarity_subscriptions_user_status_idx" ON "clarity_subscriptions" USING btree ("oxy_user_id","status");
CREATE INDEX "clarity_subscriptions_user_plan_status_idx" ON "clarity_subscriptions" USING btree ("oxy_user_id","plan_id","status");
CREATE INDEX "clarity_subscriptions_customer_idx" ON "clarity_subscriptions" USING btree ("stripe_customer_id");
