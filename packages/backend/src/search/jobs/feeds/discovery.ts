/**
 * Board discovery: an aggregator listing that links to an employer's own ATS
 * board names a source Clarity can read directly, with the employer's full
 * data and its own lifecycle. The board is recognized from the URL alone —
 * host and path, never a guess from the employer name — and every result is
 * checked against the provider's own identifier rule before it is returned.
 *
 * Only boards whose provider is keyless and robots-permitted are recognized;
 * SmartRecruiters is deliberately absent (its API is robots-blocked).
 */
import type { JobFeedKind } from '@clarity/shared-types';

import { assertJobFeedIdentifier } from './endpoints.js';

export interface DiscoveredBoard {
  kind: JobFeedKind;
  identifier: string;
}

type Rule = (url: URL, segments: string[]) => DiscoveredBoard | undefined;

/** The ATS's own service hosts, which are not any customer's board. */
const SERVICE_LABELS: ReadonlySet<string> = new Set(['www', 'api', 'app', 'feed', 'jobs', 'help', 'support', 'status', 'blog', 'docs', 'cdn', 'static', 'mail', 'demo', 'careers', 'hire']);

/** `<label>.<suffix>` → label, when the host is exactly one customer label under the suffix. */
function subdomain(host: string, suffix: string): string | undefined {
  if (!host.endsWith(`.${suffix}`)) return undefined;
  const label = host.slice(0, -suffix.length - 1);
  return label && !label.includes('.') && !SERVICE_LABELS.has(label) ? label : undefined;
}

/** Locale segments Workday puts before the site (`/en-US/<site>/job/...`). */
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

/** `/<token>/jobs/<id>`, or the embed form that names the board in `?for=<token>`. */
const greenhouse: Rule = (url, [token]) => {
  const board = token === 'embed' ? url.searchParams.get('for') ?? undefined : token;
  return board ? { kind: 'greenhouse', identifier: board } : undefined;
};

const RULES: Record<string, Rule> = {
  'boards.greenhouse.io': greenhouse,
  'job-boards.greenhouse.io': greenhouse,
  'jobs.lever.co': (_url, [slug]) => (slug ? { kind: 'lever', identifier: slug } : undefined),
  'jobs.eu.lever.co': (_url, [slug]) => (slug ? { kind: 'lever_eu', identifier: slug } : undefined),
  'jobs.ashbyhq.com': (_url, [name]) => (name ? { kind: 'ashby', identifier: name } : undefined),
  // `apply.workable.com/j/<shortcode>` names a job, not an account.
  'apply.workable.com': (_url, [slug]) => (slug && slug !== 'j' && slug !== 'api' ? { kind: 'workable', identifier: slug } : undefined),
  'ats.rippling.com': (_url, [slug, jobs]) => (slug && jobs === 'jobs' ? { kind: 'rippling', identifier: slug } : undefined),
  'jobs.gem.com': (_url, [board]) => (board ? { kind: 'gem', identifier: board } : undefined),
  'www.careers-page.com': (_url, [slug, job]) => (slug && job === 'job' ? { kind: 'manatal', identifier: slug } : undefined),
  'careers-page.com': (_url, [slug, job]) => (slug && job === 'job' ? { kind: 'manatal', identifier: slug } : undefined),
  'jobs.polymer.co': (_url, [slug]) => (slug ? { kind: 'polymer', identifier: slug } : undefined),
  'careers.hireology.com': (_url, [slug]) => (slug && slug !== 'careers' ? { kind: 'hireology', identifier: slug } : undefined),
  'careers.jobscore.com': (_url, [section, company]) => (section === 'careers' && company ? { kind: 'jobscore', identifier: company } : undefined),
  'www.kalibrr.com': (_url, [c, code, jobs]) => (c === 'c' && code && jobs === 'jobs' ? { kind: 'kalibrr', identifier: code } : undefined),
  'jobs.crelate.com': (_url, [portal, name]) => (portal === 'portal' && name ? { kind: 'crelate', identifier: name } : undefined),
};

const SUBDOMAIN_RULES: Array<[suffix: string, kind: JobFeedKind]> = [
  ['recruitee.com', 'recruitee'],
  ['jobs.personio.de', 'personio'],
  ['jobs.personio.com', 'personio'],
  ['breezy.hr', 'breezy'],
  ['pinpointhq.com', 'pinpoint'],
  ['teamtailor.com', 'teamtailor'],
  ['bamboohr.com', 'bamboohr'],
  ['career.softgarden.de', 'softgarden'],
  ['softgarden.io', 'softgarden'],
  ['homerun.co', 'homerun'],
  ['dvinci-hr.com', 'dvinci'],
  ['hirehive.com', 'hirehive'],
  ['keka.com', 'keka'],
  ['easycruit.com', 'easycruit'],
  ['recruit.zvoove.cloud', 'zvoove'],
  ['jobsoid.com', 'jobsoid'],
  ['hiringthing.com', 'hiringthing'],
  ['hire.trakstar.com', 'trakstar'],
];

/** `<tenant>.career.emply.com/<lang>/ad/...`: the board is the tenant in that language. */
function emply(url: URL, segments: string[]): DiscoveredBoard | undefined {
  const tenant = subdomain(url.hostname, 'career.emply.com');
  return tenant && /^[a-z]{2}$/.test(segments[0] ?? '') ? { kind: 'emply', identifier: `${tenant}/${segments[0]}` } : undefined;
}

/** `/hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>` on an Oracle Cloud host. */
function oracle(url: URL, segments: string[]): DiscoveredBoard | undefined {
  if (!url.hostname.endsWith('.oraclecloud.com')) return undefined;
  const index = segments.indexOf('sites');
  const site = index >= 0 ? segments[index + 1] : undefined;
  return segments[0] === 'hcmUI' && site ? { kind: 'oracle', identifier: `${url.hostname}/${site}` } : undefined;
}

function workday(url: URL, segments: string[]): DiscoveredBoard | undefined {
  const match = /^([a-z0-9-]+)\.wd(\d{1,3})\.myworkdayjobs\.com$/.exec(url.hostname);
  if (!match) return undefined;
  const site = LOCALE.test(segments[0] ?? '') ? segments[1] : segments[0];
  if (!site || site === 'wday') return undefined;
  return { kind: 'workday', identifier: `${match[1]}.wd${match[2]}/${site}` };
}

/** The ATS board a listing or application URL belongs to, if Clarity can read it directly. */
export function boardFromUrl(value: string | undefined): DiscoveredBoard | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  let board = RULES[host]?.(url, segments) ?? workday(url, segments) ?? oracle(url, segments) ?? emply(url, segments);
  if (!board) {
    for (const [suffix, kind] of SUBDOMAIN_RULES) {
      const label = subdomain(host, suffix);
      if (label) { board = { kind, identifier: label }; break; }
    }
  }
  if (!board) return undefined;
  try {
    assertJobFeedIdentifier(board.kind, board.identifier);
  } catch {
    return undefined;
  }
  return board;
}
