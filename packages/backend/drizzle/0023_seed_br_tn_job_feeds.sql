-- oxy:deploy-phase=post
-- Two more keyless public job sources, verified live before seeding: robots.txt
-- (group ClarityBot else *) permits the posting paths, the pages are not
-- noindex, their terms of use do not forbid automated indexing, and a real poll
-- against PostgreSQL stored listings cleanly with zero rejected. Each posting
-- page carries schema.org JobPosting JSON-LD with a recoverable employer. Their
-- listings also seed the employers' own ATS boards through discovery. A row an
-- operator already registered or disabled is left exactly as it is.
INSERT INTO "clarity_job_feeds" ("id", "kind", "identifier", "label") VALUES
  (gen_random_uuid()::text, 'sitemap', 'https://programathor.com.br/sitemap.xml#/jobs/', 'Programathor (Brazil)'),
  (gen_random_uuid()::text, 'sitemap', 'https://www.keejob.com/sitemap-jobs.xml', 'Keejob (Tunisia)')
ON CONFLICT ("kind", "identifier") DO NOTHING;
