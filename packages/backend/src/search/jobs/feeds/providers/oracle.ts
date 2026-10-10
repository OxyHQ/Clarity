/**
 * Oracle Recruiting Cloud — the candidate-experience REST finder behind every
 * `<tenant>.fa.<pod>.oraclecloud.com/hcmUI/CandidateExperience` career site.
 *
 * The list pages 200 at a time, newest first, and states location, family,
 * function, schedule and dates; each requisition's detail adds the full
 * description, qualifications, responsibilities, street-level work locations
 * and the posting end date. Oracle publishes no employer name, so the feed's
 * label is the employer.
 *
 * Identifier: `<host>/<siteNumber>`, e.g. `jpmc.fa.oraclecloud.com/CX_1001`.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  employmentTypesIn,
  get,
  json,
  listing,
  locationText,
  markdown,
  nextOffset,
  node,
  nodes,
  num,
  page,
  place,
  places,
  text,
  workplace,
  type Node,
} from '../listing.js';

const PAGE_SIZE = 200;
const IDENTIFIER = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.oraclecloud\.com)\/(CX(?:_\d{1,6})?)$/;

function board(identifier: string): { host: string; site: string } {
  const match = IDENTIFIER.exec(identifier);
  if (!match) throw new Error('Identifier for oracle must be <host>.oraclecloud.com/<siteNumber>');
  return { host: match[1], site: match[2] };
}

/** Oracle's finder takes its arguments in one `;`/`,`-separated parameter that must not be percent-encoded. */
function finder(host: string, resource: string, finderArgs: string, extra: string): string {
  return `https://${host}/hcmRestApi/resources/latest/${resource}?onlyData=true&${extra}&finder=${finderArgs}`;
}

function oraclePlace(entry: Node) {
  return place({
    locality: entry['TownOrCity'],
    region: entry['Region2'] ?? entry['Region1'],
    countryCode: entry['Country'],
    postalCode: entry['PostalCode'],
  });
}

export const oracle: JobFeedProvider = {
  kind: 'oracle',
  identifier: {
    meaning: '<host>.oraclecloud.com/<siteNumber>, e.g. jpmc.fa.oraclecloud.com/CX_1001',
    shape: 'slug',
    pattern: IDENTIFIER,
  },
  completeListing: true,
  request(identifier, cursor) {
    const { host, site } = board(identifier);
    const offset = Number(cursor ?? 0) || 0;
    return get(
      finder(
        host,
        'recruitingCEJobRequisitions',
        `findReqs;siteNumber=${site},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`,
        'expand=requisitionList.secondaryLocations,requisitionList.workLocation',
      ),
    );
  },
  parse(body, context) {
    const { host, site } = board(context.identifier);
    const [search] = nodes(node(json(body, 'oracle'))['items']);
    const requisitions = nodes(search?.['requisitionList']);
    return page(
      requisitions.map((job) => {
        const id = text(job['Id']);
        const country = text(job['PrimaryLocationCountry']);
        const [primary] = locationText(text(job['PrimaryLocation']));
        return listing({
          title: text(job['Title']),
          employerName: context.label ?? host.split('.')[0],
          canonicalUrl: id
            ? `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${encodeURIComponent(id)}`
            : undefined,
          context,
          description: markdown(job['ShortDescriptionStr']),
          locations: places([
            primary && !primary.countryCode && country
              ? { ...primary, countryCode: country }
              : primary,
            ...nodes(job['secondaryLocations']).map((entry) =>
              place({ raw: entry['Name'], countryCode: entry['CountryCode'] }),
            ),
          ]),
          workplaceType: workplace(job['WorkplaceTypeCode'] ?? job['WorkplaceType']),
          employmentTypes: employmentTypesIn(job['JobSchedule'], job['ContractType']),
          educationRequirements: text(job['StudyLevel']),
          occupationalCategory: text(job['JobFamily']) ?? text(job['JobFunction']),
          department: text(job['Department']),
          identifier: id,
          publishedAt: date(job['PostedDate']),
          validThrough: date(job['PostingEndDate']),
        });
      }),
      nextOffset(context.cursor, requisitions.length, PAGE_SIZE, num(search?.['TotalJobsCount'])),
    );
  },
  detail: {
    // The list's short description already makes a usable listing.
    optional: true,
    request(posting, identifier) {
      const { host, site } = board(identifier);
      return posting.identifier
        ? get(
            finder(
              host,
              'recruitingCEJobRequisitionDetails',
              `ById;Id=%22${encodeURIComponent(posting.identifier)}%22,siteNumber=${site}`,
              'expand=all',
            ),
          )
        : undefined;
    },
    parse(body, posting, context) {
      const [job] = nodes(node(json(body, 'oracle'))['items']);
      if (!job) return undefined;
      const work = nodes(job['workLocation']).map(oraclePlace);
      return listing({
        ...posting,
        context,
        description: markdown(job['ExternalDescriptionStr']) ?? posting.description,
        qualifications: markdown(job['ExternalQualificationsStr']),
        responsibilities: markdown(job['ExternalResponsibilitiesStr']),
        locations: work.some(Boolean) ? places([...work, ...posting.locations]) : posting.locations,
        employmentTypes:
          employmentTypesIn(job['JobSchedule'], job['ContractType']).length > 0
            ? employmentTypesIn(job['JobSchedule'], job['ContractType'])
            : posting.employmentTypes,
        department: text(job['Department']) ?? text(job['BusinessUnit']) ?? posting.department,
        publishedAt: date(job['ExternalPostedStartDate']) ?? posting.publishedAt,
        validThrough: date(job['ExternalPostedEndDate']) ?? posting.validThrough,
      });
    },
  },
};
