-- oxy:deploy-phase=post
-- Asia-Pacific public job sources, each a keyless sitemap of posting pages that
-- carry schema.org JobPosting JSON-LD, verified live before seeding. Their
-- listings also seed the employers' own ATS boards through discovery. A row an
-- operator already registered or disabled is left exactly as it is.
INSERT INTO "clarity_job_feeds" ("id", "kind", "identifier", "label") VALUES
  (gen_random_uuid()::text, 'sitemap', 'https://www.rozee.pk/sitemap/jobs.xml', 'Rozee.pk (Pakistan)'),
  (gen_random_uuid()::text, 'sitemap', 'https://type.jp/sitemaps-job-detail.xml#/job-', 'type.jp (Japan)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.tokyodev.com/sitemap.xml#/companies/', 'TokyoDev (Japan)')
ON CONFLICT ("kind", "identifier") DO NOTHING;
