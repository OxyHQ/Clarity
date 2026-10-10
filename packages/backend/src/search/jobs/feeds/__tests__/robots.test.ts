import { describe, expect, it } from 'vitest';

import { parseRobots, robotsAllows } from '../robots.js';

describe('robots.txt for feed endpoints', () => {
  it('keeps out of what the catch-all group disallows', () => {
    const policy = parseRobots(
      'User-agent: LinkedInBot\nAllow: /v1/companies/\n\nUser-agent: *\nDisallow: /\n',
    );
    expect(robotsAllows(policy, '/v1/companies/acme/postings')).toBe(false);
  });

  it('prefers a group naming ClarityBot over the catch-all', () => {
    const policy = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: ClarityBot\nAllow: /api/\nDisallow: /\n',
    );
    expect(robotsAllows(policy, '/api/jobs')).toBe(true);
    expect(robotsAllows(policy, '/private')).toBe(false);
  });

  it('lets the longest rule win, Allow on a tie, with * and $ patterns', () => {
    const policy = parseRobots(
      'User-agent: *\nDisallow: /api/*\nAllow: /api/public\nDisallow: /*.pdf$\nAllow: /tie\nDisallow: /tie\n',
    );
    expect(robotsAllows(policy, '/api/remote-jobs')).toBe(false);
    expect(robotsAllows(policy, '/api/public/jobs')).toBe(true);
    expect(robotsAllows(policy, '/files/a.pdf')).toBe(false);
    expect(robotsAllows(policy, '/files/a.pdf?x=1')).toBe(true);
    expect(robotsAllows(policy, '/tie')).toBe(true);
    expect(robotsAllows(policy, '/jobs')).toBe(true);
  });

  it('honours Content-Signal search=no as an opt-out and reads Crawl-delay', () => {
    const optedOut = parseRobots(
      'User-Agent: *\nDisallow: /app/\nContent-Signal: search=no, ai-train=no, ai-input=no\n',
    );
    expect(robotsAllows(optedOut, '/jobs.json')).toBe(false);
    const searchable = parseRobots(
      'User-agent: *\nContent-Signal: search=yes, ai-train=no\nCrawl-delay: 1\n',
    );
    expect(robotsAllows(searchable, '/jobs.json')).toBe(true);
    expect(searchable.crawlDelaySeconds).toBe(1);
  });

  it('treats an empty Disallow as allowing everything', () => {
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/anything')).toBe(true);
    expect(robotsAllows(parseRobots(''), '/anything')).toBe(true);
  });
});
