/**
 * Ashby posting API — one company's public job board in a single response.
 * `includeCompensation=true` adds the pay a board publishes.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  employmentTypes, fromEmbeddedJsonLd, get, json, listing, locationText, markdown, node, nodes, page, place,
  places, salary, text, workplace, date, type Node,
} from '../listing.js';

/** `postalAddress` is schema.org-shaped; the plain `location` name is the fallback. */
function ashbyPlace(entry: Node) {
  const address = node(node(entry['address'])['postalAddress']);
  return place({
    locality: address['addressLocality'],
    region: address['addressRegion'],
    country: address['addressCountry'],
  }) ?? locationText(text(entry['location']))[0];
}

/** The base salary component; equity and bonus components are not a salary. */
function ashbySalary(job: Node) {
  const components = nodes(node(job['compensation'])['summaryComponents']);
  const base = components.find((component) => component['compensationType'] === 'Salary');
  if (!base) return undefined;
  // Ashby writes the interval as `1 YEAR`, `1 HOUR` and so on.
  const interval = typeof base['interval'] === 'string' ? /^1\s+(\w+)$/i.exec(base['interval'].trim())?.[1] : undefined;
  return salary({ min: base['minValue'], max: base['maxValue'], currency: base['currencyCode'], interval });
}

export const ashby: JobFeedProvider = {
  kind: 'ashby',
  identifier: { meaning: 'the job board name in jobs.ashbyhq.com/<name>', shape: 'slug' },
  completeListing: true,
  request: (identifier) => get(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(identifier)}?includeCompensation=true`,
  ),
  // A large company's whole board, descriptions included, runs past 10 MB.
  maxBodyBytes: 40 * 1024 * 1024,
  parse(body, context) {
    const payload = node(json(body, 'ashby'));
    return page(nodes(payload['jobs']).map((job) => {
      if (job['isListed'] === false) return undefined;
      const embedded = fromEmbeddedJsonLd(job['descriptionHtml'], context.requestUrl, context.extractedAt);
      if (embedded) return embedded;
      const stated = workplace(job['workplaceType']);
      return listing({
        title: text(job['title']),
        employerName: text(job['organizationName']) ?? context.identifier,
        canonicalUrl: typeof job['jobUrl'] === 'string' ? job['jobUrl']
          : typeof job['applyUrl'] === 'string' ? job['applyUrl'] : undefined,
        applyUrl: typeof job['applyUrl'] === 'string' ? job['applyUrl'] : undefined,
        context,
        description: markdown(job['descriptionHtml'] ?? job['descriptionPlain']),
        locations: places([ashbyPlace(job), ...nodes(job['secondaryLocations']).map(ashbyPlace)]),
        workplaceType: stated ?? (job['isRemote'] === true ? 'remote' : undefined),
        employmentTypes: employmentTypes(job['employmentType']),
        salary: ashbySalary(job),
        department: text(job['department']) ?? text(job['team']),
        identifier: typeof job['id'] === 'string' ? job['id'] : undefined,
        publishedAt: date(job['publishedAt'] ?? job['updatedAt']),
      });
    }));
  },
};
