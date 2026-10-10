/**
 * d.vinci (DACH) — each company's `jobPublication/list.json`, every
 * publication with full sections, structured locations and salary. A job
 * published in several languages appears once per language; the first
 * publication of each job opening is kept. The responsible user's contact
 * details are never read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  employmentTypesIn,
  get,
  json,
  listing,
  markdown,
  node,
  nodes,
  page,
  place,
  places,
  salary,
  section,
  strings,
  text,
} from '../listing.js';

export const dvinci: JobFeedProvider = {
  kind: 'dvinci',
  identifier: {
    meaning: 'the tenant in <tenant>.dvinci-hr.com',
    shape: 'slug',
    pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}.dvinci-hr.com/jobPublication/list.json`),
  parse(body, context) {
    const seen = new Set<string>();
    return page(
      nodes(json(body, 'dvinci')).map((job) => {
        const opening = node(job.jobOpening);
        const openingId = text(opening.id) ?? text(job.id);
        if (!openingId || seen.has(openingId)) return undefined;
        seen.add(openingId);
        const pay = node(job.salary);
        const range = node(pay.value);
        return listing({
          title: text(job.position),
          employerName: text(node(opening.company).name) ?? context.label ?? context.identifier,
          canonicalUrl: text(job.jobPublicationURL),
          applyUrl: text(job.applicationFormURL),
          context,
          description: markdown(job.introduction, section('Your tasks', job.tasks)),
          qualifications: markdown(job.profile),
          benefits: markdown(job.weOffer),
          // Locations, working times and categories belong to the job opening, not to one publication of it.
          locations: places(
            nodes(opening.locations).map((entry) => {
              const address = node(entry.address);
              const country = node(entry.country);
              return place({
                locality: address.city ?? entry.name,
                postalCode: address.zipCode,
                countryCode: node(address.country).isoA2 ?? country.isoA2,
                country: country.name,
              });
            }),
          ),
          employmentTypes: [
            ...new Set([
              ...employmentTypesIn(
                ...nodes(opening.workingTimes).map((entry) => entry.internalName ?? entry.name),
              ),
              ...(text(node(opening.contractPeriod).internalName) === 'LIMITED'
                ? ['temporary' as const]
                : []),
            ]),
          ],
          salary: salary({
            min: range.min ?? range.value,
            max: range.max ?? range.value,
            currency: pay.currency,
            interval: range.unitText ?? pay.unitText,
          }),
          department: text(node(opening.orgUnit).name),
          occupationalCategory: strings(opening.categories)[0],
          identifier: openingId,
          publishedAt: date(job.startDate),
          validThrough: date(job.endDate),
        });
      }),
    );
  },
};
