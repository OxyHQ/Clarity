/**
 * RemoteOK public API — the newest remote listings in a single response.
 * The listing's RemoteOK page is its canonical source, which is the
 * attribution the API's own notice asks for.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  get,
  json,
  listing,
  markdown,
  nodes,
  num,
  page,
  salary,
  strings,
  text,
  date,
} from '../listing.js';

export const remoteok: JobFeedProvider = {
  kind: 'remoteok',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  request: () => get('https://remoteok.com/api'),
  terms: 'Link back to the RemoteOK listing URL and mention RemoteOK as the source.',
  parse(body, context) {
    // The first element is the API's legal/attribution notice, not a listing.
    const entries = nodes(json(body, 'remoteok')).filter((item) => item.id !== undefined);
    return page(
      entries.map((job) => {
        const applicantLocation = text(job.location);
        return listing({
          title: text(job.position),
          employerName: text(job.company),
          canonicalUrl: text(job.url),
          applyUrl: text(job.apply_url),
          context,
          description: markdown(job.description),
          employerLogoUrl: text(job.company_logo) ?? text(job.logo),
          applicantLocationRequirements: applicantLocation ? [applicantLocation] : [],
          workplaceType: 'remote',
          skills: strings(job.tags, 20),
          // The API reports 0 for "not stated"; only a real amount is a salary.
          salary: salary({
            min: num(job.salary_min),
            max: num(job.salary_max),
            currency: 'USD',
            interval: 'year',
          }),
          identifier: job.id === undefined ? undefined : String(job.id),
          publishedAt: date(job.date),
        });
      }),
    );
  },
};
