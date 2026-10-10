/**
 * SAP SuccessFactors Recruiting Marketing career sites — the Google-Base RSS
 * at `<careers host>/sitemal.xml` that lists every posting with its
 * description. The `/services/rss` feed and the legacy `career*.successfactors`
 * hosts are robots-disallowed and never used; a tenant that disabled the feed
 * answers with a notice instead of items, which reads as an empty board.
 *
 * `g:expiration_date` is a rolling +30 days and `g:salary` is not a salary on
 * the tenants seen, so neither is read.
 *
 * Identifier: the career site host, e.g. `jobs.schaeffler.com`.
 */
import type { JobFeedProvider } from '../provider.js';
import { normalizeCountry } from '../../taxonomy.js';
import { XML_ACCEPT, elements, get, listing, markdown, page, place, places, tag, text, unescapedHtml } from '../listing.js';

const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const US_STATES = /^(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/;

/** "Guadalajara, MX, 45645": the part order varies, so the country is the one ISO code that is not a US state. */
function successPlace(raw: string | undefined) {
  if (!raw) return undefined;
  const code = raw.split(',').map((part) => part.trim()).find((part) => /^[A-Z]{2}$/.test(part) && !US_STATES.test(part) && normalizeCountry(part));
  return place({ raw, countryCode: code });
}

export const successfactors: JobFeedProvider = {
  kind: 'successfactors',
  identifier: { meaning: 'the career site host of a SuccessFactors Recruiting Marketing site, e.g. jobs.schaeffler.com', shape: 'slug', pattern: HOST },
  completeListing: true,
  request: (identifier) => get(`https://${identifier}/sitemal.xml`, XML_ACCEPT),
  maxBodyBytes: 64 * 1024 * 1024,
  parse(body, context) {
    return page(elements(body, 'item').map((item) => {
      const location = text(tag(item, 'g:location'));
      const heading = text(tag(item, 'title'));
      // The board appends the location to the title: "SAP SD Analyst (Guadalajara, MX, 45645)".
      const title = heading && location && heading.endsWith(` (${location})`) ? heading.slice(0, -location.length - 3) : heading;
      return listing({
        title,
        employerName: text(tag(item, 'g:employer')) ?? context.label ?? context.identifier,
        canonicalUrl: text(tag(item, 'link')),
        context,
        description: markdown(unescapedHtml(tag(item, 'description'))),
        locations: places([successPlace(location)]),
        identifier: text(tag(item, 'g:id')) ?? text(tag(item, 'guid')),
      });
    }));
  },
};
