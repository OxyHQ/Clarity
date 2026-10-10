/**
 * Easycruit (Visma; Norway) — each company's public XML vacancy export. The
 * list states title, employer, deadline, county and links; each vacancy's
 * own export adds the description. Contact persons are never read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT,
  date,
  elements,
  get,
  listing,
  markdown,
  page,
  place,
  places,
  tag,
  text,
} from '../listing.js';

/** An attribute of the first `<Vacancy …>` element. */
function attribute(xml: string, name: string): string | undefined {
  return new RegExp(`<Vacancy\\b[^>]*\\s${name}="([^"]*)"`).exec(xml)?.[1];
}

const COUNTRY_BY_NAME: Readonly<Record<string, string>> = Object.freeze({
  norge: 'NO',
  sverige: 'SE',
  danmark: 'DK',
  suomi: 'FI',
});

export const easycruit: JobFeedProvider = {
  kind: 'easycruit',
  identifier: {
    meaning: 'the subdomain in <company>.easycruit.com',
    shape: 'slug',
    pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  },
  completeListing: true,
  request: (identifier) =>
    get(`https://${identifier}.easycruit.com/export/xml/vacancy/list.xml`, XML_ACCEPT),
  parse(body, context) {
    return page(
      elements(body, 'Vacancy').map((vacancy) => {
        const country = /<Country\b[^>]*name="([^"]*)"/.exec(vacancy)?.[1];
        return listing({
          title: text(tag(vacancy, 'Title')),
          employerName:
            text(tag(vacancy, 'AlternativeCompanyName')) ?? context.label ?? context.identifier,
          canonicalUrl: text(tag(vacancy, 'VacancyURL')),
          applyUrl: text(tag(vacancy, 'ApplicationURL')),
          context,
          locations: places([
            place({
              raw: tag(vacancy, 'Location'),
              region: tag(vacancy, 'County'),
              country,
              countryCode: country ? COUNTRY_BY_NAME[country.toLowerCase()] : undefined,
            }),
          ]),
          department: text(tag(tag(vacancy, 'Department') ?? '', 'Name')),
          identifier: attribute(vacancy, 'id'),
          publishedAt: date(attribute(vacancy, 'date_start')),
          validThrough: date(attribute(vacancy, 'date_end')),
        });
      }),
    );
  },
  detail: {
    optional: true,
    request: (posting, identifier) =>
      posting.identifier
        ? get(
            `https://${identifier}.easycruit.com/export/xml/vacancy/${encodeURIComponent(posting.identifier)}.xml`,
            XML_ACCEPT,
          )
        : undefined,
    parse(body, posting, context) {
      const version = tag(body, 'Version') ?? body;
      return listing({
        ...posting,
        context,
        description: markdown(tag(version, 'Description')) ?? posting.description,
      });
    },
  },
};
