/**
 * The Indeed XML job feed format — `<source><job>…</job></source>` — that
 * ATSs, staffing platforms and job boards publish for aggregators, often as a
 * public whole-inventory dump. One adapter reads every publisher of it; the
 * identifier is the feed's https URL.
 *
 * Contact fields (`<email>`, `<phone>`, recruiter names) and the bidding
 * fields of programmatic feeds (`<cpc>`, `<bid>`, `<campaign_id>`) are never
 * read.
 * Feeds commonly put a US state in `<country>`, so when no `<state>` is given a
 * two-letter value that is also a US state code is read as a region, never as
 * the country that shares it ("DE" is Delaware as much as Germany).
 */
import type { JobFeedProvider } from '../provider.js';
import {
  DOLLAR_BY_COUNTRY,
  US_STATE_CODES,
  XML_ACCEPT,
  date,
  elements,
  employmentTypes,
  employmentTypesIn,
  get,
  listing,
  markdown,
  page,
  place,
  places,
  salaryText,
  seniority,
  tag,
  text,
  workplace,
} from '../listing.js';
import { normalizeCountry } from '../../taxonomy.js';
import { withoutTracking } from './pagejsonld.js';

function indeedPlace(job: string) {
  const city = text(tag(job, 'city'));
  const state = text(tag(job, 'state'));
  const countryText = text(tag(job, 'country'));
  // With its own <state>, <country> is the country; without one, a state code there is a state.
  const countryIsState =
    !state && countryText && /^[A-Z]{2}$/.test(countryText) && US_STATE_CODES.has(countryText);
  const region = state ?? (countryIsState ? countryText : undefined);
  const countryCode = countryText && !countryIsState ? normalizeCountry(countryText) : undefined;
  return place({
    locality: city,
    region,
    countryCode,
    country: countryIsState ? undefined : countryText,
    postalCode: tag(job, 'postalcode'),
  });
}

export const indeedxml: JobFeedProvider = {
  kind: 'indeed_xml',
  identifier: { meaning: 'the https URL of a public Indeed-format XML job feed', shape: 'url' },
  completeListing: true,
  request: (identifier) => get(identifier, XML_ACCEPT),
  // Whole-inventory dumps run to hundreds of megabytes (Workable's lists every
  // public Workable job); they are streamed, 20,000 items a poll.
  stream: { element: 'job', listingsPerPoll: 20_000 },
  parse(body, context) {
    const publisher = text(tag(body, 'publisher'));
    return page(
      elements(body, 'job').map((job) => {
        // A job its publisher asked aggregators not to show (confidential, talent pool, opt-out) is not shown.
        if (text(tag(job, 'hide_from_indeed_search'))) return undefined;
        const located = places([indeedPlace(job)]);
        const countryCode = located[0]?.countryCode;
        const remote = text(tag(job, 'remotetype'));
        // Workable writes <remote>true</remote>; Talent.com <isremote>yes</isremote>.
        const remoteFlag = text(tag(job, 'remote')) ?? text(tag(job, 'isremote'));
        const jobType = text(tag(job, 'jobtype'));
        const url = text(tag(job, 'url'));
        return listing({
          title: text(tag(job, 'title')),
          employerName: text(tag(job, 'company')) ?? context.label ?? publisher,
          canonicalUrl: url ? withoutTracking(url) : undefined,
          context,
          description: markdown(tag(job, 'description')),
          employerLogoUrl: text(tag(job, 'logo')),
          locations: located,
          workplaceType: remote
            ? (workplace(remote.split(/[\s,]/)[0]) ?? workplace(remote))
            : remoteFlag && /^(?:true|yes|1)$/i.test(remoteFlag)
              ? 'remote'
              : undefined,
          employerUrl: text(tag(job, 'website')),
          employmentTypes: [
            ...new Set([...employmentTypes(jobType), ...employmentTypesIn(jobType)]),
          ],
          seniority: seniority(tag(job, 'experience')),
          salary: salaryText(tag(job, 'salary'), {
            dollar: countryCode ? DOLLAR_BY_COUNTRY[countryCode] : undefined,
          }),
          educationRequirements: text(tag(job, 'education')),
          occupationalCategory: text(tag(job, 'category')),
          identifier: text(tag(job, 'referencenumber')) ?? text(tag(job, 'requisitionid')),
          publishedAt: date(
            text(tag(job, 'date'))?.replace(/\s+UTC$/, ' GMT') ?? text(tag(job, 'dateposted')),
          ),
          validThrough: date(text(tag(job, 'expirationdate'))),
        });
      }),
    );
  },
};
