import { describe, expect, it } from 'vitest';

import { extractJobPostings } from '../../extract.js';
import { normalizeSeniority } from '../../taxonomy.js';
import { listing, locationText, salary, salaryText, seniority, workplace } from '../listing.js';
import { toJsonLd } from '../poll.js';

const extractedAt = '2026-10-10T00:00:00.000Z';
const context = {
  kind: 'greenhouse' as const,
  identifier: 'acme',
  requestUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
  extractedAt,
};

describe('feed vocabulary helpers', () => {
  it('maps only career levels the source states unambiguously', () => {
    expect(normalizeSeniority('Entry Level')).toBe('entry');
    expect(normalizeSeniority('entry_level')).toBe('entry');
    expect(normalizeSeniority('Junior')).toBe('entry');
    expect(normalizeSeniority('Mid-level')).toBe('mid');
    expect(normalizeSeniority('Senior')).toBe('senior');
    expect(normalizeSeniority('C-Level')).toBe('executive');
    expect(normalizeSeniority('Internship')).toBe('intern');
    for (const ambiguous of [
      'mid_senior_level',
      'Mid-Senior level',
      'Associate',
      'Experienced',
      'Any',
      'Not Applicable',
      '',
    ]) {
      expect(normalizeSeniority(ambiguous), ambiguous).toBeUndefined();
    }
    expect(seniority(['Any', 'Senior'])).toBe('senior');
  });

  it('reads a trailing US state code as a region, never as the country that shares it', () => {
    expect(locationText('San Jose, CA')[0]).toEqual({
      raw: 'San Jose, CA',
      locality: 'San Jose',
      region: 'CA',
    });
    expect(locationText('Wilmington, DE')[0].countryCode).toBeUndefined();
    expect(locationText('Berlin, Germany')[0]).toMatchObject({
      countryCode: 'DE',
      locality: 'Berlin',
    });
    expect(locationText('Austin, Texas, United States')[0]).toMatchObject({
      locality: 'Austin',
      region: 'Texas',
      countryCode: 'US',
    });
  });

  it('keeps a salary only with a known currency and interval and a sane range', () => {
    expect(salary({ min: 50_000, max: 70_000, currency: 'eur', interval: 'yearly' })).toEqual({
      min: 50_000,
      max: 70_000,
      currency: 'EUR',
      interval: 'year',
    });
    expect(salary({ min: 0, max: 0, currency: 'USD', interval: 'year' })).toBeUndefined();
    expect(salary({ min: 90, max: 60, currency: 'USD', interval: 'hour' })).toBeUndefined();
    expect(salary({ min: 50_000, currency: 'XXX', interval: 'year' })).toBeUndefined();
    expect(salary({ min: 50_000, currency: 'USD' })).toBeUndefined();
  });

  it('reads a free-text salary only when amount, currency and interval are all stated', () => {
    expect(salaryText('£40,000 - 50,000 per year')).toEqual({
      min: 40_000,
      max: 50_000,
      currency: 'GBP',
      interval: 'year',
    });
    expect(salaryText('50.000 - 100.000 € per year')).toEqual({
      min: 50_000,
      max: 100_000,
      currency: 'EUR',
      interval: 'year',
    });
    expect(salaryText("CHF 125'000 - 140'000 per year")).toEqual({
      min: 125_000,
      max: 140_000,
      currency: 'CHF',
      interval: 'year',
    });
    expect(salaryText('120k-150k EUR annually')).toEqual({
      min: 120_000,
      max: 150_000,
      currency: 'EUR',
      interval: 'year',
    });
    expect(salaryText('$126.4K – $189.6K / yr', { dollar: 'USD' })).toEqual({
      min: 126_400,
      max: 189_600,
      currency: 'USD',
      interval: 'year',
    });
    expect(salaryText('$75,132.24 – $82,833.60 / year', { dollar: 'USD' })).toEqual({
      min: 75_132.24,
      max: 82_833.6,
      currency: 'USD',
      interval: 'year',
    });
    expect(salaryText('$40 – $45 per hour • Offers Bonus', { dollar: 'CAD' })).toEqual({
      min: 40,
      max: 45,
      currency: 'CAD',
      interval: 'hour',
    });
    expect(salaryText('$44,500 / year', { dollar: 'USD' })).toEqual({
      min: 44_500,
      max: 44_500,
      currency: 'USD',
      interval: 'year',
    });
    // A bare dollar with no stated country, a missing interval, or no figures at all.
    expect(salaryText('$40 – $45 per hour')).toBeUndefined();
    expect(salaryText('$230K – $268K • Offers Equity', { dollar: 'USD' })).toBeUndefined();
    expect(salaryText('£? - ? per year')).toBeUndefined();
    expect(salaryText('competitive')).toBeUndefined();
    expect(salaryText('€60k – $80k per year')).toBeUndefined();
  });

  it('normalizes workplace labels and leaves unknown ones absent', () => {
    expect(workplace('ON_SITE')).toBe('onsite');
    expect(workplace('Remote')).toBe('remote');
    expect(workplace('Hybrid')).toBe('hybrid');
    expect(workplace('sometimes')).toBeUndefined();
  });
});

describe('feed listing round trip', () => {
  it('survives re-expression as JSON-LD and the shared normalizer without losing a field', () => {
    const built = listing({
      title: 'Senior Platform Engineer',
      employerName: 'Acme',
      canonicalUrl: 'https://jobs.example/acme/1',
      applyUrl: 'https://acme.example/apply/1',
      context,
      description: 'Build the platform.',
      employerUrl: 'https://acme.example',
      employerLogoUrl: 'https://acme.example/logo.png',
      locations: locationText('Berlin, Germany'),
      applicantLocationRequirements: ['Germany'],
      workplaceType: 'remote',
      employmentTypes: ['full_time'],
      seniority: 'senior',
      salary: { min: 80_000, max: 100_000, currency: 'EUR', interval: 'year' },
      skills: ['go', 'kubernetes'],
      qualifications: '- 5 years of Go',
      responsibilities: '- Run the platform',
      educationRequirements: 'Bachelor degree',
      experienceRequirements: '5+ years',
      benefits: '- 30 days of holiday',
      industry: 'Software',
      occupationalCategory: 'Engineering',
      department: 'Infrastructure',
      identifier: 'REQ-1',
      directApply: false,
      publishedAt: new Date('2026-10-01T00:00:00.000Z'),
      validThrough: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(built).toBeDefined();
    const [extracted] = extractJobPostings(
      [{ '@context': 'https://schema.org', '@type': 'JobPosting', ...toJsonLd(built!) }],
      built!.canonicalUrl,
      extractedAt,
      'feed',
    );
    expect(extracted).toMatchObject({
      title: 'Senior Platform Engineer',
      canonicalUrl: 'https://jobs.example/acme/1',
      applyUrl: 'https://acme.example/apply/1',
      employerName: 'Acme',
      employerUrl: 'https://acme.example/',
      employerLogoUrl: 'https://acme.example/logo.png',
      // A remote role with a stated office stays remote; the location is kept.
      workplaceType: 'remote',
      employmentTypes: ['full_time'],
      seniority: 'senior',
      salary: { min: 80_000, max: 100_000, currency: 'EUR', interval: 'year' },
      skills: ['go', 'kubernetes'],
      qualifications: '- 5 years of Go',
      responsibilities: '- Run the platform',
      educationRequirements: 'Bachelor degree',
      experienceRequirements: '5+ years',
      benefits: '- 30 days of holiday',
      industry: 'Software',
      occupationalCategory: 'Engineering',
      department: 'Infrastructure',
      identifier: 'REQ-1',
      directApply: false,
    });
    expect(extracted.locations[0]).toMatchObject({
      raw: 'Berlin, Germany',
      countryCode: 'DE',
      locality: 'Berlin',
    });
    expect(extracted.publishedAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(extracted.validThrough?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(extracted.evidence.seniority.source).toBe('feed');
    expect(extracted.evidence.department.source).toBe('feed');
  });

  it('keeps a location the source gave only as text', () => {
    const built = listing({
      title: 'Engineer',
      employerName: 'Acme',
      canonicalUrl: 'https://jobs.example/acme/2',
      context,
      locations: [{ raw: 'Greater Lisbon Area' }],
    });
    const [extracted] = extractJobPostings(
      [{ '@type': 'JobPosting', ...toJsonLd(built!) }],
      built!.canonicalUrl,
      extractedAt,
      'feed',
    );
    expect(extracted.locations.map((location) => location.raw)).toEqual(['Greater Lisbon Area']);
  });

  it('records evidence only for the fields a source stated', () => {
    const built = listing({
      title: 'Engineer',
      employerName: 'Acme',
      canonicalUrl: 'https://jobs.example/acme/3',
      context,
    });
    expect(Object.keys(built!.evidence).sort()).toEqual(['canonicalUrl', 'employer', 'title']);
  });
});
