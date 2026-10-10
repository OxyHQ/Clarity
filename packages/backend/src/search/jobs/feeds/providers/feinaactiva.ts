/**
 * Feina Activa — the Catalan public employment service's (SOC) open job
 * offers, one daily XML snapshot under the Catalan open-data licence (cite
 * the source; the canonical Feina Activa page does). Salary figures carry no
 * period, so pay is not read.
 */
import type { JobEmploymentType } from '@clarity/shared-types';

import type { JobFeedProvider } from '../provider.js';
import { XML_ACCEPT, elements, get, listing, markdown, page, place, places, tag, text } from '../listing.js';

/** `dd/mm/yyyy`. */
function slashDate(value: string | undefined): Date | undefined {
  const match = value ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim()) : null;
  return match ? new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]))) : undefined;
}

function types(contract: string | undefined, hours: string | undefined): JobEmploymentType[] {
  const found = new Set<JobEmploymentType>();
  const value = `${contract ?? ''} ${hours ?? ''}`.toLowerCase();
  if (/jornada completa/.test(value)) found.add('full_time');
  if (/jornada parcial/.test(value)) found.add('part_time');
  if (/temporal/.test(value)) found.add('temporary');
  if (/pràctiques|formació/.test(value)) found.add('internship');
  return [...found];
}

export const feinaactiva: JobFeedProvider = {
  kind: 'feinaactiva',
  identifier: { meaning: 'unused; leave it as the kind name', shape: 'none' },
  completeListing: true,
  request: () => get('https://feinaactiva.gencat.cat/api/offers/offers-xml', XML_ACCEPT),
  terms: 'Llicència oberta d\'ús d\'informació – Catalunya: free reuse, citing the source.',
  parse(body, context) {
    return page(elements(body, 'ad').map((ad) => {
      if (text(tag(ad, 'status')) && text(tag(ad, 'status')) !== 'PUBLISHED') return undefined;
      const requirements = [tag(ad, 'experience'), tag(ad, 'requirements')].map((value) => text(value)).filter(Boolean).join('\n\n');
      return listing({
        title: text(tag(ad, 'title')),
        employerName: text(tag(ad, 'company')),
        canonicalUrl: text(tag(ad, 'url')),
        context,
        description: markdown(tag(ad, 'content')),
        qualifications: requirements ? markdown(requirements) : undefined,
        educationRequirements: text(tag(ad, 'studies')),
        locations: places([place({ locality: tag(ad, 'city'), region: tag(ad, 'region'), postalCode: tag(ad, 'postcode') })]),
        employmentTypes: types(text(tag(ad, 'contract')), text(tag(ad, 'workingHours'))),
        occupationalCategory: text(tag(ad, 'category')),
        identifier: text(tag(ad, 'id')),
        publishedAt: slashDate(text(tag(ad, 'date'))),
      });
    }));
  },
};
