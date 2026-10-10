-- oxy:deploy-phase=post
-- Default public job sources. Each is a keyless aggregator or board; their
-- listings also seed the employers' own ATS boards through discovery. A row an
-- operator already registered or disabled is left exactly as it is.
INSERT INTO "clarity_job_feeds" ("id", "kind", "identifier", "label") VALUES
  (gen_random_uuid()::text, 'remoteok', 'remoteok', 'RemoteOK'),
  (gen_random_uuid()::text, 'arbeitnow', 'arbeitnow', 'Arbeitnow'),
  (gen_random_uuid()::text, 'aidevboard', 'aidevboard', 'AI Dev Jobs'),
  (gen_random_uuid()::text, 'jobicy', 'jobicy', 'Jobicy'),
  (gen_random_uuid()::text, 'workingnomads', 'workingnomads', 'Working Nomads'),
  (gen_random_uuid()::text, 'weworkremotely', 'weworkremotely', 'We Work Remotely'),
  (gen_random_uuid()::text, 'artificialintelligencejobs', 'artificialintelligencejobs', 'artificialintelligencejobs.co'),
  (gen_random_uuid()::text, 'fourdayweek', 'fourdayweek', '4dayweek.io'),
  (gen_random_uuid()::text, 'jobtech', 'jobtech', 'Arbetsförmedlingen JobTech'),
  (gen_random_uuid()::text, 'devitjobs', 'devitjobs.uk', 'DevITjobs UK'),
  (gen_random_uuid()::text, 'devitjobs', 'devitjobs.com', 'DevITjobs US'),
  (gen_random_uuid()::text, 'devitjobs', 'germantechjobs.de', 'GermanTechJobs'),
  (gen_random_uuid()::text, 'devitjobs', 'swissdevjobs.ch', 'SwissDevJobs'),
  (gen_random_uuid()::text, 'devitjobs', 'devitjobs.nl', 'DevITjobs NL'),
  (gen_random_uuid()::text, 'freehire', 'freehire', 'freehire'),
  (gen_random_uuid()::text, 'freehire', 'source=greenhouse', 'freehire · Greenhouse'),
  (gen_random_uuid()::text, 'freehire', 'source=lever', 'freehire · Lever'),
  (gen_random_uuid()::text, 'freehire', 'source=ashby', 'freehire · Ashby'),
  (gen_random_uuid()::text, 'freehire', 'source=workday', 'freehire · Workday'),
  (gen_random_uuid()::text, 'freehire', 'source=personio', 'freehire · Personio'),
  (gen_random_uuid()::text, 'freehire', 'source=recruitee', 'freehire · Recruitee'),
  (gen_random_uuid()::text, 'freehire', 'source=bamboohr', 'freehire · BambooHR'),
  (gen_random_uuid()::text, 'freehire', 'source=rippling', 'freehire · Rippling'),
  (gen_random_uuid()::text, 'freehire', 'source=breezy', 'freehire · Breezy'),
  (gen_random_uuid()::text, 'freehire', 'source=pinpoint', 'freehire · Pinpoint'),
  (gen_random_uuid()::text, 'freehire', 'source=workable', 'freehire · Workable')
ON CONFLICT ("kind", "identifier") DO NOTHING;
