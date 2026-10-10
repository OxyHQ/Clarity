/**
 * Keka (India) — each company's careers API, every active job with full
 * description, structured locations, experience and skills.
 */
import type { JobEmploymentType } from '@clarity/shared-types';

import type { JobFeedProvider } from '../provider.js';
import { date, get, json, listing, markdown, nodes, node, page, place, places, salary, strings, text } from '../listing.js';

/** Keka's job type codes as its career page labels them. */
const KEKA_TYPES: Readonly<Record<number, JobEmploymentType>> = Object.freeze({ 1: 'part_time', 2: 'full_time' });

export const keka: JobFeedProvider = {
  kind: 'keka',
  identifier: { meaning: 'the subdomain in <sub>.keka.com/careers', shape: 'slug', pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/ },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}.keka.com/careers/api/jobs/default/active`),
  parse(body, context) {
    return page(nodes(json(body, 'keka')).map((job) => {
      const id = text(job['id']);
      const pay = node(job['salaryRange']);
      const type = KEKA_TYPES[Number(job['jobType'])];
      return listing({
        title: text(job['title']),
        employerName: context.label ?? context.identifier,
        canonicalUrl: id ? `https://${context.identifier}.keka.com/careers/jobdetails/${encodeURIComponent(id)}` : undefined,
        context,
        description: markdown(job['description']),
        locations: places(nodes(job['jobLocations']).map((entry) => place({ locality: entry['city'], region: entry['state'], countryCode: entry['countryCode'], country: entry['countryName'], raw: entry['name'] }))),
        employmentTypes: type ? [type] : [],
        experienceRequirements: text(job['experience']),
        salary: salary({ min: pay['min'], max: pay['max'], currency: pay['currency'], interval: pay['salaryPeriod'] }),
        skills: strings(job['skillNames'], 20),
        department: text(job['departmentName']),
        identifier: id,
        publishedAt: date(job['publishedOn']),
      });
    }));
  },
};
