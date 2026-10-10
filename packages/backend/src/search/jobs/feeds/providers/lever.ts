/**
 * Lever postings API — one company's public postings in a single response.
 * Companies on Lever's EU instance answer at `api.eu.lever.co` instead; the
 * `lever_eu` kind covers them.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  escapeHtml, get, json, listing, locationText, markdown, node, nodes, page, places, salary, text, employmentTypes,
  workplace, date, type Node,
} from '../listing.js';

/**
 * Lever splits a posting into `description`, titled `lists` ("What you'll do",
 * each an HTML run of `<li>`) and `additional`. The board page renders them in
 * that order, so they are joined in that order — nothing is added.
 */
function leverDescription(job: Node): string | undefined {
  const html = [
    typeof job['description'] === 'string' ? job['description'] : '',
    ...nodes(job['lists']).map((list) => {
      const heading = typeof list['text'] === 'string' && list['text'].trim() ? `<h3>${escapeHtml(list['text'])}</h3>` : '';
      const items = typeof list['content'] === 'string' ? `<ul>${list['content']}</ul>` : '';
      return heading + items;
    }),
    typeof job['additional'] === 'string' ? job['additional'] : '',
  ].join('');
  return html.trim() ? markdown(html) : markdown(job['descriptionPlain']);
}

function parseLever(body: string, context: Parameters<JobFeedProvider['parse']>[1]) {
  const payload = json(body, context.kind);
  return page(nodes(payload).map((job) => {
    const categories = node(job['categories']);
    const range = node(job['salaryRange']);
    const allLocations = Array.isArray(categories['allLocations']) ? categories['allLocations'] : [];
    return listing({
      title: text(job['text']),
      employerName: context.label ?? context.identifier,
      canonicalUrl: typeof job['hostedUrl'] === 'string' ? job['hostedUrl'] : undefined,
      applyUrl: typeof job['applyUrl'] === 'string' ? job['applyUrl'] : undefined,
      context,
      description: leverDescription(job),
      locations: places([
        ...locationText(text(categories['location'])),
        ...allLocations.flatMap((value) => locationText(text(value))),
      ]),
      workplaceType: workplace(job['workplaceType'] ?? categories['workplaceType']),
      employmentTypes: employmentTypes(categories['commitment']),
      salary: salary({ min: range['min'], max: range['max'], currency: range['currency'], interval: intervalOf(range['interval']) }),
      department: text(categories['department']) ?? text(categories['team']),
      identifier: typeof job['id'] === 'string' ? job['id'] : undefined,
      publishedAt: date(job['createdAt']),
    });
  }));
}

/** Lever writes the interval as `per-year-salary`, `per-hour-wage` and so on. */
function intervalOf(value: unknown): string | undefined {
  const match = typeof value === 'string' ? /per-(hour|day|week|month|year)/.exec(value) : null;
  return match?.[1];
}

export const lever: JobFeedProvider = {
  kind: 'lever',
  identifier: { meaning: 'the company slug in jobs.lever.co/<slug>', shape: 'slug' },
  request: (identifier) => get(`https://api.lever.co/v0/postings/${encodeURIComponent(identifier)}?mode=json`),
  parse: parseLever,
};

export const leverEu: JobFeedProvider = {
  kind: 'lever_eu',
  identifier: { meaning: 'the company slug in jobs.eu.lever.co/<slug>', shape: 'slug' },
  request: (identifier) => get(`https://api.eu.lever.co/v0/postings/${encodeURIComponent(identifier)}?mode=json`),
  parse: parseLever,
};
