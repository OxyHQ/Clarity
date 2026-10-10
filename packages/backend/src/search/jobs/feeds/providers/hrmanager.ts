/**
 * HR Manager (Talentech; Denmark and Norway) — each customer's job portal
 * JSON with advertisement texts included. Dates use Microsoft's
 * `/Date(ms+zone)/` form. Project leaders and participants are never read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
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
  text,
} from '../listing.js';

/** `/Date(1792015199000+0200)/` → the instant. */
function msDate(value: unknown): Date | undefined {
  const match = typeof value === 'string' ? /\/Date\((-?\d+)/.exec(value) : null;
  return match ? new Date(Number(match[1])) : undefined;
}

export const hrmanager: JobFeedProvider = {
  kind: 'hrmanager',
  identifier: {
    meaning: 'the customer alias in candidate.hr-manager.net/…list.aspx?customer=<alias>',
    shape: 'slug',
    pattern: /^[a-z0-9][a-z0-9_-]{0,60}$/i,
  },
  completeListing: true,
  request: (identifier) =>
    get(
      `https://api.hr-manager.net/jobportal.svc/${encodeURIComponent(identifier)}/positionlist/json/?incads=1&take=1000`,
    ),
  parse(body, context) {
    const payload = node(json(body, 'hrmanager'));
    return page(
      nodes(payload.Items).map((job) => {
        const tree = node(job.DepartmentTree);
        const [advertisement] = nodes(job.Advertisements);
        return listing({
          title: text(job.Name),
          employerName: text(job.CustomerName) ?? text(payload.CustomerName),
          canonicalUrl: text(job.AdvertisementUrlSecure) ?? text(job.AdvertisementUrl),
          context,
          description: markdown(advertisement?.Content),
          locations: places([
            place({
              raw: tree.Address
                ? [tree.Address, tree.PostalCode, tree.City].filter(Boolean).join(', ')
                : undefined,
              locality: tree.City,
              postalCode: tree.PostalCode,
              country: tree.Country,
            }),
          ]),
          employmentTypes: employmentTypesIn(node(job.CustomList1).Name),
          occupationalCategory: text(node(job.PositionCategory).Name),
          department: text(node(job.Department).Name) ?? text(node(job.PositionLocation).Name),
          identifier: text(job.Id),
          publishedAt: msDate(job.Published) ?? msDate(job.Created),
          validThrough: msDate(job.ApplicationDue),
        });
      }),
    );
  },
};
