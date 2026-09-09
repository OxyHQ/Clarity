import { describe, expect, it } from 'vitest';

import { parseJobFeed } from '../adapters.js';
import { JOB_FEED_KINDS, jobFeedUrl } from '../endpoints.js';

const extractedAt = '2026-09-09T00:00:00.000Z';
const context = (kind: (typeof JOB_FEED_KINDS)[number], identifier: string) => ({
  kind, identifier, requestUrl: jobFeedUrl(kind, identifier), extractedAt,
});

describe('keyless job feed endpoints', () => {
  it('builds a public URL for every supported kind and needs no credential', () => {
    for (const kind of JOB_FEED_KINDS) {
      const url = new URL(jobFeedUrl(kind, kind === 'rss' ? 'https://example.com/jobs.rss' : 'acme'));
      expect(url.protocol).toBe('https:');
      expect(url.search).not.toMatch(/key|token|secret|api[_-]?key/i);
      expect(url.username).toBe('');
      expect(url.password).toBe('');
    }
  });

  it('refuses an identifier that would fetch the wrong board', () => {
    expect(() => jobFeedUrl('greenhouse', '../../etc/passwd')).toThrow('Identifier for greenhouse');
    expect(() => jobFeedUrl('lever', 'acme/../evil')).toThrow();
    expect(() => jobFeedUrl('rss', 'http://example.com/feed')).toThrow('https');
    expect(() => jobFeedUrl('rss', 'not a url')).toThrow();
  });
});

describe('job feed adapters', () => {
  it('prefers a provider\'s embedded JobPosting JSON-LD over its own fields', () => {
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'JobPosting',
      title: 'Staff Engineer', hiringOrganization: { name: 'Acme' },
      employmentType: 'FULL_TIME', datePosted: '2026-09-01',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
    });
    const [job] = parseJobFeed('greenhouse', JSON.stringify({
      jobs: [{ id: 1, title: 'Ignored fallback title', content: jsonLd, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }],
    }), context('greenhouse', 'acme'));
    expect(job).toMatchObject({ title: 'Staff Engineer', employmentTypes: ['full_time'] });
    expect(job.evidence.title.source).toBe('feed');
  });

  it('maps a Greenhouse board without JSON-LD', () => {
    const [job] = parseJobFeed('greenhouse', JSON.stringify({
      jobs: [{
        id: 4242, title: 'Backend Engineer', company_name: 'Acme',
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/4242',
        location: { name: 'Barcelona, Spain' }, updated_at: '2026-09-05T10:00:00Z',
        content: 'Build the platform.',
      }],
    }), context('greenhouse', 'acme'));
    expect(job).toMatchObject({
      title: 'Backend Engineer', employerName: 'Acme', identifier: '4242',
      canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/4242',
    });
    expect(job.locations[0]).toMatchObject({ raw: 'Barcelona, Spain', countryCode: 'ES', locality: 'Barcelona' });
  });

  it('maps Lever, keeping only workplace types the source stated', () => {
    const [remote, unstated] = parseJobFeed('lever', JSON.stringify([
      { id: 'a', text: 'Designer', hostedUrl: 'https://jobs.lever.co/acme/a', categories: { location: 'Berlin, Germany', workplaceType: 'remote', commitment: 'Full-time' } },
      { id: 'b', text: 'Analyst', hostedUrl: 'https://jobs.lever.co/acme/b', categories: { location: 'Berlin, Germany' } },
    ]), context('lever', 'acme'));
    expect(remote).toMatchObject({ workplaceType: 'remote', employmentTypes: ['full_time'] });
    expect(unstated.workplaceType).toBeUndefined();
    expect(unstated.employmentTypes).toEqual([]);
  });

  it('treats RemoteOK\'s zero salary as unstated rather than free', () => {
    const withSalary = parseJobFeed('remoteok', JSON.stringify([
      { legal: 'attribution notice' },
      { id: 1, position: 'React Native Dev', company: 'Acme', url: 'https://remoteok.com/l/1', salary_min: 90000, salary_max: 120000, tags: ['react', 'mobile'], date: '2026-09-06T00:00:00Z' },
      { id: 2, position: 'Analyst', company: 'Acme', url: 'https://remoteok.com/l/2', salary_min: 0, salary_max: 0 },
    ]), context('remoteok', 'remoteok'));
    expect(withSalary).toHaveLength(2);
    expect(withSalary[0]).toMatchObject({
      workplaceType: 'remote',
      salary: { min: 90000, max: 120000, currency: 'USD', interval: 'year' },
      skills: ['react', 'mobile'],
    });
    expect(withSalary[1].salary).toBeUndefined();
  });

  it('maps Remotive and Arbeitnow', () => {
    const [remotive] = parseJobFeed('remotive', JSON.stringify({
      jobs: [{ id: 7, title: 'Mobile Engineer', company_name: 'Acme', url: 'https://remotive.com/j/7', job_type: 'full_time', candidate_required_location: 'Europe, USA', publication_date: '2026-09-04' }],
    }), context('remotive', 'remotive'));
    expect(remotive).toMatchObject({
      workplaceType: 'remote', employmentTypes: ['full_time'],
      applicantLocationRequirements: ['Europe', 'USA'],
    });

    const [arbeitnow] = parseJobFeed('arbeitnow', JSON.stringify({
      data: [{ slug: 'x', title: 'Platform Engineer', company_name: 'Acme', url: 'https://arbeitnow.com/x', location: 'Berlin', remote: true, job_types: ['full_time'], created_at: 1788912000 }],
    }), context('arbeitnow', 'arbeitnow'));
    expect(arbeitnow).toMatchObject({ workplaceType: 'remote', identifier: 'x' });
    expect(arbeitnow.publishedAt?.toISOString()).toBe('2026-09-09T00:00:00.000Z');
  });

  it('parses RSS and Atom without inventing what a feed cannot state', () => {
    const [job] = parseJobFeed('rss', `<?xml version="1.0"?><rss><channel><title>Acme Careers</title>
      <item><title><![CDATA[Senior Developer]]></title>
      <link>https://acme.example/jobs/9</link>
      <description>Join the platform team.</description>
      <pubDate>Mon, 08 Sep 2026 09:00:00 GMT</pubDate>
      <guid>acme-9</guid></item></channel></rss>`, context('rss', 'https://acme.example/jobs.rss'));
    expect(job).toMatchObject({
      title: 'Senior Developer', employerName: 'Acme Careers',
      canonicalUrl: 'https://acme.example/jobs/9', identifier: 'acme-9',
    });
    expect(job.salary).toBeUndefined();
    expect(job.employmentTypes).toEqual([]);
    expect(job.workplaceType).toBeUndefined();

    const [atom] = parseJobFeed('rss', `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Studio Jobs</title>
      <entry><title>Product Designer</title><link href="https://studio.example/j/2"/>
      <summary>Design work.</summary><updated>2026-09-07T12:00:00Z</updated></entry></feed>`,
      context('rss', 'https://studio.example/feed.atom'));
    expect(atom).toMatchObject({ title: 'Product Designer', canonicalUrl: 'https://studio.example/j/2', employerName: 'Studio Jobs' });
  });

  it('drops entries missing a title, an employer or a URL', () => {
    const jobs = parseJobFeed('greenhouse', JSON.stringify({
      jobs: [
        { id: 1, title: 'No URL', company_name: 'Acme' },
        { id: 2, company_name: 'Acme', absolute_url: 'https://boards.greenhouse.io/acme/2' },
        { id: 3, title: 'Complete', company_name: 'Acme', absolute_url: 'https://boards.greenhouse.io/acme/3' },
      ],
    }), context('greenhouse', 'acme'));
    expect(jobs.map((job) => job.title)).toEqual(['Complete']);
  });

  it('fails loudly when a board returns something that is not JSON', () => {
    expect(() => parseJobFeed('lever', '<html>rate limited</html>', context('lever', 'acme')))
      .toThrow('not JSON');
  });
});
