-- oxy:deploy-phase=pre
CREATE INDEX "clarity_suggestions_text_search_idx" ON "clarity_suggestions" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("text", '')));
