/**
 * zvoove Recruit (DACH staffing agencies) — each tenant's public job API: the
 * filtered list states title, place with coordinates and salary; each job's
 * detail adds the sections, country and expiry. The employer is the staffing
 * agency publishing the job. Contact text and messenger fields are never read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, get, json, listing, markdown, nextPageNumber, node, nodes, num, page, place, places, salary, section, text,
} from '../listing.js';

const PAGE_SIZE = 50;

export const zvoove: JobFeedProvider = {
  kind: 'zvoove',
  identifier: { meaning: 'the tenant in <tenant>.recruit.zvoove.cloud', shape: 'slug', pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/ },
  completeListing: true,
  request: (identifier, cursor) => get(`https://${identifier}.recruit.zvoove.cloud/api/public/v1/Stelle/GetStellenFiltered?keywords=&pageNo=${Number(cursor ?? 1) || 1}&pageSize=${PAGE_SIZE}`),
  parse(body, context) {
    const payload = node(json(body, 'zvoove'));
    const items = nodes(payload['Items']);
    const current = Number(context.cursor ?? 1) || 1;
    return page(items.map((job) => {
      const id = text(job['StelleUuid']);
      const slug = text(job['LinkSlug']);
      return listing({
        title: text(job['Bezeichnung']),
        employerName: context.label ?? context.identifier,
        canonicalUrl: id && slug ? `https://${context.identifier}.recruit.zvoove.cloud/stelle/${encodeURIComponent(slug)}-${id.replace(/-/g, '')}` : undefined,
        context,
        locations: places([place({ locality: job['EinsatzortOrt'], postalCode: job['EinsatzortPlz'] })]),
        salary: salary({ min: job['Gehalt'], max: job['GehaltBis'] ?? job['Gehalt'], currency: job['GehaltWaehrung'], interval: job['GehaltZeitraumGoogle'] }),
        identifier: text(job['StellenID']) ?? id,
        publishedAt: date(job['DatumAb']),
      });
    }), nextPageNumber(context.cursor, current * PAGE_SIZE < (num(payload['TotalItems']) ?? 0)));
  },
  detail: {
    optional: true,
    request: (posting, identifier) => {
      const id = /-([0-9a-f]{32})$/.exec(posting.canonicalUrl)?.[1];
      const uuid = id ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : undefined;
      return uuid ? get(`https://${identifier}.recruit.zvoove.cloud/api/public/v1/Stelle/GetStelleById?stelleUuid=${uuid}`) : undefined;
    },
    parse(body, posting, context) {
      const job = node(json(body, 'zvoove'));
      return listing({
        ...posting,
        context,
        // Tenants title these sections themselves ("So bewerben Sie sich:" can sit
        // in the employer-benefit slot), so each keeps its own heading in the description.
        description: markdown(
          section(text(job['ArbeitgebervorstellungHeader']) ?? 'Über uns', job['Arbeitgebervorstellung']),
          section(text(job['AufgabenHeader']) ?? 'Aufgaben', job['Aufgaben']),
          section(text(job['ArbeitgeberleistungHeader']) ?? 'Wir bieten', job['Arbeitgeberleistung']),
        ),
        qualifications: markdown(job['FachlicheAnforderungen']),
        locations: places([place({ locality: job['EinsatzortOrt'], region: job['EinsatzortRegion'], postalCode: job['EinsatzortPlz'], countryCode: job['EinsatzortLandIso002'], country: job['EinsatzortLand'] })]),
        validThrough: date(job['DatumBis']) ?? posting.validThrough,
      });
    },
  },
};
