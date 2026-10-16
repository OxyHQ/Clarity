import { optionalAuth } from '../middleware/auth.js';
import { Router } from 'express';
import net from 'node:net';

import { getDb } from '../db/index.js';
import { oxyFileUrl } from '../files/oxy-files.js';
import { readSiteIcon, registerHosts } from '../search/site-icons.js';

/**
 * `GET /favicons/:host` — a site's favicon, served by Clarity.
 *
 * A STABLE address (the frontend and every API response build it from the
 * host alone): it answers with a `302` to the icon's Clarity-owned Oxy file
 * (ADR 0043). An SVG icon — which Oxy cannot hold yet, TODO(oxy-4c) in
 * `files/oxy-files.ts` — and, during the soak, an icon not yet migrated are
 * still sent from Clarity: an image whose type Clarity sniffed, with a
 * sandboxing CSP so an SVG cannot run anything even opened directly.
 *
 * Public and credential-free, because an `<img>` sends no bearer. A host
 * Clarity has no icon for yet is registered here and answers 404 briefly, so
 * the next load finds it.
 */
const router = Router();
// This surface is not reviewed for supervised consumption. Presented bearers never downgrade to anonymous.
router.use(optionalAuth);

const ICON_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** The redirect is cached for a day: a refreshed icon is a new file. */
const REDIRECT_MAX_AGE_SECONDS = 24 * 60 * 60;
const MISS_MAX_AGE_SECONDS = 5 * 60;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A public DNS name: dotted, with an alphabetic TLD, and not an address. */
export function isPublicHostname(value: string): boolean {
  return (
    HOST_PATTERN.test(value) &&
    net.isIP(value) === 0 &&
    !value.endsWith('.localhost') &&
    !value.endsWith('.internal')
  );
}

router.get('/:host', async (req, res) => {
  const host = String(req.params.host).toLowerCase();
  if (!isPublicHostname(host)) {
    res
      .status(400)
      .json({ error: { code: 'invalid_host', message: 'A public hostname is required' } });
    return;
  }
  const icon = await readSiteIcon(host);
  if (!icon) {
    await registerHosts(getDb(), [{ url: `https://${host}/` }]);
    res.setHeader('Cache-Control', `public, max-age=${MISS_MAX_AGE_SECONDS}`);
    res.status(404).json({
      error: { code: 'icon_not_found', message: 'Clarity has no icon for this host yet' },
    });
    return;
  }
  if (icon.kind === 'oxy') {
    res.setHeader(
      'Cache-Control',
      `public, max-age=${REDIRECT_MAX_AGE_SECONDS}, stale-while-revalidate=86400`,
    );
    res.redirect(302, oxyFileUrl(icon.oxyFileId));
    return;
  }
  res.setHeader('Content-Type', icon.contentType);
  res.setHeader(
    'Cache-Control',
    `public, max-age=${ICON_MAX_AGE_SECONDS}, stale-while-revalidate=86400`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  res.send(icon.bytes);
});

export default router;
