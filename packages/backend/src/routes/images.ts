import { optionalAuth } from '../middleware/auth.js';
import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { jobPostings, searchDocuments } from '../db/schema/index.js';
import { oxyFileUrl } from '../files/oxy-files.js';
import { entityTypeOf, imageVersion, resolveImage, type ImageKind } from '../search/image-cache.js';
import { imageAtVariant, requestedImageVariant } from '../search/image-render.js';

/**
 * `GET /images/documents/:id/:version` — a document's preview image.
 * `GET /images/jobs/:id/:version` — a job posting's employer logo.
 *
 * STABLE addresses: every API response, stored link preview and SDK consumer
 * keeps using them while the images themselves moved into Oxy Files (ADR
 * 0041). The answer is a `302` to the image's Clarity-owned Oxy file on Oxy's
 * CDN, at the requested rung (`?variant=w320|w640|w1280`, the names of Oxy's
 * image ladder; anything else, or nothing, gets `w1280`) — never the bare
 * original, which Oxy keeps as the site served it. Redirecting rather than
 * handing consumers Oxy URLs is deliberate: the first request is what imports
 * an image (search/image-cache.ts), and a use is recorded only when an image is
 * served, which is what lets Clarity release one nobody looks at.
 *
 * During the soak a copy Clarity kept itself is still served directly (and
 * counted, docs/oxy-files.md).
 *
 * Public and credential-free, because an `<img>` sends no bearer, like
 * `/favicons`. The image is looked up from Clarity's OWN row by id; nothing in
 * the request names a URL, so this cannot be pointed at an arbitrary address.
 * The `version` segment is a digest of the source URL, so a re-crawled page
 * with a NEW image URL gets a new address, and a stale version gets a short
 * life so an old address heals.
 */
const router = Router();
// This surface is not reviewed for supervised consumption. Presented bearers never downgrade to anonymous.
router.use(optionalAuth);

const MAX_AGE_SECONDS = 24 * 60 * 60;
const STALE_WHILE_REVALIDATE_SECONDS = 7 * 24 * 60 * 60;
const STALE_VERSION_MAX_AGE_SECONDS = 60 * 60;
const MISS_MAX_AGE_SECONDS = 5 * 60;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

async function sourceUrlOf(kind: ImageKind, id: string): Promise<string | undefined> {
  if (kind === 'documents') {
    const [row] = await getDb()
      .select({ url: searchDocuments.imageUrl })
      .from(searchDocuments)
      .where(eq(searchDocuments.id, id))
      .limit(1);
    return row?.url ?? undefined;
  }
  const [row] = await getDb()
    .select({ url: jobPostings.employerLogoUrl })
    .from(jobPostings)
    .where(eq(jobPostings.id, id))
    .limit(1);
  return row?.url ?? undefined;
}

function notFound(res: Response): void {
  res.setHeader('Cache-Control', `public, max-age=${MISS_MAX_AGE_SECONDS}`);
  res
    .status(404)
    .json({ error: { code: 'image_not_found', message: 'Clarity has no image here' } });
}

function serve(kind: ImageKind) {
  return async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const version = String(req.params.version);
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: { code: 'invalid_id', message: 'A valid id is required' } });
      return;
    }
    const sourceUrl = await sourceUrlOf(kind, id);
    if (!sourceUrl) {
      notFound(res);
      return;
    }
    const answer = await resolveImage({ entityType: entityTypeOf(kind), entityId: id }, sourceUrl);
    if (answer.kind === 'unavailable') {
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({
        error: { code: 'image_unavailable', message: 'The image cannot be served right now' },
      });
      return;
    }
    if (answer.kind === 'none') {
      notFound(res);
      return;
    }
    const variant = requestedImageVariant(req.query.variant);
    const current = imageVersion(sourceUrl) === version;
    res.setHeader(
      'Cache-Control',
      current
        ? `public, max-age=${MAX_AGE_SECONDS}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`
        : `public, max-age=${STALE_VERSION_MAX_AGE_SECONDS}`,
    );
    if (answer.kind === 'oxy') {
      res.redirect(302, oxyFileUrl(answer.oxyFileId, variant));
      return;
    }
    const image = await imageAtVariant(answer.image, variant);
    if (!image) {
      notFound(res);
      return;
    }
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(image.bytes);
  };
}

router.get('/documents/:id/:version', serve('documents'));
router.get('/jobs/:id/:version', serve('jobs'));

export default router;
