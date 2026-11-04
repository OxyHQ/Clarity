/**
 * The URL a resource is known by: one answer for every place two links to the
 * same page must meet, so a document, a job listing and a feed's posting
 * cannot disagree about which query parameters name a page.
 */
import { canonicalizePublicUrl } from './query-primitives.js';

/**
 * Query parameters a link carries for whoever counts the click (a campaign, a
 * referrer, a feed, a session), never to choose what the page shows.
 */
export const TRACKING_PARAMETERS =
  /^(?:utm_|gh_|mc_|hsa_|pk_)|^(?:ref|source|src|gclid|fbclid|msclkid|trk|trackid|referrer|campaign|sid|origin)$/i;

/** `value` without its tracking parameters; any other part is left as it is. */
export function withoutTracking(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()])
      if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return value;
  }
}

const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
]);
const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/;

function youtubeWatchUrl(id: string | null | undefined): string | undefined {
  return id && YOUTUBE_VIDEO_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : undefined;
}

/**
 * The canonical URL a YouTube video's page declares, from any URL YouTube
 * documents for that video: `youtu.be/<id>`, `/watch?v=<id>` with whatever
 * else (a start time `t`, a playlist, a share id), `/embed/<id>`, `/live/<id>`,
 * and `/shorts/<id>`, whose canonical is itself. YouTube refuses ClarityBot, so
 * its videos are read from their oEmbed answer, which names no canonical.
 */
function youtubeCanonical(url: URL): string | undefined {
  const [, first = '', second = ''] = url.pathname.split('/');
  if (url.hostname === 'youtu.be') return youtubeWatchUrl(first);
  if (!YOUTUBE_HOSTS.has(url.hostname)) return undefined;
  if (first === 'watch' && !second) return youtubeWatchUrl(url.searchParams.get('v'));
  if (first === 'embed' || first === 'live') return youtubeWatchUrl(second);
  if (first === 'shorts' && YOUTUBE_VIDEO_ID.test(second))
    return `https://www.youtube.com/shorts/${second}`;
  return undefined;
}

/**
 * The URL a document is stored under when nothing it states names one: a page
 * with no trustworthy `<link rel=canonical>`, or one known only through its
 * oEmbed answer, an archived copy that declares none, or its URL's own words.
 * Its stored shape (`canonicalizePublicUrl`) without tracking parameters, in a
 * provider's documented canonical form where Clarity knows it. Two links to one
 * resource then reach one document, each recorded as its URL, instead of two.
 */
export function resourceUrl(value: string): string {
  const url = withoutTracking(canonicalizePublicUrl(value));
  return youtubeCanonical(new URL(url)) ?? url;
}
