-- oxy:deploy-phase=pre
-- Image seed colours, copied from Oxy Files the first time a listing finds them.
ALTER TABLE "clarity_image_cache" ADD COLUMN "seeds" text[];
