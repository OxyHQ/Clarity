import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requested: string[] = [];
let respond: (url: string) => { status: number; body: string | string[] } = () => ({ status: 404, body: '' });

vi.mock('@oxy.so/core/server', () => ({
  registrableApex: (host: string) => host.split('.').slice(-2).join('.'),
  safeFetch: vi.fn(async (url: string) => {
    requested.push(url);
    const { status, body } = respond(url);
    // A body given as several strings arrives as that many chunks.
    const chunks = (Array.isArray(body) ? body : [body]).map((part) => Buffer.from(part));
    return { status, response: Object.assign(Readable.from(chunks), { headers: { 'content-type': 'application/json' } }) };
  }),
}));

const ingested: string[] = [];
vi.mock('../../projection.js', () => ({
  ingestJobPosting: vi.fn(async (input: { canonicalUrl: string }) => {
    ingested.push(input.canonicalUrl);
    return { documentId: 'd', jobPostingIds: ['p'] };
  }),
  storedJobDocument: vi.fn(async (url: string) => stored.get(url)),
}));

const stored = new Map<string, { structuredData: unknown[]; fetchedAt: Date | null }>();

const presence = { recorded: [] as string[][], closedFor: [] as string[] };
vi.mock('../presence.js', () => ({
  recordFeedPresence: vi.fn(async (_feedId: string, urls: string[]) => { presence.recorded.push(urls); }),
  closeAbsentListings: vi.fn(async (feedId: string) => { presence.closedFor.push(feedId); return 0; }),
  closeGoneListing: vi.fn(async (url: string) => { presence.closedFor.push(`gone:${url}`); }),
}));

vi.mock('../robots.js', () => ({
  FEED_USER_AGENT: 'ClarityBot/test',
  assertRobotsAllow: vi.fn(async () => 0),
  robotsAllowUrl: vi.fn(async () => true),
}));

const { pollJobFeed } = await import('../poll.js');

/** A SmartRecruiters-shaped page: `count` postings starting at `offset`, `total` overall. */
function smartRecruitersPage(offset: number, count: number, total: number): string {
  return JSON.stringify({
    totalFound: total,
    content: Array.from({ length: count }, (_, index) => ({
      id: String(offset + index), name: `Role ${offset + index}`, company: { name: 'Acme', identifier: 'acme' },
    })),
  });
}

function offsetOf(url: string): number {
  return Number(new URL(url).searchParams.get('offset') ?? 0);
}

function feed(cursor: string | null) {
  return {
    id: 'f', kind: 'smartrecruiters', identifier: 'acme', label: null, enabled: true, pollIntervalSeconds: 21_600,
    nextPollAt: new Date(), lastPolledAt: null, lastStatus: null, lastError: null, listingsSeen: 0, cursor, discoveredFromFeedId: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('feed polling', () => {
  beforeEach(() => { requested.length = 0; ingested.length = 0; stored.clear(); presence.recorded.length = 0; presence.closedFor.length = 0; });

  it('walks a paged source to its end and leaves nothing to resume', async () => {
    respond = (url) => {
      const offset = offsetOf(url);
      return { status: 200, body: smartRecruitersPage(offset, Math.min(100, 250 - offset), 250) };
    };
    const outcome = await pollJobFeed(feed(null), { pageDelayMs: 0 });
    expect(requested.map(offsetOf)).toEqual([0, 100, 200]);
    expect(outcome).toMatchObject({ stored: 250, rejected: 0, cursor: null, discovered: [] });
    expect(new Set(ingested).size).toBe(250);
  });

  it('reads the newest page first, then resumes the backfill where the last poll stopped', async () => {
    respond = (url) => {
      const offset = offsetOf(url);
      return { status: 200, body: smartRecruitersPage(offset, Math.min(100, 350 - offset), 350) };
    };
    const outcome = await pollJobFeed(feed('200'), { pageDelayMs: 0 });
    expect(requested.map(offsetOf)).toEqual([0, 200, 300]);
    expect(outcome.cursor).toBeNull();
    expect(outcome.stored).toBe(250);
  });

  it('restarts the walk when the source rejects the stored cursor, and keeps the head page', async () => {
    respond = (url) => offsetOf(url) === 900
      ? { status: 400, body: '' }
      : { status: 200, body: smartRecruitersPage(offsetOf(url), 100, 2_000) };
    const outcome = await pollJobFeed(feed('900'), { pageDelayMs: 0 });
    expect(outcome).toMatchObject({ stored: 100, cursor: null });
  });

  it('keeps its place when a page deeper in the walk fails', async () => {
    respond = (url) => offsetOf(url) === 300
      ? { status: 503, body: '' }
      : { status: 200, body: smartRecruitersPage(offsetOf(url), 100, 2_000) };
    const outcome = await pollJobFeed(feed('200'), { pageDelayMs: 0 });
    expect(requested.map(offsetOf)).toEqual([0, 200, 300]);
    expect(outcome).toMatchObject({ stored: 200, cursor: '300' });
  });

  it('fetches a summary-only source\'s detail once, then re-observes it from storage until it ages out', async () => {
    const list = { result: [
      { id: '1', jobOpeningName: 'Fresh', employmentStatusLabel: 'Full-Time' },
      { id: '2', jobOpeningName: 'Known', employmentStatusLabel: 'Full-Time' },
      { id: '3', jobOpeningName: 'Stale', employmentStatusLabel: 'Full-Time' },
    ] };
    const opening = (name: string) => JSON.stringify({ result: { jobOpening: { jobOpeningName: name, jobOpeningStatus: 'Open', description: `<p>${name}</p>` } } });
    stored.set('https://acme.bamboohr.com/careers/2', { structuredData: [{ '@type': 'JobPosting', title: 'Known' }], fetchedAt: new Date() });
    stored.set('https://acme.bamboohr.com/careers/3', { structuredData: [{ '@type': 'JobPosting', title: 'Stale' }], fetchedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });
    respond = (url) => url.endsWith('/careers/list')
      ? { status: 200, body: JSON.stringify(list) }
      : { status: 200, body: opening(url.includes('/careers/1/') ? 'Fresh' : 'Stale') };
    const outcome = await pollJobFeed({ ...feed(null), kind: 'bamboohr' }, { pageDelayMs: 0 });
    expect(requested).toEqual([
      'https://acme.bamboohr.com/careers/list',
      'https://acme.bamboohr.com/careers/1/detail',
      'https://acme.bamboohr.com/careers/3/detail',
    ]);
    expect(outcome.stored).toBe(3);
  });

  it('reports the ATS boards an aggregator\'s listings link to, once each', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ has_next: false, jobs: [
      { id: '1', title: 'A', company_name: 'Dataiku', url: 'https://aidevboard.com/job/1', apply_url: 'https://job-boards.greenhouse.io/dataiku/jobs/1' },
      { id: '2', title: 'B', company_name: 'Dataiku', url: 'https://aidevboard.com/job/2', apply_url: 'https://job-boards.greenhouse.io/dataiku/jobs/2' },
      { id: '3', title: 'C', company_name: 'Spotify', url: 'https://aidevboard.com/job/3', apply_url: 'https://jobs.lever.co/spotify/x' },
      { id: '4', title: 'D', company_name: 'Own site', url: 'https://aidevboard.com/job/4', apply_url: 'https://own.example/jobs/4' },
    ] }) });
    const outcome = await pollJobFeed({ ...feed(null), kind: 'aidevboard', identifier: 'aidevboard' }, { pageDelayMs: 0 });
    expect(outcome.discovered).toEqual([
      { kind: 'greenhouse', identifier: 'dataiku', label: 'Dataiku' },
      { kind: 'lever', identifier: 'spotify', label: 'Spotify' },
    ]);
  });

  it('reads sitemap pages once, skips unchanged and noindex pages', async () => {
    const page = (title: string, extra = '') => `<html><head>${extra}<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting', title, hiringOrganization: { name: 'Gemeente' },
    })}</script></head></html>`;
    stored.set('https://jobs.example/v/unchanged', { structuredData: [{ '@type': 'JobPosting', title: 'Kept' }], fetchedAt: new Date('2026-10-05T00:00:00Z') });
    respond = (url) => {
      if (url.endsWith('/sitemap.xml')) {
        return { status: 200, body: `<urlset>
          <url><loc>https://jobs.example/v/new</loc><lastmod>2026-10-09</lastmod></url>
          <url><loc>https://jobs.example/v/unchanged</loc><lastmod>2026-10-01</lastmod></url>
          <url><loc>https://jobs.example/v/hidden</loc><lastmod>2026-10-08</lastmod></url></urlset>` };
      }
      if (url.endsWith('/hidden')) return { status: 200, body: page('Hidden', '<meta name="robots" content="noindex">') };
      return { status: 200, body: page('New') };
    };
    const outcome = await pollJobFeed({ ...feed(null), kind: 'sitemap', identifier: 'https://jobs.example/sitemap.xml' }, { pageDelayMs: 0 });
    expect(requested).toEqual(['https://jobs.example/sitemap.xml', 'https://jobs.example/v/new', 'https://jobs.example/v/hidden']);
    expect(ingested.sort()).toEqual(['https://jobs.example/v/new', 'https://jobs.example/v/unchanged']);
    expect(outcome.stored).toBe(2);
  });

  it('works through a whole-board dump larger than one poll, in turns', async () => {
    const jobs = Array.from({ length: 2_500 }, (_, index) => ({ id: index, title: `Role ${index}`, company_name: 'Acme', absolute_url: `https://boards.greenhouse.io/acme/jobs/${index}` }));
    respond = () => ({ status: 200, body: JSON.stringify({ jobs }) });
    const first = await pollJobFeed({ ...feed(null), kind: 'greenhouse' }, { pageDelayMs: 0 });
    expect(first).toMatchObject({ stored: 1_000, cursor: '@1000' });
    expect(ingested[0]).toBe('https://boards.greenhouse.io/acme/jobs/0');
    ingested.length = 0;
    const third = await pollJobFeed({ ...feed('@2000'), kind: 'greenhouse' }, { pageDelayMs: 0 });
    expect(third.cursor).toBe('@500');
    expect(ingested[0]).toBe('https://boards.greenhouse.io/acme/jobs/2000');
    expect(ingested[ingested.length - 1]).toBe('https://boards.greenhouse.io/acme/jobs/499');
  });

  it('closes by absence only after reading a whole board that lists every posting', async () => {
    respond = (url) => {
      const offset = offsetOf(url);
      return { status: 200, body: smartRecruitersPage(offset, Math.min(100, 250 - offset), 250) };
    };
    await pollJobFeed(feed(null), { pageDelayMs: 0 });
    expect(presence.recorded[0]).toHaveLength(250);
    expect(presence.closedFor).toEqual(['f']);

    // Resuming a deep walk has not read the board from the top: nothing is closed.
    presence.closedFor.length = 0;
    await pollJobFeed(feed('200'), { pageDelayMs: 0 });
    expect(presence.closedFor).toEqual([]);

    // A walk cut short by the page budget has not reached the end either.
    respond = (url) => ({ status: 200, body: smartRecruitersPage(offsetOf(url), 100, 5_000) });
    await pollJobFeed(feed(null), { pageDelayMs: 0 });
    expect(presence.closedFor).toEqual([]);
  });

  it('never closes by absence from a windowed source, or from a read that suddenly lists nothing', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ data: [], meta: { total: 0 } }) });
    await pollJobFeed({ ...feed(null), kind: 'freehire', identifier: 'freehire' }, { pageDelayMs: 0 });
    respond = () => ({ status: 200, body: JSON.stringify({ jobs: [] }) });
    await pollJobFeed({ ...feed(null), kind: 'greenhouse' }, { pageDelayMs: 0 });
    expect(presence.closedFor).toEqual([]);
  });

  it('closes a listing whose detail answers that it is gone', async () => {
    stored.set('https://acme.bamboohr.com/careers/9', { structuredData: [{ '@type': 'JobPosting', title: 'Old' }], fetchedAt: new Date('2026-01-01') });
    respond = (url) => url.endsWith('/careers/list')
      ? { status: 200, body: JSON.stringify({ result: [{ id: '9', jobOpeningName: 'Old' }] }) }
      : { status: 404, body: '' };
    await pollJobFeed({ ...feed(null), kind: 'bamboohr' }, { pageDelayMs: 0 });
    expect(presence.closedFor).toContain('gone:https://acme.bamboohr.com/careers/9');
  });

  it('streams a huge dump in windows, resuming where the last poll stopped, across chunk boundaries', async () => {
    const job = (index: number) => `<job><title><![CDATA[Role ${index}]]></title><url>https://apply.workable.com/j/${index}</url><company>Acme ${index}</company></job>`;
    const xml = `<?xml version="1.0"?><source><publisher>Workable</publisher>${Array.from({ length: 50 }, (_, index) => job(index)).join('')}</source>`;
    // Split mid-element so items span chunks.
    const chunks = xml.match(/[\s\S]{1,37}/g)!;
    respond = () => ({ status: 200, body: chunks });
    const provider = (await import('../registry.js')).JOB_FEED_PROVIDERS.indeed_xml;
    const original = provider.stream;
    (provider as { stream?: { element: string; listingsPerPoll: number } }).stream = { element: 'job', listingsPerPoll: 20 };
    try {
      const first = await pollJobFeed({ ...feed(null), kind: 'indeed_xml', identifier: 'https://feed.example/jobs.xml' }, { pageDelayMs: 0 });
      expect(first).toMatchObject({ stored: 20, cursor: '@20' });
      expect(ingested[0]).toBe('https://apply.workable.com/j/0');
      ingested.length = 0;
      const last = await pollJobFeed({ ...feed('@40'), kind: 'indeed_xml', identifier: 'https://feed.example/jobs.xml' }, { pageDelayMs: 0 });
      expect(last).toMatchObject({ stored: 10, cursor: null });
      expect(ingested[0]).toBe('https://apply.workable.com/j/40');
    } finally {
      (provider as { stream?: { element: string; listingsPerPoll: number } }).stream = original;
    }
  });

  it('fails the poll when the newest page cannot be read', async () => {
    respond = () => ({ status: 500, body: '' });
    await expect(pollJobFeed(feed(null), { pageDelayMs: 0 })).rejects.toThrow('feed responded 500');
  });
});
