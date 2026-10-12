-- oxy:deploy-phase=pre
-- Which image-render pipeline produced each cached image (0 = before
-- renditions existed: possibly a site's original bytes). Rows below the current
-- rendition are re-rendered on read and by the worker, so no original is kept.
ALTER TABLE "clarity_image_cache" ADD COLUMN "rendition" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "clarity_image_cache_rendition_idx" ON "clarity_image_cache" USING btree ("rendition") WHERE "clarity_image_cache"."status" = 'ready';