/**
 * We Work Remotely RSS — remote listings, one feed for the whole board or one
 * per category. WWR writes each item's title as `Company: Role` and adds its
 * own tags for the applicant region, category, type, expiry and logo.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  XML_ACCEPT, date, elements, employmentTypes, get, listing, markdown, page, strings, tag, text,
} from '../listing.js';

/** `media:content url="…"` is self-closing, so it is read as an attribute. */
function logo(item: string): string | undefined {
  return /<media:content[^>]*\surl="([^"]+)"/i.exec(item)?.[1];
}

export const weworkremotely: JobFeedProvider = {
  kind: 'weworkremotely',
  identifier: { meaning: 'unused, or a category slug as in /categories/<slug>.rss', shape: 'optional', pattern: /^[a-z0-9][a-z0-9-]{0,80}$/ },
  request: (identifier) => get(identifier && identifier !== 'weworkremotely'
    ? `https://weworkremotely.com/categories/${identifier}.rss`
    : 'https://weworkremotely.com/remote-jobs.rss', XML_ACCEPT),
  parse(body, context) {
    return page(elements(body, 'item').map((item) => {
      const heading = text(tag(item, 'title'));
      const separator = heading?.indexOf(': ') ?? -1;
      const region = text(tag(item, 'region'));
      return listing({
        // Without the `Company: ` prefix there is no stated employer, and no listing.
        title: separator > 0 ? heading!.slice(separator + 2) : undefined,
        employerName: separator > 0 ? heading!.slice(0, separator) : undefined,
        canonicalUrl: text(tag(item, 'link')) ?? text(tag(item, 'guid')),
        context,
        description: markdown(tag(item, 'description')),
        employerLogoUrl: logo(item),
        workplaceType: 'remote',
        applicantLocationRequirements: region && !/anywhere/i.test(region) ? [region] : [],
        employmentTypes: employmentTypes(tag(item, 'type')),
        skills: strings(tag(item, 'skills'), 20),
        occupationalCategory: text(tag(item, 'category')),
        identifier: text(tag(item, 'guid')),
        publishedAt: date(text(tag(item, 'pubDate'))),
        validThrough: date(text(tag(item, 'expires_at'))),
      });
    }));
  },
};
