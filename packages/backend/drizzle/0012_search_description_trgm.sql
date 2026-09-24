-- oxy:deploy-phase=pre
CREATE INDEX "clarity_search_documents_description_trgm_idx" ON "clarity_search_documents" USING gin ("description" gin_trgm_ops);