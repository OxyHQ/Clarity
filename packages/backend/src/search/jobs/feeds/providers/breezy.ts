/**
 * Breezy HR board JSON — one company's public positions in one response.
 * `verbose=true` adds the full HTML description.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypes, get, json, listing, markdown, node, nodes, page, place, places, salaryText, text,
  DOLLAR_BY_COUNTRY, type Node,
} from '../listing.js';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function breezyPlace(entry: Node) {
  const country = node(entry['country']);
  const code = text(country['id']);
  return place({
    locality: entry['city'],
    region: node(entry['state'])['name'],
    country: country['name'],
    // `worldwide` is Breezy's id for "no country", not a code.
    countryCode: code && code !== 'worldwide' ? code : undefined,
    raw: entry['name'],
  });
}

export const breezy: JobFeedProvider = {
  kind: 'breezy',
  identifier: { meaning: 'the company subdomain in <company>.breezy.hr', shape: 'slug', pattern: DNS_LABEL },
  request: (identifier) => get(`https://${identifier}.breezy.hr/json?verbose=true`),
  parse(body, context) {
    return page(nodes(json(body, 'breezy')).map((job) => {
      const company = node(job['company']);
      const all = nodes(job['locations']).length > 0 ? nodes(job['locations']) : [node(job['location'])];
      const located = places(all.map(breezyPlace));
      const remote = all.length > 0 && all.every((entry) => entry['is_remote'] === true);
      const country = located[0]?.countryCode;
      return listing({
        title: text(job['name']),
        employerName: text(company['name']) ?? context.label ?? context.identifier,
        canonicalUrl: text(job['url']),
        context,
        description: markdown(job['description']),
        employerLogoUrl: text(company['logo_url']),
        // "Fully remote, within chosen location(s)": the locations are where applicants must be.
        ...(remote ? {
          workplaceType: 'remote' as const,
          applicantLocationRequirements: located.map((location) => location.country ?? location.raw),
        } : { locations: located }),
        employmentTypes: employmentTypes(node(job['type'])['id'], node(job['type'])['name']),
        salary: salaryText(job['salary'], { dollar: country ? DOLLAR_BY_COUNTRY[country] : undefined }),
        department: text(job['department']),
        identifier: text(job['id']),
        publishedAt: date(job['published_date']),
      });
    }));
  },
};
