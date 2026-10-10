/**
 * 4dayweek.io — roles at employers offering a four-day week or a comparable
 * schedule, newest first, paged by page number. The API is meant for
 * aggregators and asks only for a link back, which the canonical URL is.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  get,
  humanize,
  json,
  listing,
  markdown,
  nextPageNumber,
  node,
  nodes,
  num,
  page,
  place,
  places,
  salary,
  seniority,
  strings,
  text,
  workplace,
  withQuery,
} from '../listing.js';

export const fourdayweek: JobFeedProvider = {
  kind: 'fourdayweek',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  completeListing: true,
  request: (_identifier, cursor) =>
    get(withQuery('https://4dayweek.io/api/v2/jobs', { limit: 100, page: cursor ?? 1 })),
  terms: 'A link back to 4dayweek.io is all that is asked.',
  parse(body, context) {
    const payload = node(json(body, 'fourdayweek'));
    return page(
      nodes(payload['data']).map((job) => {
        const company = node(job['company']);
        const cents = (value: unknown) => {
          const amount = num(value);
          return amount === undefined ? undefined : amount / 100;
        };
        const schedule = humanize(job['schedule_type']);
        return listing({
          title: text(job['title']),
          employerName: text(company['name']),
          canonicalUrl: text(job['url']),
          context,
          description: markdown(job['description']),
          employerUrl: text(company['website']),
          employerLogoUrl: text(company['logo_url']),
          locations: places(
            nodes(job['locations']).map((entry) =>
              place({
                locality: entry['city'],
                region: entry['state'],
                country: entry['country'],
              }),
            ),
          ),
          workplaceType: workplace(job['work_arrangement']),
          employmentTypes: text(job['contract_type']) === 'contract' ? ['contract'] : [],
          seniority: seniority(job['level']),
          // Amounts are in cents.
          salary: salary({
            min: cents(job['salary_min']),
            max: cents(job['salary_max']),
            currency: job['salary_currency'],
            interval: job['salary_period'],
          }),
          skills: [
            ...new Set([
              ...strings(job['skills']),
              ...strings(job['stack']),
              ...strings(job['tools']),
            ]),
          ].slice(0, 30),
          // The schedule is the board's subject: "9 day fortnight", "Compressed week".
          benefits: schedule ? `- ${schedule}` : undefined,
          occupationalCategory: text(job['role']) ?? humanize(job['category']),
          identifier: text(job['id']),
          publishedAt: date(job['posted_at']),
        });
      }),
      nextPageNumber(context.cursor, payload['has_more'] === true),
    );
  },
};
