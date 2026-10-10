/**
 * jobs.admin.ch — the Swiss federal administration's vacancies, served by its
 * job platform's public API with tasks, requirements and benefits as separate
 * sections, workload and location. The `sza_contact` block names a person and
 * is never read.
 */
import type { JobEmploymentType } from '@clarity/shared-types';

import type { JobFeedProvider } from '../provider.js';
import {
  date,
  get,
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
  strings,
  text,
} from '../listing.js';

const PAGE_SIZE = 100;
const MEDIUM = '1000624';

function workload(min: unknown, max: unknown): JobEmploymentType[] {
  const low = num(min);
  const high = num(max);
  if (low === undefined || high === undefined) return [];
  const found = new Set<JobEmploymentType>();
  // The pensum is stated in percent of a full-time post.
  if (high >= 100) found.add('full_time');
  if (low < 100) found.add('part_time');
  return [...found];
}

export const jobsadminch: JobFeedProvider = {
  kind: 'jobsadminch',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  completeListing: true,
  request: (_identifier, cursor) =>
    get(
      `https://ohws.prospective.ch/public/v1/medium/${MEDIUM}/jobs?lang=de&offset=${Number(cursor ?? 0) || 0}&limit=${PAGE_SIZE}`,
    ),
  parse(body, context) {
    const payload = node(json(body, 'jobsadminch'));
    const jobs = nodes(payload['jobs']);
    return page(
      jobs.map((job) => {
        const fields = node(job['szas']);
        const attributes = node(job['attributes']);
        const unit = Object.entries(attributes).find(([key]) =>
          key.startsWith('verwaltungseinheit_'),
        )?.[1];
        return listing({
          title: text(fields['sza_title']) ?? text(job['title']),
          employerName: strings(unit)[0] ?? strings(attributes['verwaltungseinheit'])[0],
          canonicalUrl: text(node(job['links'])['directlink']),
          applyUrl: text(fields['sza_apply_link']),
          context,
          description: markdown(fields['sza_tasks']),
          qualifications: markdown(fields['sza_requirements']),
          benefits: markdown(fields['sza_benefits']),
          locations: places([
            place({
              raw: fields['sza_location.city'],
              country: fields['sza_location.country'],
              region: fields['sza_location.region'],
            }),
          ]),
          employmentTypes: workload(fields['sza_pensum.min'], fields['sza_pensum.max']),
          industry: text(fields['sza_industry']),
          occupationalCategory: strings(attributes['taetigkeitsbereich'])[0],
          identifier: text(job['id']),
          publishedAt: date(job['start_date']),
          validThrough: date(job['end_date']),
        });
      }),
      nextOffset(context.cursor, jobs.length, PAGE_SIZE, num(payload['total'])),
    );
  },
};
