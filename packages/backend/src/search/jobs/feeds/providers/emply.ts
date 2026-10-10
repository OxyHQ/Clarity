/**
 * Emply (Denmark; Paychex) — each career site's vacancy API, paged by offset.
 * Contact fact data is never read.
 */
import type { JobFeedProvider } from '../provider.js';
import {
  date,
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
  post,
  text,
} from '../listing.js';

const PAGE_SIZE = 100;

export const emply: JobFeedProvider = {
  kind: 'emply',
  identifier: {
    meaning: '<tenant>/<language> from <tenant>.career.emply.com/<language>, e.g. albertslund/da',
    shape: 'slug',
    pattern: /^[a-z0-9][a-z0-9-]{0,62}\/[a-z]{2}$/,
  },
  completeListing: true,
  request(identifier, cursor) {
    const [tenant, language] = identifier.split('/');
    return post(`https://${tenant}.career.emply.com/api/integration/vacancy/get-page`, {
      count: PAGE_SIZE,
      offset: Number(cursor ?? 0) || 0,
      filters: [],
      langCode: language,
      searchText: '',
      light: false,
      isJobAgent: false,
      siteId: null,
    });
  },
  parse(body, context) {
    const [tenant, language] = context.identifier.split('/');
    const payload = node(json(body, 'emply'));
    const vacancies = nodes(payload.vacancies);
    return page(
      vacancies.map((vacancy) => {
        const [translation] = nodes(vacancy.translations);
        const slug = text(vacancy.titleAsUrl);
        const shortId = text(vacancy.shortId);
        return listing({
          title: text(translation?.title) ?? text(vacancy.title),
          employerName: context.label ?? tenant,
          canonicalUrl:
            slug && shortId
              ? `https://${tenant}.career.emply.com/${language}/ad/${encodeURIComponent(slug)}/${encodeURIComponent(shortId)}`
              : undefined,
          context,
          description: markdown(translation?.content),
          locations: places([place({ raw: vacancy.location, country: vacancy.location })]),
          department: text(vacancy.department),
          identifier: text(vacancy.number) ?? text(vacancy.id),
          publishedAt: date(vacancy.published),
          validThrough: date(vacancy.deadline),
        });
      }),
      nextOffset(context.cursor, vacancies.length, PAGE_SIZE, num(payload.count)),
    );
  },
};
