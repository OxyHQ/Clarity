import { describe, expect, it } from 'vitest';

import { extractDocument } from '../../extractor.js';
import { extractJobPostings, hasJobPosting } from '../extract.js';

const extractedAt = '2026-09-09T00:00:00.000Z';

function jsonLd(posting: Record<string, unknown>): unknown[] {
  return [{ '@context': 'https://schema.org', '@type': 'JobPosting', ...posting }];
}

describe('JobPosting extraction', () => {
  it('normalizes a complete Google-style posting', () => {
    const [job] = extractJobPostings(jsonLd({
      title: 'Senior React Native Engineer',
      description: '<p>Build the <b>mobile</b> client.</p><ul><li>Ship features</li></ul>',
      identifier: { '@type': 'PropertyValue', name: 'Acme', value: 'REQ-1042' },
      datePosted: '2026-09-01',
      validThrough: '2026-12-01T00:00:00Z',
      employmentType: ['FULL_TIME', 'CONTRACTOR'],
      hiringOrganization: {
        '@type': 'Organization',
        name: 'Acme',
        url: 'https://www.acme.example/',
        logo: '/logo.png',
      },
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Barcelona',
          addressRegion: 'Catalonia',
          addressCountry: 'Spain',
          postalCode: '08001',
        },
      },
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'EUR',
        value: { '@type': 'QuantitativeValue', minValue: 60000, maxValue: 80000, unitText: 'YEAR' },
      },
      skills: 'React Native, TypeScript',
      directApply: true,
      url: 'https://acme.example/careers/react-native',
    }), 'https://acme.example/careers/react-native', extractedAt);

    expect(job).toMatchObject({
      title: 'Senior React Native Engineer',
      employerName: 'Acme',
      employerUrl: 'https://www.acme.example/',
      employerDomain: 'acme.example',
      employerLogoUrl: 'https://acme.example/logo.png',
      identifier: 'REQ-1042',
      sourceKey: 'REQ-1042',
      workplaceType: 'onsite',
      employmentTypes: ['full_time', 'contract'],
      skills: ['React Native', 'TypeScript'],
      directApply: true,
      salary: { min: 60000, max: 80000, currency: 'EUR', interval: 'year' },
      canonicalUrl: 'https://acme.example/careers/react-native',
    });
    expect(job.locations).toEqual([{
      raw: 'Barcelona, Catalonia, Spain',
      countryCode: 'ES',
      country: 'Spain',
      region: 'Catalonia',
      locality: 'Barcelona',
      postalCode: '08001',
    }]);
    expect(job.description).toContain('Build the mobile client.');
    expect(job.description).not.toContain('<b>');
    expect(job.publishedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(job.validThrough?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(job.evidence.salary).toEqual({ source: 'json_ld', selector: 'JobPosting', extractedAt });
    expect(job.evidence.employer).toEqual({ source: 'json_ld', selector: 'JobPosting', extractedAt });
  });

  it('reads postings nested in an @graph wrapper', () => {
    const nodes = [{
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Careers' },
        { '@type': ['JobPosting'], title: 'Designer', hiringOrganization: { name: 'Studio' } },
      ],
    }];
    expect(hasJobPosting(nodes)).toBe(true);
    expect(extractJobPostings(nodes, 'https://studio.example/jobs', extractedAt)).toHaveLength(1);
  });

  it('classifies a page carrying JobPosting structured data as a job document', () => {
    const html = `<!doctype html><html lang="en"><head><title>Role</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
        {"@type":"JobPosting","title":"Backend Engineer","hiringOrganization":{"name":"Acme"}}]}</script>
      </head><body><p>${'Job body text. '.repeat(30)}</p></body></html>`;
    expect(extractDocument(html, 'https://acme.example/jobs/1').documentType).toBe('job');
  });

  it('derives remote and hybrid only from explicit structured signals', () => {
    const remote = extractJobPostings(jsonLd({
      title: 'Remote Engineer',
      hiringOrganization: { name: 'Acme' },
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ '@type': 'Country', name: 'Spain' }, { '@type': 'Country', name: 'Portugal' }],
    }), 'https://acme.example/remote', extractedAt);
    expect(remote[0]).toMatchObject({ workplaceType: 'remote', applicantLocationRequirements: ['Spain', 'Portugal'] });

    const hybrid = extractJobPostings(jsonLd({
      title: 'Hybrid Engineer',
      hiringOrganization: { name: 'Acme' },
      jobLocationType: 'TELECOMMUTE',
      jobLocation: { address: { addressLocality: 'Madrid', addressCountry: 'ES' } },
    }), 'https://acme.example/hybrid', extractedAt);
    expect(hybrid[0].workplaceType).toBe('hybrid');

    const unknown = extractJobPostings(jsonLd({
      title: 'Unstated Engineer',
      hiringOrganization: { name: 'Acme' },
    }), 'https://acme.example/unknown', extractedAt);
    expect(unknown[0].workplaceType).toBeUndefined();
    expect(unknown[0].evidence.workplaceType).toBeUndefined();
  });

  it('never invents a salary, employment type or date that the source omitted', () => {
    const [job] = extractJobPostings(jsonLd({
      title: 'Analyst',
      hiringOrganization: { name: 'Acme' },
      baseSalary: { '@type': 'MonetaryAmount', value: { '@type': 'QuantitativeValue', value: 50000 } },
      employmentType: 'SOMETHING_ELSE',
    }), 'https://acme.example/analyst', extractedAt);
    expect(job.salary).toBeUndefined();
    expect(job.employmentTypes).toEqual([]);
    expect(job.publishedAt).toBeUndefined();
    expect(job.validThrough).toBeUndefined();
    expect(job.evidence).not.toHaveProperty('salary');
  });

  it('accepts a single hourly amount and a bare numeric value', () => {
    const [hourly] = extractJobPostings(jsonLd({
      title: 'Support Agent',
      hiringOrganization: { name: 'Acme' },
      baseSalary: {
        '@type': 'MonetaryAmount', currency: 'usd',
        value: { '@type': 'QuantitativeValue', value: '25.5', unitText: 'HOUR' },
      },
    }), 'https://acme.example/support', extractedAt);
    expect(hourly.salary).toEqual({ min: 25.5, max: 25.5, currency: 'USD', interval: 'hour' });
  });

  it('drops nodes without a title or hiring organization', () => {
    expect(extractJobPostings(jsonLd({ title: 'Orphan role' }), 'https://acme.example/x', extractedAt)).toEqual([]);
    expect(extractJobPostings(jsonLd({ hiringOrganization: { name: 'Acme' } }), 'https://acme.example/x', extractedAt)).toEqual([]);
  });

  it('keeps several postings on one page distinguishable', () => {
    const jobs = extractJobPostings([
      { '@type': 'JobPosting', title: 'One', hiringOrganization: { name: 'Acme' }, url: 'https://acme.example/1' },
      { '@type': 'JobPosting', title: 'Two', hiringOrganization: { name: 'Acme' }, url: 'https://acme.example/2' },
      { '@type': 'JobPosting', title: 'Three', hiringOrganization: { name: 'Acme' } },
    ], 'https://acme.example/careers', extractedAt);
    expect(jobs.map((job) => job.sourceKey)).toEqual(['https://acme.example/1', 'https://acme.example/2', '2']);
  });

  it('marks API-ingested payloads with their own field source', () => {
    const [job] = extractJobPostings(jsonLd({
      title: 'Community Manager',
      hiringOrganization: { name: 'Mention' },
    }), 'https://mention.earth/jobs/7', extractedAt, 'api');
    expect(job.evidence.title).toEqual({ source: 'api', selector: 'JobPosting', extractedAt });
  });
});
