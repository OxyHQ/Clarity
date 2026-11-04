-- oxy:deploy-phase=pre
-- Every URL a fetch was asked for or landed on, and the document it produced
-- (schema/index.ts searchDocumentUrls). A new, empty table: the foreign key's
-- validation reads no rows.
CREATE TABLE "clarity_search_document_urls" (
	"url" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clarity_search_document_urls" ADD CONSTRAINT "clarity_search_document_urls_document_fk" FOREIGN KEY ("document_id") REFERENCES "public"."clarity_search_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clarity_search_document_urls_document_idx" ON "clarity_search_document_urls" USING btree ("document_id");