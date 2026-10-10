import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requested: string[] = [];
let respond: (url: string) => { status: number; body: string } = () => ({ status: 404, body: '' });

vi.mock('@oxy.so/core/server', () => ({
  safeFetch: vi.fn(async (url: string) => {
    requested.push(url);
    const { status, body } = respond(url);
    return { status, response: Readable.from([Buffer.from(body)]) };
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
  beforeEach(() => { requested.length = 0; ingested.length = 0; stored.clear(); });

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

  it('fails the poll when the newest page cannot be read', async () => {
    respond = () => ({ status: 500, body: '' });
    await expect(pollJobFeed(feed(null), { pageDelayMs: 0 })).rejects.toThrow('feed responded 500');
  });
});
