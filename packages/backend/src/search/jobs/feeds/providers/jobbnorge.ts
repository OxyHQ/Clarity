/**
 * Jobbnorge (Norway) — the public-sector and academic recruitment portal's
 * keyless JSON API, every live vacancy in one response. Posting pages are
 * nofollow, so the listing links to its own Jobbnorge page and is read from
 * the API.
 */
import type { JobEmploymentType } from '@clarity/shared-types';

import type { JobFeedProvider } from '../provider.js';
import { get, json, listing, node, nodes, page, place, places, text } from '../listing.js';

/** `dd.mm.yyyy`. */
function dottedDate(value: unknown): Date | undefined {
  const match = typeof value === 'string' ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim()) : null;
  return match
    ? new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])))
    : undefined;
}

function scope(value: string | undefined): JobEmploymentType[] {
  if (!value) return [];
  if (/heltid/i.test(value)) return ['full_time'];
  if (/deltid/i.test(value)) return ['part_time'];
  return [];
}

export const jobbnorge: JobFeedProvider = {
  kind: 'jobbnorge',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  completeListing: true,
  request: () => get('https://publicapi.jobbnorge.no/v3/jobs'),
  parse(body, context) {
    return page(
      nodes(node(json(body, 'jobbnorge')).jobs).map((job) => {
        // A fixed-term duration ("Vikariat", "Engasjement") is temporary; "Fast" is permanent.
        const duration = text(job.jobDuration);
        const temporary = duration && /vikariat|engasjement|midlertidig/i.test(duration);
        return listing({
          title: text(job.title),
          employerName: text(job.employer),
          canonicalUrl: text(job.link),
          context,
          description: text(job.summary),
          employerLogoUrl: text(job.logo),
          locations: places(
            nodes(job.locations).map((entry) =>
              place({
                locality: entry.area ?? entry.municipality,
                region: entry.county,
                postalCode: entry.zipCode,
                countryCode: entry.isDomestic === true ? 'NO' : undefined,
              }),
            ),
          ),
          employmentTypes: [
            ...new Set([
              ...scope(text(job.jobScope)),
              ...(temporary ? ['temporary' as const] : []),
            ]),
          ],
          identifier: text(job.id),
          publishedAt: dottedDate(job.publicationDate),
          validThrough: dottedDate(job.deadline),
        });
      }),
    );
  },
};
