/**
 * JobTech JobSearch — Sweden's public employment service (Arbetsförmedlingen)
 * open job ads, CC0, newest first, paged by offset (at most 2,100 rows per
 * query). Contact people's names, emails and phone numbers are never read.
 */
import type { JobEmploymentType, JobWorkplaceType } from '@clarity/shared-types';

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
  text,
  withQuery,
  type Node,
} from '../listing.js';

const PAGE_SIZE = 100;
const QUERY_WINDOW = 2_100;

/** The JobTech taxonomy labels that state a Clarity value, in Swedish as published. */
const EMPLOYMENT_BY_LABEL: Readonly<Record<string, JobEmploymentType>> = Object.freeze({
  heltid: 'full_time',
  deltid: 'part_time',
  'tidsbegränsad anställning': 'temporary',
  'sommarjobb / feriejobb': 'temporary',
});
const WORKPLACE_BY_LABEL: Readonly<Record<string, JobWorkplaceType>> = Object.freeze({
  'arbete på plats': 'onsite',
  distansarbete: 'remote',
  hybridarbete: 'hybrid',
});
const COUNTRY_BY_NAME: Readonly<Record<string, string>> = Object.freeze({ sverige: 'SE' });

function label(value: unknown): string | undefined {
  return text(node(value)['label'])?.toLowerCase();
}

function labels(value: unknown): string[] {
  return nodes(value)
    .map((entry) => text(entry['label']))
    .filter((entry): entry is string => Boolean(entry));
}

function requirementList(requirements: Node, key: string): string | undefined {
  const values = labels(requirements[key]);
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : undefined;
}

export const jobtech: JobFeedProvider = {
  kind: 'jobtech',
  identifier: {
    meaning: 'unused, or a JobTech occupation-field concept id',
    shape: 'optional',
    pattern: /^[A-Za-z0-9_]{4,20}$/,
  },
  request: (identifier, cursor) =>
    get(
      withQuery('https://jobsearch.api.jobtechdev.se/search', {
        limit: PAGE_SIZE,
        offset: cursor ?? 0,
        sort: 'pubdate-desc',
        'occupation-field': identifier && identifier !== 'jobtech' ? identifier : undefined,
      }),
    ),
  terms: 'CC0 public data from Arbetsförmedlingen.',
  parse(body, context) {
    const payload = node(json(body, 'jobtech'));
    const hits = nodes(payload['hits']);
    return page(
      hits.map((ad) => {
        if (ad['removed'] === true) return undefined;
        const employer = node(ad['employer']);
        const must = node(ad['must_have']);
        const types = [label(ad['working_hours_type']), label(ad['employment_type'])]
          .map((value) => (value ? EMPLOYMENT_BY_LABEL[value] : undefined))
          .filter((value): value is JobEmploymentType => Boolean(value));
        const addresses =
          nodes(ad['workplace_addresses']).length > 0
            ? nodes(ad['workplace_addresses'])
            : [node(ad['workplace_address'])];
        const model = label(ad['workplace_model']);
        return listing({
          title: text(ad['headline']),
          employerName: text(employer['name']),
          canonicalUrl: text(ad['webpage_url']),
          applyUrl: text(node(ad['application_details'])['url']),
          context,
          description: markdown(
            node(ad['description'])['text_formatted'] ?? node(ad['description'])['text'],
          ),
          employerUrl: text(employer['url']),
          employerLogoUrl: text(ad['logo_url']),
          locations: places(
            addresses.map((address) => {
              const country = text(address['country']);
              return place({
                locality: address['city'] ?? address['municipality'],
                region: address['region'],
                country,
                countryCode: country ? COUNTRY_BY_NAME[country.toLowerCase()] : undefined,
                postalCode: address['postcode'],
              });
            }),
          ),
          workplaceType: model ? WORKPLACE_BY_LABEL[model] : undefined,
          employmentTypes: [...new Set(types)],
          skills: labels(must['skills']).slice(0, 20),
          educationRequirements: requirementList(must, 'education'),
          experienceRequirements: requirementList(must, 'work_experiences'),
          occupationalCategory: text(node(ad['occupation'])['label']),
          industry: text(node(ad['occupation_field'])['label']),
          department: text(employer['workplace']),
          identifier: text(ad['id']),
          publishedAt: date(ad['publication_date']),
          validThrough: date(ad['application_deadline']),
        });
      }),
      nextOffset(
        context.cursor,
        hits.length,
        PAGE_SIZE,
        Math.min(num(node(payload['total'])['value']) ?? QUERY_WINDOW, QUERY_WINDOW),
      ),
    );
  },
};
