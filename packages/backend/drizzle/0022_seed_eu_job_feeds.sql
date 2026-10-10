-- oxy:deploy-phase=post
-- European public job sources, keyless, each verified live before seeding:
-- robots.txt (group ClarityBot else *) permits the posting paths, the pages
-- are not noindex, and their terms of use do not forbid automated indexing.
-- The sitemap feeds carry schema.org JobPosting JSON-LD on each posting page;
-- the two RSS feeds name the employer per item (dc:creator). Their listings
-- also seed the employers' own ATS boards through discovery. A row an operator
-- already registered or disabled is left exactly as it is.
INSERT INTO "clarity_job_feeds" ("id", "kind", "identifier", "label") VALUES
  (gen_random_uuid()::text, 'sitemap', 'https://www.reed.co.uk/sitemap/live-jobs-1.xml#/jobs/', 'Reed (UK)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.reed.co.uk/sitemap/live-jobs-2.xml#/jobs/', 'Reed (UK)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.reed.co.uk/sitemap/live-jobs-3.xml#/jobs/', 'Reed (UK)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.karriere.at/static/sitemaps/sitemap-jobs-https.xml#/jobs/', 'karriere.at (Austria)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.dobraprace.cz/sitemap/ads/', 'dobraprace.cz (Czechia)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.hipo.ro/sitemap_lastjobs.xml', 'hipo.ro (Romania)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.mynextjob.ro/sitemap-anunturi.xml', 'mynextjob.ro (Romania)'),
  (gen_random_uuid()::text, 'sitemap', 'https://thehub.io/sitemap-jobs.xml#/jobs/', 'The Hub (Nordics)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.jobbird.com/nl/sitemaps/jobs.xml#/nl/vacature/', 'Jobbird (Netherlands)'),
  (gen_random_uuid()::text, 'rss', 'https://www.net-empregos.com/rss.asp', 'Net-Empregos (Portugal)'),
  (gen_random_uuid()::text, 'rss', 'https://www.tvinna.is/feed/?post_type=job_listing', 'Tvinna (Iceland)')
ON CONFLICT ("kind", "identifier") DO NOTHING;
