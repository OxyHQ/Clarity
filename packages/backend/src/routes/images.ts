import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { jobPostings, searchDocuments } from '../db/schema/index.js';
import { imageVersion, readCachedImage, type ImageKind } from '../search/image-cache.js';

/**
 * `GET /images/documents/:id/:version` — a document's preview image.
 * `GET /images/jobs/:id/:version` — a job posting's employer logo.
 *
 * Clarity's copy of a remote image (search/image-cache.ts). Public and
 * credential-free, because an `<img>` sends no bearer, like `/favicons`.
 *
 * The image to serve is looked up from Clarity's OWN row by id; nothing in the
 * request names a URL, so this cannot be pointed at an arbitrary address. The
 * `version` segment is a digest of the source URL: when it matches, the answer
 * never changes and is cached as immutable; when it does not (the page was
 * re-crawled with a new image), the current image is served with a short cache
 * life so the stale URL heals.
 */
const router = Router();

const IMMUTABLE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const STALE_VERSION_MAX_AGE_SECONDS = 60 * 60;
const MISS_MAX_AGE_SECONDS = 5 * 60;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

async function sourceUrlOf(kind: ImageKind, id: string): Promise<string | undefined> {
  if (kind === 'documents') {
    const [row] = await getDb().select({ url: searchDocuments.imageUrl })
      .from(searchDocuments).where(eq(searchDocuments.id, id)).limit(1);
    return row?.url ?? undefined;
  }
  const [row] = await getDb().select({ url: jobPostings.employerLogoUrl })
    .from(jobPostings).where(eq(jobPostings.id, id)).limit(1);
  return row?.url ?? undefined;
}

function notFound(res: Response): void {
  res.setHeader('Cache-Control', `public, max-age=${MISS_MAX_AGE_SECONDS}`);
  res.status(404).json({ error: { code: 'image_not_found', message: 'Clarity has no image here' } });
}

function serve(kind: ImageKind) {
  return async (req: { params: Record<string, string> }, res: Response) => {
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
    const image = await readCachedImage(sourceUrl);
    if (!image) {
      notFound(res);
      return;
    }
    const current = imageVersion(sourceUrl) === version;
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', current
      ? `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`
      : `public, max-age=${STALE_VERSION_MAX_AGE_SECONDS}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(image.bytes);
  };
}

router.get('/documents/:id/:version', serve('documents'));
router.get('/jobs/:id/:version', serve('jobs'));

export default router;
