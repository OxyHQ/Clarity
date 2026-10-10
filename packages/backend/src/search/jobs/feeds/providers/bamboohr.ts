/**
 * BambooHR careers JSON — the list is a summary; each opening's detail adds
 * the description, posting date and experience level. The detail's
 * application form fields are never read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date, employmentTypesIn, get, json, listing, markdown, node, nodes, page, place, places, salaryText, seniority,
  text, DOLLAR_BY_COUNTRY, type Node,
} from '../listing.js';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function bambooPlace(job: Node) {
  const ats = node(job['atsLocation']);
  const plain = node(job['location']);
  return place({
    locality: ats['city'] ?? plain['city'],
    region: ats['state'] ?? ats['province'] ?? plain['state'],
    country: ats['country'] ?? plain['addressCountry'],
    postalCode: plain['postalCode'],
  });
}

export const bamboohr: JobFeedProvider = {
  kind: 'bamboohr',
  identifier: { meaning: 'the company subdomain in <company>.bamboohr.com', shape: 'slug', pattern: DNS_LABEL },
  request: (identifier) => get(`https://${identifier}.bamboohr.com/careers/list`),
  parse(body, context) {
    const payload = node(json(body, 'bamboohr'));
    return page(nodes(payload['result']).map((job) => {
      const id = text(job['id']);
      return listing({
        title: text(job['jobOpeningName']),
        employerName: context.label ?? context.identifier,
        canonicalUrl: id ? `https://${context.identifier}.bamboohr.com/careers/${encodeURIComponent(id)}` : undefined,
        context,
        locations: places([bambooPlace(job)]),
        ...(job['isRemote'] === true ? { workplaceType: 'remote' as const } : {}),
        employmentTypes: employmentTypesIn(job['employmentStatusLabel']),
        department: text(job['departmentLabel']),
        identifier: id,
      });
    }));
  },
  detail: {
    request: (posting, identifier) => posting.identifier
      ? get(`https://${identifier}.bamboohr.com/careers/${encodeURIComponent(posting.identifier)}/detail`)
      : undefined,
    parse(body, posting, context) {
      const opening = node(node(node(json(body, 'bamboohr'))['result'])['jobOpening']);
      if (text(opening['jobOpeningStatus']) && text(opening['jobOpeningStatus']) !== 'Open') return undefined;
      const located = places([bambooPlace(opening)]);
      const country = located[0]?.countryCode;
      return listing({
        ...posting,
        context,
        canonicalUrl: text(opening['jobOpeningShareUrl']) ?? posting.canonicalUrl,
        description: markdown(opening['description']),
        locations: located.length > 0 ? located : posting.locations,
        seniority: seniority(opening['minimumExperience']),
        salary: salaryText(opening['compensation'], { dollar: country ? DOLLAR_BY_COUNTRY[country] : undefined }),
        publishedAt: date(opening['datePosted']),
      });
    },
  },
};
