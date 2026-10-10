/**
 * Eploy (UK universities, charities and councils) — each career site's
 * `feeds/datafeed.ashx` XML, every vacancy with description, qualifications
 * and benefits. Salary is display text ("Grade 8 - £46,970 to £57,666 per
 * annum") and is read only when it is a complete statement.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT,
  date,
  elements,
  employmentTypesIn,
  get,
  listing,
  markdown,
  page,
  place,
  places,
  salaryText,
  tag,
  text,
} from '../listing.js';

export const eploy: JobFeedProvider = {
  kind: 'eploy',
  identifier: {
    meaning: 'the career site host, e.g. jobs.le.ac.uk',
    shape: 'slug',
    pattern: /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,
  },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}/feeds/datafeed.ashx?Format=xml`, XML_ACCEPT),
  parse(body, context) {
    return page(
      elements(body, 'Item').map((item) => {
        // "Grade 8 - £46,970 to £57,666 per annum": the amount begins at its currency.
        const pay = text(tag(item, 'DisplaySalary'));
        const amount = pay && /[£€$]/.test(pay) ? pay.slice(pay.search(/[£€$]/)) : pay;
        return listing({
          title: text(tag(item, 'Title')),
          employerName: text(tag(item, 'Company')) ?? context.label ?? context.identifier,
          canonicalUrl: text(tag(item, 'Link')),
          context,
          description: markdown(tag(item, 'Description')),
          qualifications: markdown(tag(item, 'Qualifications')),
          benefits: markdown(tag(item, 'Benefits')),
          locations: places([place({ raw: tag(item, 'Location') })]),
          employmentTypes: employmentTypesIn(tag(item, 'VacancyType')),
          salary: salaryText(amount),
          industry: text(tag(item, 'Industry')),
          occupationalCategory: text(tag(item, 'Position')),
          identifier: text(tag(item, 'VacancyID')),
          publishedAt: date(text(tag(item, 'PubDate')) ?? text(tag(item, 'DateCreated'))),
          validThrough: date(text(tag(item, 'AdvertisingEndDate'))),
        });
      }),
    );
  },
};
