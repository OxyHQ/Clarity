/**
 * Greenhouse job board API — one company's public board, every live job in a
 * single response. `content=true` adds the description; `pay_transparency=true`
 * adds the pay ranges the board publishes.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  fromEmbeddedJsonLd,
  get,
  json,
  listing,
  locationText,
  markdown,
  node,
  nodes,
  page,
  places,
  salary,
  text,
  unescapedHtml,
  workplace,
  type Node,
} from '../listing.js';

/**
 * A pay range states its interval only in its title ("Annual Salary:",
 * "Hourly Rate:"); a title that names none leaves the range unread.
 */
function payInterval(title: unknown): string | undefined {
  const value = text(title)?.toLowerCase() ?? '';
  if (/\bannual|\byearly|\bper year/.test(value)) return 'year';
  if (/\bhourly|\bper hour/.test(value)) return 'hour';
  if (/\bmonthly|\bper month/.test(value)) return 'month';
  return undefined;
}

/** Boards that track workplace as custom metadata name it "Location Type" or "Workplace Type". */
function metadataWorkplace(job: Node) {
  const entry = nodes(job['metadata']).find((item) =>
    /^(?:location|workplace|remote)\s*(?:type|status)?$/i.test(text(item['name']) ?? ''),
  );
  const value = text(entry?.['value']);
  // "Hybrid (Travel-Required)" states hybrid; the qualifier is not a workplace.
  return value ? workplace(value.split(/[\s(]/)[0]) : undefined;
}

export const greenhouse: JobFeedProvider = {
  kind: 'greenhouse',
  identifier: { meaning: 'the board token in boards.greenhouse.io/<token>', shape: 'slug' },
  completeListing: true,
  request: (identifier) =>
    get(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(identifier)}/jobs?content=true&pay_transparency=true`,
    ),
  // A large company's whole board, descriptions included, runs past 10 MB.
  maxBodyBytes: 40 * 1024 * 1024,
  parse(body, context) {
    const payload = node(json(body, 'greenhouse'));
    return page(
      nodes(payload['jobs']).map((job) => {
        const content = unescapedHtml(job['content']);
        const embedded = fromEmbeddedJsonLd(content, context.requestUrl, context.extractedAt);
        if (embedded) return embedded;
        const offices = nodes(job['offices']);
        // The first range is the one the board shows first.
        const [range] = nodes(job['pay_input_ranges']);
        return listing({
          title: text(job['title']),
          employerName: text(job['company_name']) ?? context.label ?? context.identifier,
          canonicalUrl: text(job['absolute_url']),
          context,
          description: markdown(content),
          // Offices carry a full "City, Region, Country"; the job's own location
          // text is a free-form summary and is used only when there is no office.
          locations: places(
            offices.length > 0
              ? offices.flatMap((office) =>
                  locationText(text(office['location']) ?? text(office['name'])),
                )
              : locationText(text(node(job['location'])['name'])),
          ),
          workplaceType: metadataWorkplace(job),
          salary: range
            ? salary({
                min: typeof range['min_cents'] === 'number' ? range['min_cents'] / 100 : undefined,
                max: typeof range['max_cents'] === 'number' ? range['max_cents'] / 100 : undefined,
                currency: range['currency_type'],
                interval: payInterval(range['title']),
              })
            : undefined,
          department: text(nodes(job['departments'])[0]?.['name']),
          identifier: job['id'] === undefined ? undefined : String(job['id']),
          publishedAt: date(job['first_published'] ?? job['updated_at']),
          validThrough: date(job['application_deadline']),
        });
      }),
    );
  },
};
