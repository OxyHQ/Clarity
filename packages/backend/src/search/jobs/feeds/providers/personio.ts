/**
 * Personio XML feed — one company's whole public board in one file.
 *
 * No `language` parameter is sent: it filters which descriptions come back,
 * so asking for a language the board was not written in returns postings with
 * empty descriptions. The account's own language returns them all.
 */
import type { JobEmploymentType } from '@clarity/shared-types';

import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT, date, elements, get, humanize, listing, page, place, places, salary, section, seniority, tag, tags, text,
} from '../listing.js';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const YEARS: Readonly<Record<string, string>> = Object.freeze({
  'lt-1': 'Less than 1 year', '1-2': '1–2 years', '2-5': '2–5 years', '5-7': '5–7 years', '7-10': '7–10 years', 'gt-10': 'More than 10 years',
});

function personioEmploymentTypes(schedule: string | undefined, employmentType: string | undefined): JobEmploymentType[] {
  const types = new Set<JobEmploymentType>();
  if (schedule === 'full-time' || schedule === 'full-or-part-time') types.add('full_time');
  if (schedule === 'part-time' || schedule === 'full-or-part-time') types.add('part_time');
  if (employmentType === 'intern') types.add('internship');
  return [...types];
}

export const personio: JobFeedProvider = {
  kind: 'personio',
  identifier: { meaning: 'the company subdomain in <company>.jobs.personio.de', shape: 'slug', pattern: DNS_LABEL },
  request: (identifier) => get(`https://${identifier}.jobs.personio.de/xml`, XML_ACCEPT),
  parse(body, context) {
    return page(elements(body, 'position').map((position) => {
      const id = text(tag(position, 'id'));
      // Each `jobDescription` is a titled section the board renders in order.
      const sections = elements(position, 'jobDescription').map((entry) => section(text(tag(entry, 'name')) ?? '', tag(entry, 'value')))
        .filter((value): value is string => Boolean(value));
      const pay = tag(position, 'salaryInformation');
      const additional = tag(position, 'additionalOffices');
      const years = text(tag(position, 'yearsOfExperience'));
      return listing({
        title: text(tag(position, 'name')),
        employerName: text(tag(position, 'subcompany')) ?? context.label ?? context.identifier,
        canonicalUrl: id ? `https://${context.identifier}.jobs.personio.de/job/${encodeURIComponent(id)}` : undefined,
        context,
        description: sections.length > 0 ? sections.join('\n\n') : undefined,
        locations: places([
          place({ raw: tag(position, 'office') }),
          ...(additional ? tags(additional, 'office').map((office) => place({ raw: office })) : []),
        ]),
        employmentTypes: personioEmploymentTypes(text(tag(position, 'schedule')), text(tag(position, 'employmentType'))),
        seniority: seniority(tag(position, 'seniority'), tag(position, 'employmentType')),
        experienceRequirements: years ? YEARS[years] : undefined,
        salary: pay ? salary({
          min: text(tag(pay, 'min')), max: text(tag(pay, 'max')), currency: tag(pay, 'currencyCode'), interval: tag(pay, 'type'),
        }) : undefined,
        department: text(tag(position, 'department')),
        occupationalCategory: humanize(tag(position, 'occupation')),
        industry: humanize(tag(position, 'occupationCategory')),
        identifier: id,
        publishedAt: date(text(tag(position, 'createdAt'))),
      });
    }));
  },
};
