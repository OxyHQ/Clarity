/**
 * Every supported public job source, by kind. Adding a source is a provider
 * module and one line here; the kind list, identifier rules, endpoint and
 * parser all come from the provider.
 */
import type { JobFeedKind } from '@clarity/shared-types';

import type { JobFeedProvider } from './provider.js';
import { aidevboard } from './providers/aidevboard.js';
import { arbeitnow } from './providers/arbeitnow.js';
import { artificialintelligencejobs } from './providers/artificialintelligencejobs.js';
import { ashby } from './providers/ashby.js';
import { bamboohr } from './providers/bamboohr.js';
import { breezy } from './providers/breezy.js';
import { devitjobs } from './providers/devitjobs.js';
import { fourdayweek } from './providers/fourdayweek.js';
import { freehire } from './providers/freehire.js';
import { gem } from './providers/gem.js';
import { greenhouse } from './providers/greenhouse.js';
import { jobicy } from './providers/jobicy.js';
import { jobtech } from './providers/jobtech.js';
import { lever, leverEu } from './providers/lever.js';
import { manatal } from './providers/manatal.js';
import { personio } from './providers/personio.js';
import { pinpoint } from './providers/pinpoint.js';
import { polymer } from './providers/polymer.js';
import { recruitee } from './providers/recruitee.js';
import { remoteok } from './providers/remoteok.js';
import { remotive } from './providers/remotive.js';
import { rippling } from './providers/rippling.js';
import { rss } from './providers/rss.js';
import { smartrecruiters } from './providers/smartrecruiters.js';
import { teamtailor } from './providers/teamtailor.js';
import { workable } from './providers/workable.js';
import { workday } from './providers/workday.js';
import { weworkremotely } from './providers/weworkremotely.js';
import { workingnomads } from './providers/workingnomads.js';

export const JOB_FEED_PROVIDERS: Readonly<Record<JobFeedKind, JobFeedProvider>> = Object.freeze({
  // Applicant tracking systems: one company's own board per feed.
  greenhouse, lever, lever_eu: leverEu, ashby, workable, recruitee, smartrecruiters, personio, breezy, gem, pinpoint,
  teamtailor, manatal, rippling, bamboohr, polymer, workday,
  // Aggregators and job boards: one feed covers many employers.
  remoteok, remotive, arbeitnow, aidevboard, jobicy, workingnomads, devitjobs, artificialintelligencejobs, freehire,
  fourdayweek, jobtech, weworkremotely,
  // Any RSS or Atom job feed.
  rss,
});

export function jobFeedProvider(kind: JobFeedKind): JobFeedProvider {
  const provider = JOB_FEED_PROVIDERS[kind];
  if (!provider) throw new Error(`Unsupported job feed kind: ${String(kind)}`);
  return provider;
}
