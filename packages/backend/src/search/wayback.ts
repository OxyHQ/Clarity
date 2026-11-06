/**
 * The Internet Archive's copy of a page Clarity cannot fetch itself.
 *
 * When a site refuses ClarityBot (a WAF 403, an interstitial, dropped
 * connections from cloud addresses), the Wayback Machine's public availability
 * API (https://archive.org/help/wayback_api.php) names its closest snapshot,
 * and that snapshot — requested unmodified (`id_`) — still carries the page's
 * own title, description, image and byline. Measured on 2026-11-04 over 80
 * previews that failed this way, 26 had a snapshot and every one of those had
 * OpenGraph metadata; publishers' RSS feeds held only 1 of the 80 and are not
 * used.
 *
 * Only the card is kept — title, description, image, publisher, dates,
 * authors — never the archived page text, and every field's evidence says
 * `wayback` with the snapshot's timestamp. Requests go through `safeFetch`
 * under each origin's robots.txt, bounded in size and time.
 */
import { readResponseBody, readResponseJson, safeFetch } from '@oxy.so/core/server';

import { asRecord } from '../lib/json-record.js';
import { createLogger } from '../lib/logger.js';
import { decodeBody } from './decode-body.js';
import { extractDocumentInThread } from './extraction-pool.js';
import type { ExtractedDocument } from './extractor.js';
import { FEED_USER_AGENT, robotsAllowUrl } from './jobs/feeds/robots.js';

const log = createLogger('wayback');
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

async function get(url: string, accept: string) {
  if (!(await robotsAllowUrl(url))) return undefined;
  const result = await safeFetch(url, {
    headers: { 'User-Agent': FEED_USER_AGENT, accept },
    maxRedirects: 3,
    headersTimeoutMs: 15_000,
    signal: AbortSignal.timeout(30_000),
  });
  if (result.status !== 200) {
    result.response.destroy();
    return undefined;
  }
  return result;
}

/** The closest snapshot's timestamp, if the Archive holds one. */
async function closestSnapshot(url: string): Promise<string | undefined> {
  const result = await get(
    `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    'application/json',
  );
  if (!result) return undefined;
  const body = await readResponseJson(result.response, { maxBytes: 64 * 1024, timeoutMs: 15_000 });
  if (body.kind !== 'ok') return undefined;
  const closest = asRecord(asRecord(asRecord(body.value)?.archived_snapshots)?.closest);
  const timestamp = closest?.timestamp;
  return closest?.available === true && typeof timestamp === 'string' && /^\d{14}$/.test(timestamp)
    ? timestamp
    : undefined;
}

/** The card the archived page states about itself, or `undefined` without a titled snapshot. */
export async function waybackDocument(url: string): Promise<ExtractedDocument | undefined> {
  try {
    const timestamp = await closestSnapshot(url);
    if (!timestamp) return undefined;
    const result = await get(
      `https://web.archive.org/web/${timestamp}id_/${url}`,
      'text/html,application/xhtml+xml',
    );
    if (!result) return undefined;
    const contentType = result.headers['content-type'];
    const type = Array.isArray(contentType) ? contentType[0] : contentType;
    if (!type?.includes('text/html')) {
      result.response.destroy();
      return undefined;
    }
    const body = await readResponseBody(result.response, {
      maxBytes: MAX_SNAPSHOT_BYTES,
      timeoutMs: 30_000,
    });
    if (body.kind !== 'ok') return undefined;
    // Relative references resolve against the page's own URL, as on the live site.
    const extracted = await extractDocumentInThread(decodeBody(body.body, type), url);
    if (!extracted.title) return undefined;
    const evidence = {
      source: 'wayback',
      selector: timestamp,
      extractedAt: new Date().toISOString(),
    };
    return {
      ...extracted,
      mainContent: undefined,
      structuredData: [],
      oembedUrl: undefined,
      evidence: Object.fromEntries(Object.keys(extracted.evidence).map((key) => [key, evidence])),
    };
  } catch (error) {
    log.debug({ err: error }, 'Wayback snapshot unavailable');
    return undefined;
  }
}
