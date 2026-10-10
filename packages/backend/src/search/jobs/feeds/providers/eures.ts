/**
 * EURES — the European Commission's job mobility portal, carrying the
 * vacancies every EU/EEA public employment service publishes (about two
 * million). Re-use is authorised with the European Labour Authority
 * acknowledged as the source, which the canonical EURES page does.
 *
 * Search serves at most 10,000 results per query, newest first, so a feed is
 * one country or NUTS region (`de`, `fr`, `es51`). The list states title, full
 * description, employer, NUTS location, schedule, offering and ESCO occupation;
 * each vacancy's detail adds salary, city, education, experience, remote work
 * and the application deadline, and is fetched as europa.eu's ten-second
 * Crawl-delay allows. Contact people and application instructions (which name
 * them) are never read.
 */
import type { JobEmploymentType } from '@clarity/shared-types';

import type { JobFeedProvider } from '../provider.js';
import {
  get,
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
  post,
  salary,
  text,
  type Node,
} from '../listing.js';
import { COUNTRY_NAME_BY_CODE, normalizeCountry } from '../../taxonomy.js';

const PAGE_SIZE = 50;
const QUERY_WINDOW = 10_000;
const SEARCH = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';

function types(schedules: unknown, offering: unknown): JobEmploymentType[] {
  const found = new Set<JobEmploymentType>();
  for (const code of Array.isArray(schedules) ? schedules : []) {
    if (code === 'fulltime') found.add('full_time');
    if (code === 'parttime') found.add('part_time');
  }
  const offer = text(offering);
  if (offer === 'temporary' || offer === 'seasonal') found.add('temporary');
  if (offer === 'apprenticeship' || offer === 'traineeship' || offer === 'internship')
    found.add('internship');
  if (offer === 'contract' || offer === 'selfemployed') found.add('contract');
  return [...found];
}

/**
 * `{"FR": ["FRC1"]}` → one location per country. NUTS codes are statistical
 * region codes, not place names a reader recognizes, so only the country is
 * kept; the detail adds the city when the vacancy names one.
 */
/** EURES writes Greece as `EL`, the EU's code, not ISO 3166's `GR`. */
function country(code: string | undefined) {
  return code?.toUpperCase() === 'EL' ? 'GR' : normalizeCountry(code ?? '');
}

function countryPlaces(map: unknown) {
  return places(
    Object.keys(node(map)).map((code) => {
      const countryCode = country(code);
      return countryCode
        ? place({ raw: COUNTRY_NAME_BY_CODE.get(countryCode) ?? countryCode, countryCode })
        : undefined;
    }),
  );
}

function detailPlace(entry: Node) {
  const countryCode = country(text(entry.countryCode));
  const city = text(entry.cityName);
  if (!city)
    return countryCode
      ? place({ raw: COUNTRY_NAME_BY_CODE.get(countryCode) ?? countryCode, countryCode })
      : undefined;
  return place({
    locality: city,
    countryCode,
    country: countryCode ? COUNTRY_NAME_BY_CODE.get(countryCode) : undefined,
    postalCode: entry.postalCode,
  });
}

export const eures: JobFeedProvider = {
  kind: 'eures',
  identifier: {
    meaning: 'a country code or NUTS region, e.g. de, fr or es51',
    shape: 'slug',
    pattern: /^[a-z]{2}[a-z0-9]{0,3}$/,
  },
  request: (identifier, cursor) =>
    post(SEARCH, {
      resultsPerPage: PAGE_SIZE,
      page: Number(cursor ?? 1) || 1,
      sortSearch: 'MOST_RECENT',
      keywords: [],
      publicationPeriod: null,
      occupationUris: [],
      skillUris: [],
      requiredExperienceCodes: [],
      positionScheduleCodes: [],
      sectorCodes: [],
      educationAndQualificationLevelCodes: [],
      positionOfferingCodes: [],
      locationCodes: [identifier],
      euresFlagCodes: [],
      otherBenefitsCodes: [],
      requiredLanguages: [],
      minNumberPost: null,
      sessionId: 'clarity',
    }),
  terms:
    'Re-use authorised provided the European Labour Authority is acknowledged as the source; europa.eu asks for a ten-second crawl delay.',
  // Every slice shares europa.eu's ten-second Crawl-delay (about 360 requests
  // an hour for all of them), so each slice reads a little, twice a day:
  // its newest 200 vacancies and five details.
  minPollIntervalSeconds: 12 * 60 * 60,
  pagesPerPoll: 4,
  detailsPerPoll: 5,
  parse(body, context) {
    const payload = node(json(body, 'eures'));
    const vacancies = nodes(payload.jvs);
    const current = Number(context.cursor ?? 1) || 1;
    const total = Math.min(num(payload.numberRecords) ?? 0, QUERY_WINDOW);
    return page(
      vacancies.map((vacancy) => {
        const id = text(vacancy.id);
        const employer = node(vacancy.employer);
        return listing({
          title: text(vacancy.title),
          employerName: text(employer.name),
          canonicalUrl: id
            ? `https://europa.eu/eures/portal/jv-se/jv-details/${encodeURIComponent(id)}?lang=en`
            : undefined,
          context,
          description: markdown(vacancy.description),
          employerUrl: text(employer.website),
          locations: countryPlaces(vacancy.locationMap),
          employmentTypes: types(vacancy.positionScheduleCodes, vacancy.positionOfferingCode),
          identifier: id,
          publishedAt: num(vacancy.creationDate) ? new Date(num(vacancy.creationDate)!) : undefined,
        });
      }),
      nextPageNumber(context.cursor, vacancies.length === PAGE_SIZE && current * PAGE_SIZE < total),
    );
  },
  detail: {
    optional: true,
    ttlSeconds: 14 * 24 * 60 * 60,
    request: (posting) =>
      posting.identifier
        ? get(
            `https://europa.eu/eures/api/jv-searchengine/public/jv/id/${encodeURIComponent(posting.identifier)}?lang=en`,
          )
        : undefined,
    parse(body, posting, context) {
      const vacancy = node(json(body, 'eures'));
      const profiles = node(vacancy.jvProfiles);
      const profile = node(
        profiles[text(vacancy.preferredLanguage) ?? ''] ?? Object.values(profiles)[0],
      );
      const [pay] = nodes(node(profile.offeredRemunerationPackage).salaries);
      const located = places(nodes(profile.locations).map(detailPlace));
      const years = num(profile.requiredYearsOfExperience);
      const deadline = num(profile.lastApplicationDate);
      return listing({
        ...posting,
        context,
        description: markdown(profile.description) ?? posting.description,
        locations: located.length > 0 ? located : posting.locations,
        ...(profile.remoteWorkAllowed === true ? { workplaceType: 'remote' as const } : {}),
        salary: pay
          ? salary({
              min: pay.minimumSalary,
              max: pay.maximumSalary ?? pay.minimumSalary,
              currency: pay.currencyCode,
              interval: pay.payingIntervalCode,
            })
          : undefined,
        experienceRequirements: years && years > 0 ? `${years}+ years` : undefined,
        validThrough: deadline ? new Date(deadline) : undefined,
      });
    },
  },
};
