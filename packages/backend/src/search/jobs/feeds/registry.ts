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
import { sitemap } from './providers/sitemap.js';
import { smartrecruiters } from './providers/smartrecruiters.js';
import { teamtailor } from './providers/teamtailor.js';
import { workable } from './providers/workable.js';
import { workday } from './providers/workday.js';
import { dvinci } from './providers/dvinci.js';
import { hrmanager } from './providers/hrmanager.js';
import { eploy } from './providers/eploy.js';
import { jobscore } from './providers/jobscore.js';
import { keka } from './providers/keka.js';
import { hirehive } from './providers/hirehive.js';
import { emply } from './providers/emply.js';
import { easycruit } from './providers/easycruit.js';
import { zvoove } from './providers/zvoove.js';
import { jobsoid } from './providers/jobsoid.js';
import { kalibrr } from './providers/kalibrr.js';
import { hiringthing } from './providers/hiringthing.js';
import { trakstar } from './providers/trakstar.js';
import { crelate } from './providers/crelate.js';
import { wpjobmanager } from './providers/wpjobmanager.js';
import { directory } from './providers/directory.js';
import { oracle } from './providers/oracle.js';
import { phenom } from './providers/phenom.js';
import { eightfold } from './providers/eightfold.js';
import { successfactors } from './providers/successfactors.js';
import { jobvite } from './providers/jobvite.js';
import { hireology } from './providers/hireology.js';
import { softgarden } from './providers/softgarden.js';
import { jibe } from './providers/jibe.js';
import { homerun } from './providers/homerun.js';
import { eures } from './providers/eures.js';
import { feinaactiva } from './providers/feinaactiva.js';
import { karrierenrw } from './providers/karrierenrw.js';
import { jobsadminch } from './providers/jobsadminch.js';
import { indeedxml } from './providers/indeedxml.js';
import { jobboardly } from './providers/jobboardly.js';
import { jobbnorge } from './providers/jobbnorge.js';
import { pageup } from './providers/pageup.js';
import { madgex } from './providers/madgex.js';
import { getonboard } from './providers/getonboard.js';
import { rssjsonld } from './providers/rssjsonld.js';
import { weworkremotely } from './providers/weworkremotely.js';
import { workingnomads } from './providers/workingnomads.js';

export const JOB_FEED_PROVIDERS: Readonly<Record<JobFeedKind, JobFeedProvider>> = Object.freeze({
  // Applicant tracking systems: one company's own board per feed.
  greenhouse,
  lever,
  lever_eu: leverEu,
  ashby,
  workable,
  recruitee,
  smartrecruiters,
  personio,
  breezy,
  gem,
  pinpoint,
  teamtailor,
  manatal,
  rippling,
  bamboohr,
  polymer,
  workday,
  oracle,
  phenom,
  eightfold,
  successfactors,
  jobvite,
  hireology,
  softgarden,
  jibe,
  homerun,
  dvinci,
  hrmanager,
  eploy,
  jobscore,
  keka,
  hirehive,
  emply,
  easycruit,
  zvoove,
  jobsoid,
  kalibrr,
  hiringthing,
  trakstar,
  crelate,
  // Aggregators and job boards: one feed covers many employers.
  remoteok,
  remotive,
  arbeitnow,
  aidevboard,
  jobicy,
  workingnomads,
  devitjobs,
  artificialintelligencejobs,
  freehire,
  fourdayweek,
  jobtech,
  weworkremotely,
  madgex,
  getonboard,
  jobboardly,
  jobbnorge,
  // Public employment services and public-sector portals.
  eures,
  feinaactiva,
  karrierenrw,
  jobsadminch,
  // Any RSS or Atom job feed, and any sitemap of pages carrying JobPosting.
  rss,
  rss_jsonld: rssjsonld,
  sitemap,
  indeed_xml: indeedxml,
  wp_job_manager: wpjobmanager,
  pageup,
  // Directories of boards, which only register feeds.
  directory,
});

export function jobFeedProvider(kind: JobFeedKind): JobFeedProvider {
  const provider = JOB_FEED_PROVIDERS[kind];
  if (!provider) throw new Error(`Unsupported job feed kind: ${String(kind)}`);
  return provider;
}
