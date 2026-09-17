import { describe, expect, it } from 'vitest';

import type { JobLocation } from '@clarity/shared-types';

import { foldPlaceName, type PlaceCandidate, type PlaceResolver } from '../../places/resolve.js';
import { extractJobPostings } from '../extract.js';
import { validateJobPostingPayload } from '../ingest-validation.js';
import { resolveJobLocations } from '../locations.js';
import { jobSearchSchema } from '../service.js';
import {
  COUNTRY_CODES, CURRENCY_CODES, JOB_REGIONS, normalizeCountry, normalizeCurrency,
} from '../taxonomy.js';

const extractedAt = '2026-09-09T00:00:00.000Z';

const barcelona: PlaceCandidate = {
  id: '3128760', kind: 'city', name: 'Barcelona', asciiName: 'Barcelona', countryCode: 'ES',
  admin1Name: 'Catalonia', matchNames: ['barcelona', 'barcelone'], population: 1_686_208,
};
const springfieldIllinois: PlaceCandidate = {
  id: '4250542', kind: 'city', name: 'Springfield', asciiName: 'Springfield', countryCode: 'US',
  admin1Name: 'Illinois', matchNames: ['springfield'], population: 114_394,
};
const springfieldMissouri: PlaceCandidate = { ...springfieldIllinois, id: '4409896', admin1Name: 'Missouri', population: 169_176 };

function fakeResolver(places: readonly PlaceCandidate[] = [barcelona, springfieldIllinois, springfieldMissouri]): PlaceResolver {
  return {
    candidates: async (queries) => places.filter((place) => queries.some((query) =>
      query.countryCode === place.countryCode && query.names.some((name) => place.matchNames.includes(name)))),
    byIds: async (ids) => places.filter((place) => ids.includes(place.id)),
    isEmpty: async () => places.length === 0,
  };
}

function posting(fields: Record<string, unknown>) {
  return { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Engineer', hiringOrganization: { name: 'Mention' }, ...fields };
}

const validSalary = {
  '@type': 'MonetaryAmount', currency: 'EUR',
  value: { '@type': 'QuantitativeValue', minValue: 50_000, maxValue: 70_000, unitText: 'YEAR' },
};

describe('closed vocabularies in normalization', () => {
  it('shares one list with the SDK and maps names only onto assigned codes', () => {
    expect(CURRENCY_CODES).toContain('EUR');
    expect(normalizeCurrency('eur')).toBe('EUR');
    for (const unknown of ['XTS', 'XAU', 'ABC', 'HRK']) expect(normalizeCurrency(unknown)).toBeUndefined();
    expect(normalizeCountry('Spain')).toBe('ES');
    expect(normalizeCountry('uk')).toBe('GB');
    expect(normalizeCountry('Kosovo')).toBeUndefined();
    expect(normalizeCountry('XK')).toBeUndefined();
    expect(normalizeCountry('AQ')).toBe('AQ');
    for (const members of Object.values(JOB_REGIONS)) {
      for (const code of members) expect(COUNTRY_CODES as readonly string[]).toContain(code);
    }
  });

  it('drops a crawled salary in an unknown currency, a negative amount or an inverted range', () => {
    const salary = (baseSalary: unknown) => extractJobPostings([posting({ baseSalary })], 'https://acme.example/j', extractedAt)[0].salary;
    expect(salary(validSalary)).toEqual({ min: 50_000, max: 70_000, currency: 'EUR', interval: 'year' });
    expect(salary({ ...validSalary, currency: 'XYZ' })).toBeUndefined();
    expect(salary({ ...validSalary, value: { minValue: -1, maxValue: 10, unitText: 'YEAR' } })).toBeUndefined();
    expect(salary({ ...validSalary, value: { minValue: 90, maxValue: 10, unitText: 'YEAR' } })).toBeUndefined();
  });

  it('keeps an unknown crawled country only as raw text', () => {
    const [job] = extractJobPostings([posting({
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Prishtina', addressCountry: 'XK' } },
    })], 'https://acme.example/j', extractedAt);
    expect(job.locations).toEqual([{ raw: 'Prishtina, XK', country: 'XK', locality: 'Prishtina' }]);
  });
});

describe('place resolution for every source', () => {
  async function resolved(locations: unknown): Promise<JobLocation[]> {
    const postings = extractJobPostings([posting({ jobLocation: locations })], 'https://acme.example/j', extractedAt);
    return (await resolveJobLocations(fakeResolver(), postings))[0].locations;
  }

  it('attaches an unambiguous country-constrained match', async () => {
    expect(await resolved({ '@type': 'Place', address: { addressLocality: 'Barcelone', addressCountry: 'Spain' } }))
      .toEqual([{ raw: 'Barcelone, Spain', country: 'Spain', countryCode: 'ES', locality: 'Barcelone', region: 'Catalonia', placeId: '3128760' }]);
  });

  it('leaves ambiguous and country-less localities unresolved', async () => {
    expect((await resolved({ '@type': 'Place', address: { addressLocality: 'Springfield', addressCountry: 'US' } }))[0].placeId).toBeUndefined();
    expect((await resolved({ '@type': 'Place', address: { addressLocality: 'Barcelona' } }))[0].placeId).toBeUndefined();
  });

  it('keeps a claimed place only when the gazetteer has it and the country agrees', async () => {
    expect(await resolved({ '@type': 'Place', sameAs: 'https://www.geonames.org/3128760' }))
      .toEqual([{ raw: 'Barcelona, Catalonia, ES', countryCode: 'ES', locality: 'Barcelona', region: 'Catalonia', placeId: '3128760' }]);
    expect(await resolved({ '@type': 'Place', sameAs: 'https://www.geonames.org/999' })).toEqual([]);
    expect(await resolved({ '@type': 'Place', sameAs: 'https://www.geonames.org/3128760', address: { addressLocality: 'Barcelona', addressCountry: 'FR' } }))
      .toEqual([{ raw: 'Barcelona, FR', country: 'FR', countryCode: 'FR', locality: 'Barcelona' }]);
  });
});

describe('first-party ingest validation', () => {
  const validate = (fields: Record<string, unknown>, places?: PlaceCandidate[]) =>
    validateJobPostingPayload([posting(fields)], fakeResolver(places));

  it('accepts the documented payload', async () => {
    expect(await validate({
      baseSalary: validSalary,
      jobLocation: [
        { '@type': 'Place', sameAs: 'https://www.geonames.org/3128760', address: { '@type': 'PostalAddress', addressLocality: 'Barcelona', addressCountry: 'ES' } },
        { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Springfield', addressRegion: 'Illinois', addressCountry: 'US' } },
        { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'PT' } },
      ],
      jobLocationType: 'TELECOMMUTE',
    })).toEqual({ issues: [], placesUnavailable: false });
  });

  it('rejects salaries outside the vocabularies, with one issue per field', async () => {
    const { issues } = await validate({
      baseSalary: { currency: 'XTS', value: { minValue: 80, maxValue: 10, unitText: 'FORTNIGHT' } },
    });
    expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['jobPosting.baseSalary.currency', 'unknown_currency'],
      ['jobPosting.baseSalary.value.unitText', 'unknown_salary_interval'],
      ['jobPosting.baseSalary.value', 'salary_range_inverted'],
    ]);
    const amounts = await validate({ baseSalary: { value: { minValue: -5, maxValue: Number.NaN, unitText: 'YEAR' } } });
    expect(amounts.issues.map((issue) => issue.code)).toEqual(['currency_required', 'invalid_salary_amount', 'invalid_salary_amount']);
    expect((await validate({ baseSalary: { currency: 'EUR', value: { unitText: 'YEAR' } } })).issues.map((issue) => issue.code))
      .toEqual(['salary_amount_required']);
  });

  it('rejects arbitrary countries and places it cannot identify', async () => {
    const { issues } = await validate({
      jobLocation: [
        { '@type': 'Place', address: { addressLocality: 'Barcelona', addressCountry: 'Spain' } },
        { '@type': 'Place', address: { addressLocality: 'Atlantis', addressCountry: 'ES' } },
        { '@type': 'Place', address: { addressLocality: 'Springfield', addressCountry: 'US' } },
        { '@type': 'Place', address: 'Barcelona, Spain' },
        { '@type': 'Place', address: { addressLocality: 'Barcelona' } },
        { '@type': 'Place', sameAs: 'https://maps.example/barcelona' },
        { '@type': 'Place', sameAs: 'https://www.geonames.org/3128760', address: { addressCountry: 'FR' } },
        { '@type': 'Place', sameAs: 'https://www.geonames.org/42' },
      ],
    });
    expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['jobPosting.jobLocation[0].address.addressCountry', 'unknown_country'],
      ['jobPosting.jobLocation[3].address', 'structured_address_required'],
      ['jobPosting.jobLocation[4].address.addressCountry', 'country_required'],
      ['jobPosting.jobLocation[5].sameAs', 'invalid_place_reference'],
      ['jobPosting.jobLocation[1].address.addressLocality', 'unknown_place'],
      ['jobPosting.jobLocation[2].address.addressLocality', 'ambiguous_place'],
      ['jobPosting.jobLocation[6].address.addressCountry', 'place_country_mismatch'],
      ['jobPosting.jobLocation[7].sameAs', 'unknown_place'],
    ]);
    expect(issues.find((issue) => issue.code === 'ambiguous_place')?.candidates).toEqual(['4409896', '4250542']);
  });

  it('requires a title and an employer, and reports a missing JobPosting', async () => {
    expect((await validateJobPostingPayload([{ '@type': 'JobPosting' }], fakeResolver())).issues.map((issue) => issue.code))
      .toEqual(['title_required', 'hiring_organization_required']);
    expect((await validateJobPostingPayload([{ '@type': 'Article' }], fakeResolver())).issues.map((issue) => issue.code))
      .toEqual(['job_posting_required']);
  });

  it('says the gazetteer is unavailable instead of rejecting a valid city', async () => {
    expect(await validate({ jobLocation: { '@type': 'Place', address: { addressLocality: 'Barcelona', addressCountry: 'ES' } } }, []))
      .toEqual({ issues: [], placesUnavailable: true });
    expect(foldPlaceName(' São  Paulo ')).toBe('sao paulo');
  });
});

describe('job search filters', () => {
  it('validates currency against the vocabulary and reads unknown locations as text', () => {
    expect(jobSearchSchema.parse({ salary: { min: 1, currency: 'eur' } }).salary?.currency).toBe('EUR');
    expect(jobSearchSchema.safeParse({ salary: { currency: 'ABC' } }).success).toBe(false);
    expect(jobSearchSchema.safeParse({ salary: { currency: 'XAU' } }).success).toBe(false);
    expect(jobSearchSchema.safeParse({ locations: ['ES', 'uk', 'eu', 'Barcelona', 'europe'] }).success).toBe(true);
    expect(jobSearchSchema.safeParse({ locations: ['NY', 'LA', 'ZZ'] }).success).toBe(true);
  });
});
