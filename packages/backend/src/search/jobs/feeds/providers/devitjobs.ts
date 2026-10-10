/**
 * DevITjobs family job feeds — each site publishes its whole board as one XML
 * file. One feed per site: devitjobs.uk, devitjobs.com, germantechjobs.de,
 * swissdevjobs.ch and devitjobs.nl share one schema.
 *
 * `ispromoted` and `cpc` are the sites' paid-placement fields and are never
 * read. A job's `id` carries the ISO week as a suffix (`…-W41`) that changes
 * every week, so only its stable 24-hex prefix identifies the listing.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  DOLLAR_BY_COUNTRY, XML_ACCEPT, elements, employmentTypes, get, listing, markdown, page, place, places, salaryText,
  tag, text,
} from '../listing.js';
import { normalizeCountry } from '../../taxonomy.js';

const SITES = ['devitjobs.uk', 'devitjobs.com', 'germantechjobs.de', 'swissdevjobs.ch', 'devitjobs.nl'] as const;

/** `dd.mm.yyyy`. */
function dottedDate(value: string | undefined): Date | undefined {
  const match = value ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim()) : null;
  if (!match) return undefined;
  const parsed = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export const devitjobs: JobFeedProvider = {
  kind: 'devitjobs',
  identifier: { meaning: `one of ${SITES.join(', ')}`, shape: 'slug', pattern: new RegExp(`^(?:${SITES.map((site) => site.replace(/\./g, '\\.')).join('|')})$`) },
  request: (identifier) => get(`https://${identifier}/job_feed.xml`, XML_ACCEPT),
  // devitjobs.com publishes its whole US board, over 20 MB, as one file.
  maxBodyBytes: 40 * 1024 * 1024,
  parse(body, context) {
    return page(elements(body, 'job').map((job) => {
      const where = text(tag(job, 'location'));
      const remote = where ? /^full(?:y)?\s*remote$/i.test(where) : false;
      const country = text(tag(job, 'country'));
      const code = country ? normalizeCountry(country) : undefined;
      const id = text(tag(job, 'id'))?.replace(/-W\d{1,2}$/, '');
      return listing({
        title: text(tag(job, 'title')) ?? text(tag(job, 'name')),
        employerName: text(tag(job, 'company-name')) ?? text(tag(job, 'company')),
        canonicalUrl: text(tag(job, 'url')) ?? text(tag(job, 'link')),
        context,
        description: markdown(tag(job, 'description')),
        employerLogoUrl: text(tag(job, 'logo')),
        locations: places([place({
          locality: tag(job, 'city'), region: tag(job, 'region'), country, postalCode: tag(job, 'postal_code'),
        })]),
        ...(remote ? { workplaceType: 'remote' as const } : {}),
        employmentTypes: employmentTypes(text(tag(job, 'job-type')) ?? text(tag(job, 'jobtype'))),
        salary: salaryText(tag(job, 'salary'), { dollar: code ? DOLLAR_BY_COUNTRY[code] : undefined }),
        identifier: id,
        publishedAt: dottedDate(text(tag(job, 'pubdate'))),
      });
    }));
  },
};
