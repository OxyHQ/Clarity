/**
 * Phenom career sites — the `/widgets` search behind `<host>/<country>/<lang>`
 * boards (Thermo Fisher, Mastercard, …). The list pages up to 500 at a time
 * with location, type, category and dates; each job's detail adds the full
 * description and requirements.
 *
 * Phenom's machine-learned skills, recruiter names and referral rewards are
 * never read.
 *
 * Identifier: `<host>/<country>/<lang>`, e.g. `jobs.thermofisher.com/global/en`.
 */
import type { JobFeedContext, JobFeedProvider } from '../provider.js';
import {
  date,
  employmentTypes,
  json,
  listing,
  markdown,
  nextOffset,
  node,
  nodes,
  num,
  page,
  place,
  places,
  post,
  text,
  type Node,
} from '../listing.js';

const PAGE_SIZE = 500;
const IDENTIFIER = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/([a-z]{2}|global)\/([a-z]{2})$/;

interface Site {
  host: string;
  country: string;
  lang: string;
}

function site(identifier: string): Site {
  const match = IDENTIFIER.exec(identifier);
  if (!match) throw new Error('Identifier for phenom must be <host>/<country>/<lang>');
  return { host: match[1], country: match[2], lang: match[3] };
}

function base({ country, lang }: Site) {
  return { lang: `${lang}_${country}`, deviceType: 'desktop', country, siteType: 'external' };
}

function phenomPlace(job: Node) {
  return place({
    locality: job.city,
    region: job.state,
    country: job.country,
    postalCode: job.postalCode,
    raw: job.location,
  });
}

function phenomListing(job: Node, board: Site, context: JobFeedContext) {
  const id = text(job.jobId) ?? text(job.reqId);
  return listing({
    title: text(job.title),
    employerName: text(job.companyName) ?? context.label ?? board.host,
    canonicalUrl: id
      ? `https://${board.host}/${board.country}/${board.lang}/job/${encodeURIComponent(id)}`
      : undefined,
    applyUrl: text(job.applyUrl),
    context,
    locations: places([
      phenomPlace(job),
      ...(Array.isArray(job.multi_location) ? job.multi_location : []).map((value) =>
        place({ raw: value }),
      ),
    ]),
    employmentTypes: employmentTypes(job.type),
    occupationalCategory: text(job.category),
    industry: text(job.industry),
    identifier: text(job.reqId) ?? id,
    publishedAt: date(job.postedDate ?? job.dateCreated),
  });
}

export const phenom: JobFeedProvider = {
  kind: 'phenom',
  identifier: {
    meaning:
      '<host>/<country>/<lang> of a Phenom career site, e.g. jobs.thermofisher.com/global/en',
    shape: 'slug',
    pattern: IDENTIFIER,
  },
  completeListing: true,
  request(identifier, cursor) {
    const board = site(identifier);
    return post(`https://${board.host}/widgets`, {
      ...base(board),
      pageName: 'search-results',
      ddoKey: 'refineSearch',
      from: Number(cursor ?? 0) || 0,
      size: PAGE_SIZE,
      jobs: true,
      counts: false,
      keywords: '',
      global: true,
      selected_fields: {},
    });
  },
  parse(body, context) {
    const board = site(context.identifier);
    const search = node(node(json(body, 'phenom')).refineSearch);
    const jobs = nodes(node(search.data).jobs);
    return page(
      jobs.map((job) => phenomListing(job, board, context)),
      nextOffset(context.cursor, jobs.length, PAGE_SIZE, num(search.totalHits)),
    );
  },
  detail: {
    request(posting, identifier) {
      const board = site(identifier);
      const jobId = posting.canonicalUrl.split('/job/')[1];
      return jobId
        ? post(`https://${board.host}/widgets`, {
            ...base(board),
            pageName: 'job',
            ddoKey: 'jobDetail',
            jobId: decodeURIComponent(jobId),
          })
        : undefined;
    },
    parse(body, posting, context) {
      const job = node(node(node(node(json(body, 'phenom')).jobDetail).data).job);
      if (!text(job.title)) return undefined;
      const board = site(context.identifier);
      const listed = phenomListing(job, board, context);
      return listing({
        ...posting,
        ...(listed ?? {}),
        context,
        canonicalUrl: posting.canonicalUrl,
        description: markdown(job.description),
        qualifications: markdown(job.jobRequirements),
        experienceRequirements: markdown(job.experience),
      });
    },
  },
};
