/**
 * Workday candidate experience (CXS) API — the JSON behind every
 * `<tenant>.wd<N>.myworkdayjobs.com/<site>` board.
 *
 * The list is a POST of at most 20 rows per page, and Workday serves only the
 * first 2,000 rows of any search; a larger site is registered as several feeds
 * sliced by facet (`?jobFamilyGroup=<id>`). Rows carry a title and a path, so
 * each job's detail adds the description, locations, time type, requisition
 * id and posting date.
 *
 * Identifier: `<tenant>.wd<N>/<site>`, optionally followed by facet filters,
 * e.g. `nvidia.wd5/NVIDIAExternalCareerSite?jobFamilyGroup=0c40f6bd1d8f10ae43ffaefd46dc7e78`.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  employmentTypes,
  json,
  listing,
  markdown,
  nextOffset,
  node,
  num,
  page,
  place,
  places,
  post,
  get,
  text,
  nodes,
  workplace,
} from '../listing.js';

const PAGE_SIZE = 20;
/** Workday answers no search beyond its first 2,000 rows. */
const SEARCH_WINDOW = 2_000;
const IDENTIFIER =
  /^([a-z0-9][a-z0-9-]{0,62})\.wd(\d{1,3})\/([A-Za-z0-9_-]{1,100})(?:\?((?:[A-Za-z][A-Za-z0-9_]{0,60}=[A-Za-z0-9_-]{1,64})(?:&[A-Za-z][A-Za-z0-9_]{0,60}=[A-Za-z0-9_-]{1,64}){0,4}))?$/;

interface WorkdaySite {
  tenant: string;
  host: string;
  site: string;
  facets: Record<string, string[]>;
}

function site(identifier: string): WorkdaySite {
  const match = IDENTIFIER.exec(identifier);
  if (!match) throw new Error('Identifier for workday must be <tenant>.wd<N>/<site>');
  const [, tenant, shard, name, query] = match;
  const facets: Record<string, string[]> = {};
  for (const pair of query ? query.split('&') : []) {
    const [key, value] = pair.split('=');
    facets[key] = [...(facets[key] ?? []), value];
  }
  return { tenant, host: `${tenant}.wd${shard}.myworkdayjobs.com`, site: name, facets };
}

function api(board: WorkdaySite): string {
  return `https://${board.host}/wday/cxs/${board.tenant}/${board.site}`;
}

export const workday: JobFeedProvider = {
  kind: 'workday',
  identifier: {
    meaning:
      '<tenant>.wd<N>/<site> from <tenant>.wd<N>.myworkdayjobs.com/<site>, optionally ?facet=id',
    shape: 'slug',
    pattern: IDENTIFIER,
  },
  request(identifier, cursor) {
    const board = site(identifier);
    return post(`${api(board)}/jobs`, {
      limit: PAGE_SIZE,
      offset: Number(cursor ?? 0),
      searchText: '',
      appliedFacets: board.facets,
    });
  },
  parse(body, context) {
    const board = site(context.identifier);
    const payload = node(json(body, 'workday'));
    const rows = nodes(payload.jobPostings);
    const listings = rows.map((row) => {
      const path = text(row.externalPath);
      return listing({
        title: text(row.title),
        employerName: context.label ?? board.tenant,
        canonicalUrl: path?.startsWith('/')
          ? `https://${board.host}/${board.site}${path}`
          : undefined,
        context,
        // The first bullet is the requisition id on the tenants seen so far.
        identifier: Array.isArray(row.bulletFields) ? text(row.bulletFields[0]) : undefined,
      });
    });
    // `total` is reported on the first page only.
    const total = Math.min(num(payload.total) || SEARCH_WINDOW, SEARCH_WINDOW);
    return page(listings, nextOffset(context.cursor, rows.length, PAGE_SIZE, total));
  },
  detail: {
    request(posting, identifier) {
      const board = site(identifier);
      const prefix = `https://${board.host}/${board.site}`;
      if (!posting.canonicalUrl.startsWith(`${prefix}/`)) return undefined;
      return get(`${api(board)}${posting.canonicalUrl.slice(prefix.length)}`);
    },
    parse(body, posting, context) {
      const payload = node(json(body, 'workday'));
      const info = node(payload.jobPostingInfo);
      if (info.posted === false) return undefined;
      const requisition = node(info.jobRequisitionLocation);
      const countryCode = text(node(requisition.country).alpha2Code);
      const additional = Array.isArray(info.additionalLocations) ? info.additionalLocations : [];
      return listing({
        ...posting,
        context,
        title: text(info.title) ?? posting.title,
        canonicalUrl: text(info.externalUrl) ?? posting.canonicalUrl,
        description: markdown(info.jobDescription),
        // Workday location text is tenant-formatted ("US, CA, Santa Clara",
        // "California - San Francisco"); only the requisition's country is structured.
        locations: places([
          place({ raw: info.location ?? requisition.descriptor, countryCode }),
          ...additional.map((value) => place({ raw: value })),
        ]),
        workplaceType: workplace(info.remoteType),
        employmentTypes: employmentTypes(info.timeType),
        identifier: text(info.jobReqId) ?? posting.identifier,
        publishedAt: date(info.startDate),
      });
    },
  },
};
