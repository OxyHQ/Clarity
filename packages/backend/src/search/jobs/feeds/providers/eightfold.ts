/**
 * Eightfold talent sites — the `pcsx` search behind `<tenant>.eightfold.ai`
 * career pages (PayPal, Micron, …). The search returns ten positions a page,
 * newest first; each position's detail adds the full description and time
 * type. Eightfold publishes no employer name, so the feed's label is the
 * employer.
 *
 * Identifier: `<tenant>.eightfold.ai/<company domain>`, e.g. `paypal.eightfold.ai/paypal.com`.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  employmentTypes,
  epochSeconds,
  get,
  json,
  listing,
  locationText,
  markdown,
  nextOffset,
  node,
  nodes,
  num,
  page,
  places,
  text,
  withQuery,
  workplace,
} from '../listing.js';

const PAGE_SIZE = 10;
const IDENTIFIER = /^([a-z0-9-]+\.eightfold\.ai)\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

function site(identifier: string): { host: string; domain: string } {
  const match = IDENTIFIER.exec(identifier);
  if (!match) throw new Error('Identifier for eightfold must be <tenant>.eightfold.ai/<domain>');
  return { host: match[1], domain: match[2] };
}

/** "Luxembourg, Luxembourg, LU": Eightfold's standardized form ends in the ISO code. */
function standardized(values: unknown) {
  return places(
    (Array.isArray(values) ? values : []).flatMap((value) => locationText(text(value))),
  );
}

export const eightfold: JobFeedProvider = {
  kind: 'eightfold',
  identifier: {
    meaning: '<tenant>.eightfold.ai/<company domain>, e.g. paypal.eightfold.ai/paypal.com',
    shape: 'slug',
    pattern: IDENTIFIER,
  },
  completeListing: true,
  request(identifier, cursor) {
    const { host, domain } = site(identifier);
    return get(
      withQuery(`https://${host}/api/pcsx/search`, {
        domain,
        query: '',
        location: '',
        start: Number(cursor ?? 0) || 0,
        sort_by: 'timestamp',
      }),
    );
  },
  parse(body, context) {
    const { host } = site(context.identifier);
    const data = node(node(json(body, 'eightfold'))['data']);
    const positions = nodes(data['positions']);
    return page(
      positions.map((job) =>
        listing({
          title: text(job['name']),
          employerName: context.label ?? host.split('.')[0],
          canonicalUrl: text(job['positionUrl'])
            ? `https://${host}${text(job['positionUrl'])}`
            : undefined,
          context,
          locations: standardized(job['standardizedLocations']),
          workplaceType: workplace(String(job['workLocationOption'] ?? '').split('_')[0]),
          department: text(job['department']),
          identifier: text(job['displayJobId']) ?? text(job['id']),
          publishedAt: epochSeconds(job['postedTs']),
        }),
      ),
      nextOffset(context.cursor, positions.length, PAGE_SIZE, num(data['count'])),
    );
  },
  detail: {
    request(posting, identifier) {
      const { host, domain } = site(identifier);
      const id = posting.canonicalUrl.split('/careers/job/')[1];
      return id
        ? get(
            withQuery(`https://${host}/api/pcsx/position_details`, {
              position_id: id,
              domain,
              hl: 'en',
            }),
          )
        : undefined;
    },
    parse(body, posting, context) {
      const job = node(node(json(body, 'eightfold'))['data']);
      if (!text(job['name'])) return undefined;
      return listing({
        ...posting,
        context,
        canonicalUrl: text(job['publicUrl']) ?? posting.canonicalUrl,
        description: markdown(job['jobDescription']),
        employmentTypes: employmentTypes(job['efcustomTextTimeType']),
      });
    },
  },
};
