/**
 * freehire — an open aggregator of public ATS boards, newest first.
 *
 * Its API serves at most the first 10,000 rows of any query, so a feed is one
 * slice: the identifier is `freehire` for everything, or a filter such as
 * `source=workday&countries=us`. Sources whose terms keep their listings out
 * of third-party search engines, that need a key, or that Clarity reads
 * directly (so their own attribution stays intact) are always excluded.
 *
 * freehire's `enrichment` block is its own model's reading of each posting,
 * and its view/vote counters are engagement signals; neither is read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  get,
  json,
  listing,
  locationText,
  markdown,
  nextOffset,
  node,
  nodes,
  num,
  page,
  places,
  strings,
  text,
  workplace,
} from '../listing.js';
import { normalizeCountry } from '../../taxonomy.js';

const PAGE_SIZE = 100;
const QUERY_WINDOW = 10_000;
const SLICE_KEYS = [
  'source',
  'countries',
  'regions',
  'category',
  'work_mode',
  'company_slug',
  'posting_language',
] as const;
const IDENTIFIER = new RegExp(
  `^(?:freehire|(?:${SLICE_KEYS.join('|')})=[a-z0-9_.-]{1,60}(?:&(?:${SLICE_KEYS.join('|')})=[a-z0-9_.-]{1,60}){0,5})$`,
);
const EXCLUDED_SOURCES = [
  // Keyed or licence-restricted upstreams.
  'adzuna',
  'reed',
  'himalayas',
  'themuse',
  // Read directly by Clarity, under their own attribution.
  'remoteok',
  'remotive',
  'arbeitnow',
  'jobicy',
  '4dayweek',
  'jobtech',
  'workingnomads',
];

function searchUrl(identifier: string, cursor?: string): string {
  const target = new URL('https://freehire.me/api/v1/agent/jobs/search');
  target.searchParams.set('limit', String(PAGE_SIZE));
  target.searchParams.set('offset', String(Number(cursor ?? 0)));
  target.searchParams.set('sort', 'posted_at');
  target.searchParams.set('order', 'desc');
  // Several upstreams store Markdown inside HTML; freehire's Markdown rendering reads both cleanly.
  target.searchParams.set('description_format', 'markdown');
  for (const source of EXCLUDED_SOURCES) target.searchParams.append('source_exclude', source);
  if (identifier !== 'freehire') {
    for (const pair of identifier.split('&')) {
      const [key, value] = pair.split('=');
      target.searchParams.append(key, value);
    }
  }
  return target.toString();
}

export const freehire: JobFeedProvider = {
  kind: 'freehire',
  identifier: {
    meaning: '`freehire`, or a slice such as source=workday&countries=us',
    shape: 'slug',
    pattern: IDENTIFIER,
  },
  request: (identifier, cursor) => get(searchUrl(identifier, cursor)),
  terms: 'No scraping beyond the documented API; respect its rate limits.',
  parse(body, context) {
    const payload = node(json(body, 'freehire'));
    const jobs = nodes(payload['data']);
    const meta = node(payload['meta']);
    return page(
      jobs.map((job) => {
        if (job['closed_at']) return undefined;
        const slug = text(job['public_slug']);
        const countries = strings(job['countries'])
          .map((code) => normalizeCountry(code))
          .filter(Boolean);
        const [located] = locationText(text(job['location']));
        return listing({
          title: text(job['title']),
          employerName: text(job['company']),
          canonicalUrl: slug ? `https://freehire.me/jobs/${encodeURIComponent(slug)}` : undefined,
          applyUrl: text(job['url']),
          context,
          description: markdown(job['description']),
          // A single stated country completes a text location that named none.
          locations: places([
            located && !located.countryCode && countries.length === 1
              ? { ...located, countryCode: countries[0] }
              : located,
          ]),
          workplaceType: workplace(job['work_mode']),
          skills: strings(job['skills'], 20),
          identifier: text(job['external_id']),
          publishedAt: date(job['posted_at'] ?? job['created_at']),
        });
      }),
      nextOffset(
        context.cursor,
        jobs.length,
        PAGE_SIZE,
        Math.min(num(meta['total']) ?? QUERY_WINDOW, QUERY_WINDOW),
      ),
    );
  },
};
