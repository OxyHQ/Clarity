import { Router } from 'express';
import net from 'node:net';

import { getDb } from '../db/index.js';
import { readSiteIcon, registerHosts } from '../search/site-icons.js';

/**
 * `GET /favicons/:host` — a site's favicon, served by Clarity.
 *
 * Public and credential-free, because an `<img>` sends no bearer. It serves
 * only what the worker stored (search/site-icons.ts); a host Clarity has not
 * fetched yet is registered here and answers 404 briefly, so the next load
 * finds it. The body is an image whose type Clarity sniffed, sent with a
 * sandboxing CSP so an SVG cannot run anything even opened directly.
 */
const router = Router();

const ICON_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MISS_MAX_AGE_SECONDS = 5 * 60;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A public DNS name: dotted, with an alphabetic TLD, and not an address. */
export function isPublicHostname(value: string): boolean {
  return HOST_PATTERN.test(value) && net.isIP(value) === 0 && !value.endsWith('.localhost') && !value.endsWith('.internal');
}

router.get('/:host', async (req, res) => {
  const host = String(req.params.host).toLowerCase();
  if (!isPublicHostname(host)) {
    res.status(400).json({ error: { code: 'invalid_host', message: 'A public hostname is required' } });
    return;
  }
  const icon = await readSiteIcon(host);
  if (!icon) {
    await registerHosts(getDb(), [{ url: `https://${host}/` }]);
    res.setHeader('Cache-Control', `public, max-age=${MISS_MAX_AGE_SECONDS}`);
    res.status(404).json({ error: { code: 'icon_not_found', message: 'Clarity has no icon for this host yet' } });
    return;
  }
  res.setHeader('Content-Type', icon.contentType);
  res.setHeader('Cache-Control', `public, max-age=${ICON_MAX_AGE_SECONDS}, stale-while-revalidate=86400`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.send(icon.bytes);
});

export default router;
