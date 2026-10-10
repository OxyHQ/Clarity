/**
 * robots.txt for feed endpoints.
 *
 * A public endpoint is still its operator's to govern: before a feed request
 * Clarity reads the origin's robots.txt and stays out of any path it
 * disallows for ClarityBot (or for every agent, when no group names
 * ClarityBot). A `Content-Signal` line that says `search=no` opts the origin
 * out of search indexing entirely, so it is honoured the same way. The
 * origin's `Crawl-delay` paces requests to it.
 *
 * Parsing follows RFC 9309: the most specific user-agent group applies, and
 * within it the longest matching rule wins, `Allow` on a tie. A robots.txt
 * that is missing (4xx) allows everything; one that cannot be read (5xx,
 * network failure) disallows everything until it can.
 */
import { safeFetch } from '@oxy.so/core/server';

export const FEED_USER_AGENT = 'ClarityBot/0.1 (+https://clarity.surf/bot)';
const AGENT_TOKEN = 'claritybot';
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_ROBOTS_BYTES = 512 * 1024;

interface Rule { allow: boolean; pattern: string }

export interface RobotsPolicy {
  rules: Rule[];
  /** Seconds between requests the origin asks for, if any. */
  crawlDelaySeconds?: number;
  /** The origin opted out of search with `Content-Signal: search=no`. */
  searchOptOut: boolean;
  /** robots.txt could not be read; nothing is fetched until it can. */
  unreachable: boolean;
}

/** Parses robots.txt for ClarityBot. */
export function parseRobots(body: string): RobotsPolicy {
  interface Group { agents: string[]; rules: Rule[]; crawlDelay?: number; signals: string[] }
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  const globalSignals: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], signals: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'content-signal') {
      (current ? current.signals : globalSignals).push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }
  const named = groups.filter((group) => group.agents.some((agent) => agent.split('/')[0].trim() === AGENT_TOKEN));
  const applicable = named.length > 0 ? named : groups.filter((group) => group.agents.includes('*'));
  const signals = [...globalSignals, ...applicable.flatMap((group) => group.signals)];
  const delays = applicable.map((group) => group.crawlDelay).filter((delay): delay is number => delay !== undefined);
  return {
    rules: applicable.flatMap((group) => group.rules),
    ...(delays.length > 0 ? { crawlDelaySeconds: Math.max(...delays) } : {}),
    searchOptOut: signals.some((signal) => /(?:^|[\s,])search\s*=\s*no(?:$|[\s,])/.test(signal)),
    unreachable: false,
  };
}

/** `*` matches any run of characters and a trailing `$` anchors the end, per RFC 9309. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const source = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/** Whether ClarityBot may request `pathAndQuery` under this policy. */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (policy.unreachable || policy.searchOptOut) return false;
  let decision: Rule | undefined;
  for (const rule of policy.rules) {
    if (!matches(rule.pattern, pathAndQuery)) continue;
    const longer = !decision || rule.pattern.length > decision.pattern.length;
    const tieAllows = decision && rule.pattern.length === decision.pattern.length && rule.allow;
    if (longer || tieAllows) decision = rule;
  }
  return decision ? decision.allow : true;
}

const cache = new Map<string, { policy: RobotsPolicy; fetchedAt: number }>();

async function fetchPolicy(origin: string): Promise<RobotsPolicy> {
  try {
    const result = await safeFetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': FEED_USER_AGENT, accept: 'text/plain' },
      maxRedirects: 3,
      headersTimeoutMs: 10_000,
    });
    if (result.status >= 400 && result.status < 500) {
      result.response.destroy();
      return { rules: [], searchOptOut: false, unreachable: false };
    }
    if (result.status !== 200) {
      result.response.destroy();
      return { rules: [], searchOptOut: false, unreachable: true };
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of result.response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      // RFC 9309 lets a crawler stop reading past a size limit; rules beyond it are ignored.
      if (bytes > MAX_ROBOTS_BYTES) { result.response.destroy(); break; }
      chunks.push(buffer);
    }
    return parseRobots(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return { rules: [], searchOptOut: false, unreachable: true };
  }
}

/** The origin's policy, read at most once a day per origin. */
export async function robotsPolicy(url: string): Promise<RobotsPolicy> {
  const { origin } = new URL(url);
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.policy;
  const policy = await fetchPolicy(origin);
  // An unreachable robots.txt is retried on the next poll rather than cached for a day.
  if (!policy.unreachable) cache.set(origin, { policy, fetchedAt: Date.now() });
  return policy;
}

/** Throws when robots.txt keeps ClarityBot away from `url`; returns the crawl delay to honour. */
export async function assertRobotsAllow(url: string): Promise<number> {
  const policy = await robotsPolicy(url);
  const target = new URL(url);
  if (policy.unreachable) throw new Error(`robots.txt for ${target.origin} could not be read`);
  if (policy.searchOptOut) throw new Error(`${target.origin} opts out of search (Content-Signal: search=no)`);
  if (!robotsAllows(policy, `${target.pathname}${target.search}`)) throw new Error(`robots.txt for ${target.origin} disallows ${target.pathname}`);
  return policy.crawlDelaySeconds ?? 0;
}

/** Whether ClarityBot may index the page at `url`. A robots.txt that cannot be read says no for now. */
export async function robotsAllowUrl(url: string): Promise<boolean> {
  const target = new URL(url);
  const policy = await robotsPolicy(url);
  return robotsAllows(policy, `${target.pathname}${target.search}`);
}

/** Test seam: forget cached policies. */
export function clearRobotsCache(): void {
  cache.clear();
}
