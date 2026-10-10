/**
 * Jobvite — the per-company XML export every Jobvite career site is built
 * from, all open jobs in one response. A job listed in several locations
 * appears once per location with a `<parentId>`; they are folded into one.
 *
 * Hiring team, hiring manager and referral bonus fields are never read.
 *
 * Identifier: `<slug>/<companyId>`, the slug in jobs.jobvite.com/<slug> and the
 * eight-character company id its career page names.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT,
  elements,
  employmentTypes,
  get,
  listing,
  locationText,
  markdown,
  page,
  places,
  tag,
  text,
} from '../listing.js';

const IDENTIFIER = /^([a-z0-9][a-z0-9-]{0,80})\/([A-Za-z0-9]{8})$/;

/** `M/D/YYYY`. */
function usDate(value: string | undefined): Date | undefined {
  const match = value ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim()) : null;
  return match
    ? new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])))
    : undefined;
}

export const jobvite: JobFeedProvider = {
  kind: 'jobvite',
  identifier: {
    meaning: '<slug>/<companyId> from jobs.jobvite.com/<slug>, e.g. nutanix/qKr9VfwZ',
    shape: 'slug',
    pattern: IDENTIFIER,
  },
  completeListing: true,
  request: (identifier) =>
    get(
      `https://app.jobvite.com/CompanyJobs/Xml.aspx?c=${encodeURIComponent(IDENTIFIER.exec(identifier)?.[2] ?? '')}`,
      XML_ACCEPT,
    ),
  maxBodyBytes: 40 * 1024 * 1024,
  parse(body, context) {
    const slug = IDENTIFIER.exec(context.identifier)?.[1] ?? context.identifier;
    const byJob = new Map<string, string[]>();
    for (const job of elements(body, 'job')) {
      const id = text(tag(job, 'parentId')) ?? text(tag(job, 'id'));
      if (id) byJob.set(id, [...(byJob.get(id) ?? []), job]);
    }
    return page(
      [...byJob.entries()].map(([id, group]) => {
        const [job] = group;
        return listing({
          title: text(tag(job, 'title')),
          employerName: context.label ?? slug,
          canonicalUrl: `https://jobs.jobvite.com/${encodeURIComponent(slug)}/job/${encodeURIComponent(id)}`,
          applyUrl: text(tag(job, 'apply-url')),
          context,
          description: markdown(tag(job, 'description')),
          locations: places(group.flatMap((entry) => locationText(text(tag(entry, 'location'))))),
          employmentTypes: employmentTypes(tag(job, 'jobtype')),
          occupationalCategory: text(tag(job, 'category')),
          department: text(tag(job, 'business_x0020_unit')) ?? text(tag(job, 'department')),
          identifier: text(tag(job, 'requisitionid')) ?? id,
          publishedAt: usDate(text(tag(job, 'date'))),
        });
      }),
    );
  },
};
