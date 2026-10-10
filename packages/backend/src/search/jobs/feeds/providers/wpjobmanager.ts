/**
 * WP Job Manager — the WordPress job-board plugin behind many niche and
 * national boards, through WordPress's own public REST API
 * (`/wp-json/wp/v2/job-listings`, paged). A listing whose plugin metadata
 * names the employer is read from the API; one that does not is read from
 * its own page's `JobPosting`.
 *
 * Identifier: the site's https base URL, e.g. https://workew.com.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
  get,
  json,
  listing,
  locationText,
  markdown,
  node,
  nodes,
  page,
  places,
  salaryText,
  text,
  workplace,
} from '../listing.js';
import { jsonLdPage } from './pagejsonld.js';

const PAGE_SIZE = 100;

/** WordPress writes `*_gmt` times without a zone. */
function gmt(value: unknown): Date | undefined {
  return typeof value === 'string' && value ? date(`${value}Z`) : undefined;
}

function base(identifier: string): string {
  return identifier.replace(/\/+$/, '');
}

export const wpjobmanager: JobFeedProvider = {
  kind: 'wp_job_manager',
  identifier: {
    meaning: 'the https base URL of a WordPress site running WP Job Manager',
    shape: 'url',
  },
  completeListing: true,
  request: (identifier, cursor) =>
    get(
      `${base(identifier)}/wp-json/wp/v2/job-listings?per_page=${PAGE_SIZE}&page=${Number(cursor ?? 1) || 1}`,
    ),
  parse(body, context) {
    const posts = nodes(json(body, 'wp_job_manager'));
    const current = Number(context.cursor ?? 1) || 1;
    const listings = [];
    const references = [];
    for (const post of posts) {
      const meta = node(post.meta);
      const link = text(post.link);
      const employer = text(meta._company_name);
      if (!employer) {
        const modified = gmt(post.modified_gmt);
        if (link) references.push({ url: link, ...(modified ? { lastModified: modified } : {}) });
        continue;
      }
      const remote = meta._remote_position;
      listings.push(
        listing({
          title: text(node(post.title).rendered),
          employerName: employer,
          canonicalUrl: link,
          applyUrl: /^https?:\/\//.test(String(meta._application ?? ''))
            ? text(meta._application)
            : undefined,
          context,
          description: markdown(node(post.content).rendered),
          employerUrl: text(meta._company_website),
          locations: places(locationText(text(meta._job_location))),
          workplaceType:
            remote === '1' || remote === true ? 'remote' : workplace(meta._job_location),
          salary: salaryText(meta._job_salary),
          identifier: text(post.id),
          publishedAt: gmt(post.date_gmt),
          validThrough: date(meta._job_expires),
        }),
      );
    }
    return {
      ...page(listings, posts.length === PAGE_SIZE ? String(current + 1) : undefined),
      references,
    };
  },
  listingPage: jsonLdPage,
};
