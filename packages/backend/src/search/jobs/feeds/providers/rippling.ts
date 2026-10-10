/**
 * Rippling ATS board API. The list is one row per job AND location, with no
 * description or pay; rows are folded into one listing per job and each job's
 * detail adds the description, pay ranges, employment type and date.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypesIn, get, json, listing, markdown, node, nodes, num, page, place, places,
  salary, text, workplace, type Node,
} from '../listing.js';

const PAGE_SIZE = 1000;

function ripplingPlace(entry: Node) {
  return place({
    locality: entry['city'], region: entry['state'], country: entry['country'], countryCode: entry['countryCode'], raw: entry['name'],
  });
}

export const rippling: JobFeedProvider = {
  kind: 'rippling',
  identifier: { meaning: 'the board slug in ats.rippling.com/<slug>/jobs', shape: 'slug', pattern: /^[a-z0-9][a-z0-9-]{0,100}$/ },
  completeListing: true,
  request: (identifier, cursor) => get(
    `https://ats.rippling.com/api/v2/board/${encodeURIComponent(identifier)}/jobs?page=${Number(cursor ?? 0)}&pageSize=${PAGE_SIZE}`,
  ),
  parse(body, context) {
    const payload = node(json(body, 'rippling'));
    const rows = nodes(payload['items']);
    const byJob = new Map<string, Node[]>();
    for (const row of rows) {
      const id = text(row['id']);
      if (id) byJob.set(id, [...(byJob.get(id) ?? []), row]);
    }
    const listings = [...byJob.entries()].map(([id, group]) => {
      const locations = group.flatMap((row) => nodes(row['locations']));
      const workplaces = new Set(locations.map((entry) => workplace(entry['workplaceType'])).filter(Boolean));
      return listing({
        title: text(group[0]['name']),
        employerName: context.label ?? context.identifier,
        canonicalUrl: text(group[0]['url']),
        context,
        locations: places(locations.map(ripplingPlace)),
        // One workplace type across every location is a stated one; a mix is not.
        workplaceType: workplaces.size === 1 ? [...workplaces][0] : undefined,
        department: text(node(group[0]['department'])['name']),
        identifier: id,
      });
    });
    const current = Number(context.cursor ?? 0);
    const totalPages = num(payload['totalPages']) ?? 0;
    return page(listings, current + 1 < totalPages ? String(current + 1) : undefined);
  },
  detail: {
    request: (posting, identifier) => posting.identifier
      ? get(`https://ats.rippling.com/api/v2/board/${encodeURIComponent(identifier)}/jobs/${encodeURIComponent(posting.identifier)}`)
      : undefined,
    parse(body, posting, context) {
      const job = node(json(body, 'rippling'));
      if (job['unlistedFromSearch'] === true) return undefined;
      const description = node(job['description']);
      const [range] = nodes(job['payRangeDetails']);
      const employment = node(job['employmentType']);
      return listing({
        ...posting,
        context,
        employerName: context.label ?? text(job['companyName']) ?? posting.employerName,
        description: markdown(description['company'], description['role']),
        // Rippling's id and label are swapped ("Salaried, full-time" / "SALARIED_FT").
        employmentTypes: employmentTypesIn(employment['id'], employment['label']),
        salary: range ? salary({ min: range['rangeStart'], max: range['rangeEnd'], currency: range['currency'], interval: range['frequency'] }) : undefined,
        publishedAt: date(job['createdOn']),
      });
    },
  },
};
