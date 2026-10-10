/**
 * Job Boardly — the hosted job-board platform's public `jobs.xml`, every live
 * listing of one board with its description, workplace, location limits and
 * pay. `highlighted` and `sticky` are the board's paid promotion flags and are
 * never read. The application link points at the employer's own system.
 *
 * Identifier: the board host, e.g. `etcareers.com`.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT, date, elements, employmentTypes, get, listing, locationText, markdown, page, places, salary, tag, tags, text,
  workplace,
} from '../listing.js';

export const jobboardly: JobFeedProvider = {
  kind: 'jobboardly',
  identifier: { meaning: 'the host of a Job Boardly board serving /jobs.xml, e.g. etcareers.com', shape: 'slug', pattern: /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/ },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}/jobs.xml`, XML_ACCEPT),
  maxBodyBytes: 40 * 1024 * 1024,
  parse(body, context) {
    return page(elements(body, 'job').map((job) => {
      const limits = tag(job, 'location_limits');
      const located = places(locationText(text(tag(job.replace(/<location_limits>[\s\S]*?<\/location_limits>/, ''), 'location'))));
      return listing({
        title: text(tag(job, 'title')),
        employerName: text(tag(job, 'company_name')) ?? context.label,
        canonicalUrl: text(tag(job, 'url')),
        applyUrl: text(tag(job, 'application_link')),
        context,
        description: markdown(tag(job, 'html_description') ?? tag(job, 'plain_text_description')),
        employerLogoUrl: text(tag(job, 'company_logo_url')),
        locations: located,
        applicantLocationRequirements: limits ? tags(limits, 'location').filter((value) => !/^worldwide$/i.test(value)) : [],
        workplaceType: workplace(tag(job, 'location_type')),
        employmentTypes: employmentTypes(tag(job, 'arrangement')),
        salary: salary({ min: tag(job, 'salary_minimum'), max: tag(job, 'salary_maximum'), currency: tag(job, 'salary_currency'), interval: tag(job, 'salary_schedule') }),
        occupationalCategory: text(tag(job, 'category')),
        identifier: text(tag(job, 'id')),
        publishedAt: date(text(tag(job, 'published_at'))),
        validThrough: date(text(tag(job, 'expires_at'))),
      });
    }));
  },
};
