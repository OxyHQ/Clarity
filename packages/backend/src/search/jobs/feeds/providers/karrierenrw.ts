/**
 * Karriere.NRW — North Rhine-Westphalia's public-sector job portal (state,
 * municipalities and their bodies), under Datenlizenz Deutschland –
 * Namensnennung 2.0. The search lists ten a page; each posting's detail adds
 * the full description, address and coordinates, working time, fixed-term
 * status and deadline. Contact people are never read, and pay grades
 * ("A 14", "TVöD 14") are grades, not amounts, so they are not a salary.
 */
import type { JobEmploymentType } from '@clarity/shared-types';

import type { JobFeedProvider } from '../provider.js';
import {
  date,
  get,
  json,
  listing,
  markdown,
  nextPageNumber,
  node,
  nodes,
  num,
  page,
  place,
  places,
  strings,
  text,
} from '../listing.js';

function types(workingTime: unknown, fixedTerm: unknown): JobEmploymentType[] {
  const found = new Set<JobEmploymentType>();
  for (const value of strings(workingTime)) {
    if (/vollzeit/i.test(value)) found.add('full_time');
    if (/teilzeit/i.test(value)) found.add('part_time');
  }
  if (typeof fixedTerm === 'string' && /^befristet/i.test(fixedTerm)) found.add('temporary');
  return [...found];
}

export const karrierenrw: JobFeedProvider = {
  kind: 'karrierenrw',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  request: (_identifier, cursor) =>
    get(`https://api.karriere.nrw/v1.0/opennrw/suche?page=${Number(cursor ?? 1) || 1}`),
  terms: 'Datenlizenz Deutschland – Namensnennung 2.0: attribution to Karriere.NRW.',
  parse(body, context) {
    const payload = node(json(body, 'karrierenrw'));
    const items = nodes(payload.items);
    const current = Number(context.cursor ?? 1) || 1;
    return page(
      items.map((item) => {
        const id = text(item.uuid);
        return listing({
          title: text(item.title),
          employerName: text(item.authority) ?? text(item.contracting_authority),
          canonicalUrl: id
            ? `https://www.karriere.nrw/stellenausschreibung/${encodeURIComponent(id)}`
            : undefined,
          context,
          locations: places([place({ locality: item.location })]),
          identifier: id,
          publishedAt: date(item.published),
          validThrough: date(item.deadline),
        });
      }),
      nextPageNumber(context.cursor, current < (num(payload.pages) ?? 0)),
    );
  },
  detail: {
    optional: true,
    request: (posting) =>
      posting.identifier
        ? get(
            `https://api.karriere.nrw/v1.0/combined-jobs/${encodeURIComponent(posting.identifier)}/`,
          )
        : undefined,
    parse(body, posting, context) {
      const job = node(json(body, 'karrierenrw'));
      const office = node(job.dienststelle);
      return listing({
        ...posting,
        context,
        title: text(job.titel_der_stelle) ?? posting.title,
        employerName: text(job.behoerde) ?? posting.employerName,
        employerUrl: text(office.webseite),
        description: markdown(job.stellenbeschreibung),
        locations: places([
          place({
            raw: job.address_display,
            locality: job.ort ?? office.ort,
            postalCode: office.plz,
          }),
        ]),
        employmentTypes: types(job.arbeitszeit_display, job.befristung_display),
        occupationalCategory: strings(job.taetigkeitsfeld_display)[0],
        publishedAt: date(job.erscheinungsdatum) ?? posting.publishedAt,
        validThrough: date(job.bewerbungsfrist) ?? posting.validThrough,
      });
    },
  },
};
