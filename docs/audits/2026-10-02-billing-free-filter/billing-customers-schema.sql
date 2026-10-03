-- oxy:deploy-phase=pre
CREATE TABLE "clarity_billing_customers" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clarity_billing_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
