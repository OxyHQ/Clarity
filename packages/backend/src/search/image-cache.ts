import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt, notExists, or, sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { imageCache, imageReferences } from '../db/schema/index.js';
import { recordLegacyRead } from '../files/legacy-reads.js';
import {
  isBlocked,
  isSourceFailure,
  oxyErrorOf,
  oxyFiles,
  type ReferenceEntityType,
} from '../files/oxy-files.js';
import { IMAGE_IDLE_TTL_MS, useImage } from '../files/references.js';
import {
  RENDERABLE_IMAGE_ACCEPT,
  STORED_IMAGE_RENDITION,
  renderStoredImage,
  type RenderedImage,
} from './image-render.js';
import { fetchBounded, hostOf, publicApiBase } from './site-icons.js';

/**
 * Remote images served from Clarity: a document's preview image and a job's
 * employer logo.
 *
 * The API never hands a consumer a site's own image URL. It hands out
 * `GET /images/<kind>/<id>/<version>` (routes/images.ts) — a stable address
 * that now REDIRECTS to the image as a Clarity-owned Oxy file (ADR 0041), so a
 * reader's browser still never asks the site for anything.
 *
 * - Filled lazily, the first time anyone asks for the image: Oxy imports it by
 *   URL (`importAppFile` — SSRF-safe, deduplicated per source URL, and the use
 *   registered in the same request). A source Oxy will not fetch itself — an
 *   `http:` URL, or one labelled with a type Oxy refuses although its bytes are
 *   an image — is fetched by Clarity (`safeFetch`), rendered to the `w1280`
 *   WebP rung, and uploaded (`uploadAppFile`): no image is lost to the move.
 * - Revalidated with the source once it is older than {@link IMAGE_REFRESH_MS};
 *   a changed image becomes a new file and every use moves to it.
 * - A failed fetch is remembered for {@link IMAGE_MISS_TTL_MS}.
 * - When it stops being used — see `clarity_image_references` — Clarity
 *   removes its reference and Oxy collects the file (ADR 0041 D5). That
 *   replaces the 30-day sweep that used to delete Clarity's own copy.
 *
 * During the soak a row may still hold the WebP Clarity kept itself (`bytes`):
 * it is served as before and counted as a legacy read, and
 * `images:migrate-to-oxy` moves it into Oxy (docs/oxy-files.md).
 *
 * The route resolves the source URL from Clarity's own rows by id, never from
 * the request, so it cannot be used as an open proxy.
 */

export type ImageKind = 'documents' | 'jobs';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
export const IMAGE_MISS_TTL_MS = 6 * 60 * 60 * 1000;
export { IMAGE_IDLE_TTL_MS };
/** A legacy row's `last_accessed_at` is written at most this often. */
const ACCESS_TOUCH_MS = 24 * 60 * 60 * 1000;
/**
 * A cache row whose file no entity has used for this long is forgotten: by then
 * Oxy has trashed the file (24 h) and deleted it (30 days in trash).
 */
const FORGET_UNUSED_MS = IMAGE_IDLE_TTL_MS + 31 * 24 * 60 * 60 * 1000;
/** Rows deleted per sweep statement, so one sweep never holds a long lock. */
const SWEEP_BATCH = 500;

/** The entity a kind of image belongs to, as Clarity references it in Oxy. */
export function entityTypeOf(kind: ImageKind): ReferenceEntityType {
  return kind === 'documents' ? 'search_document' : 'job_posting';
}

/** What a request for an image is answered with. */
export type ImageAnswer =
  /** The image is a Clarity-owned Oxy file: redirect to it. */
  | { kind: 'oxy'; oxyFileId: string }
  /** A copy Clarity kept before the move (served during the soak). */
  | { kind: 'legacy'; image: RenderedImage }
  /** Clarity has no image here. */
  | { kind: 'none' }
  /** Oxy could not be reached; nothing is remembered, try again. */
  | { kind: 'unavailable' };

/** The cache key of an image: the SHA-256 of its source URL. */
export function imageKey(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl).digest('hex');
}

/**
 * The version segment of an image URL. It changes when the source URL does, so
 * a consumer (and every CDN between it and Clarity) treats a re-crawled image as
 * a new resource instead of serving the old one.
 */
export function imageVersion(sourceUrl: string): string {
  return imageKey(sourceUrl).slice(0, 16);
}

/**
 * Where Clarity serves this image, or `undefined` when there is no image a
 * consumer could show (no URL, or not a public HTTP(S) one).
 */
export function publicImageUrl(
  kind: ImageKind,
  id: string,
  sourceUrl: string | null | undefined,
): string | undefined {
  if (!sourceUrl || !hostOf(sourceUrl)) return undefined;
  return `${publicApiBase()}/images/${kind}/${encodeURIComponent(id)}/${imageVersion(sourceUrl)}`;
}

interface Stored {
  oxyFileId: string;
  /** Whether Oxy already registered the requesting entity's use. */
  referencedFor?: string;
}

type StoreOutcome = Stored | 'missing' | 'unavailable';

/** Imports in progress in this process, so concurrent misses share one. */
const inFlight = new Map<string, Promise<StoreOutcome>>();

/**
 * Fetch the image ourselves and upload the rendition Clarity serves — for a
 * source Oxy will not fetch. Never keeps the site's original bytes.
 */
async function uploadFetched(sourceUrl: string): Promise<StoreOutcome> {
  const fetched = await fetchBounded(sourceUrl, RENDERABLE_IMAGE_ACCEPT, MAX_IMAGE_BYTES).catch(
    () => undefined,
  );
  if (!fetched || fetched.bytes.length === 0) return 'missing';
  const rendered = await renderStoredImage(fetched.bytes);
  if (!rendered) return 'missing';
  try {
    const { file } = await oxyFiles().uploadAppFile(rendered.bytes, rendered.contentType, {
      visibility: 'public',
    });
    return { oxyFileId: file.id };
  } catch (error) {
    return isBlocked(error) || isSourceFailure(error) ? 'missing' : 'unavailable';
  }
}

/** Bring the image at `sourceUrl` into Oxy as a Clarity file. */
async function importImage(
  sourceUrl: string,
  entity: { entityType: ReferenceEntityType; entityId: string },
  revalidate: boolean,
): Promise<StoreOutcome> {
  if (new URL(sourceUrl).protocol !== 'https:') return uploadFetched(sourceUrl);
  try {
    const imported = await oxyFiles().importAppFile(sourceUrl, {
      visibility: 'public',
      reference: entity,
      ...(revalidate ? { revalidate: true } : {}),
    });
    return {
      oxyFileId: imported.file.id,
      ...(imported.reference && imported.reference.result !== 'not_found'
        ? { referencedFor: `${entity.entityType}:${entity.entityId}` }
        : {}),
    };
  } catch (error) {
    // Oxy goes by the type the site declares; Clarity by the bytes. A
    // mislabelled image is still an image.
    if (oxyErrorOf(error).status === 415) return uploadFetched(sourceUrl);
    if (isBlocked(error) || isSourceFailure(error)) return 'missing';
    return 'unavailable';
  }
}

/**
 * Import (or revalidate) and record the outcome on the cache row. A failed
 * refresh keeps the file Clarity already had and is tried again one
 * miss-window later; a changed image moves every use of the old file to it.
 */
async function storeImage(
  key: string,
  sourceUrl: string,
  entity: { entityType: ReferenceEntityType; entityId: string },
  previous: { oxyFileId: string | null } | undefined,
  at: number,
): Promise<StoreOutcome> {
  const outcome = await importImage(sourceUrl, entity, Boolean(previous?.oxyFileId));
  if (outcome === 'unavailable') return outcome;
  const now = new Date(at);
  if (outcome === 'missing') {
    if (previous?.oxyFileId) {
      await getDb()
        .update(imageCache)
        .set({ fetchedAt: new Date(at - IMAGE_REFRESH_MS + IMAGE_MISS_TTL_MS) })
        .where(eq(imageCache.key, key));
      return { oxyFileId: previous.oxyFileId };
    }
    await getDb()
      .insert(imageCache)
      .values({ key, sourceUrl, status: 'missing', fetchedAt: now, lastAccessedAt: now })
      .onConflictDoUpdate({
        target: imageCache.key,
        set: { status: 'missing', fetchedAt: now, lastAccessedAt: now },
        // A row still holding a legacy copy keeps it: the migration moves it.
        setWhere: isNull(imageCache.bytes),
      });
    return outcome;
  }
  await getDb().transaction(async (tx) => {
    await tx
      .insert(imageCache)
      .values({
        key,
        sourceUrl,
        status: 'ready',
        oxyFileId: outcome.oxyFileId,
        fetchedAt: now,
        lastAccessedAt: now,
      })
      .onConflictDoUpdate({
        target: imageCache.key,
        set: {
          sourceUrl,
          status: 'ready',
          oxyFileId: outcome.oxyFileId,
          contentType: null,
          bytes: null,
          byteSize: 0,
          fetchedAt: now,
          lastAccessedAt: now,
        },
      });
    if (previous?.oxyFileId && previous.oxyFileId !== outcome.oxyFileId) {
      // Every entity showing this image now shows the new file; the trigger
      // owes Oxy the swap of each use.
      await tx
        .update(imageReferences)
        .set({ oxyFileId: outcome.oxyFileId })
        .where(eq(imageReferences.imageKey, key));
    }
  });
  return outcome;
}

function storeOnce(
  key: string,
  sourceUrl: string,
  entity: { entityType: ReferenceEntityType; entityId: string },
  previous: { oxyFileId: string | null } | undefined,
  at: number,
): Promise<StoreOutcome> {
  let flight = inFlight.get(key);
  if (!flight) {
    flight = storeImage(key, sourceUrl, entity, previous, at).finally(() => inFlight.delete(key));
    inFlight.set(key, flight);
  }
  return flight;
}

/** A legacy copy, rendered on the fly if an older pipeline kept it (never rewritten). */
async function legacyImage(bytes: Buffer, rendition: number): Promise<RenderedImage | undefined> {
  if (rendition >= STORED_IMAGE_RENDITION) return { contentType: 'image/webp', bytes };
  return renderStoredImage(bytes);
}

/**
 * The image `entity` shows (its `sourceUrl`), as a Clarity-owned Oxy file —
 * imported first when Clarity has none — and the use recorded.
 */
export async function resolveImage(
  entity: { entityType: ReferenceEntityType; entityId: string },
  sourceUrl: string,
  now = Date.now(),
): Promise<ImageAnswer> {
  if (!hostOf(sourceUrl)) return { kind: 'none' };
  const key = imageKey(sourceUrl);
  const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, key)).limit(1);

  if (row?.status === 'blocked') return { kind: 'none' };
  if (row) {
    const age = now - row.fetchedAt.getTime();
    if (row.status === 'ready' && !row.oxyFileId && row.bytes) {
      const image = await legacyImage(row.bytes, row.rendition);
      if (image) {
        recordLegacyRead('images', now);
        if (now - row.lastAccessedAt.getTime() > ACCESS_TOUCH_MS) {
          await getDb()
            .update(imageCache)
            .set({ lastAccessedAt: new Date(now) })
            .where(eq(imageCache.key, key));
        }
        return { kind: 'legacy', image };
      }
    }
    if (row.status === 'ready' && row.oxyFileId) {
      let oxyFileId = row.oxyFileId;
      let referenced = false;
      if (age >= IMAGE_REFRESH_MS) {
        const refreshed = await storeOnce(key, sourceUrl, entity, row, now);
        if (typeof refreshed === 'object') {
          oxyFileId = refreshed.oxyFileId;
          referenced = refreshed.referencedFor === `${entity.entityType}:${entity.entityId}`;
        }
      } else if (now - row.lastAccessedAt.getTime() > ACCESS_TOUCH_MS) {
        await getDb()
          .update(imageCache)
          .set({ lastAccessedAt: new Date(now) })
          .where(eq(imageCache.key, key));
      }
      const used = await useImage(
        { ...entity, oxyFileId, imageKey: key },
        { now, referencedInOxy: referenced },
      );
      if (used) return { kind: 'oxy', oxyFileId };
      // Oxy no longer has it: the row is forgotten; import it again below.
    } else if (row.status === 'missing' && age < IMAGE_MISS_TTL_MS) {
      return { kind: 'none' };
    }
  }

  const stored = await storeOnce(key, sourceUrl, entity, undefined, now);
  if (stored === 'unavailable') return { kind: 'unavailable' };
  if (stored === 'missing') return { kind: 'none' };
  const referenced = stored.referencedFor === `${entity.entityType}:${entity.entityId}`;
  await useImage(
    { ...entity, oxyFileId: stored.oxyFileId, imageKey: key },
    { now, referencedInOxy: referenced },
  );
  return { kind: 'oxy', oxyFileId: stored.oxyFileId };
}

/**
 * Forget what the cache no longer needs to remember, and report how many rows
 * went: failures whose window has passed, legacy copies nobody read in
 * {@link IMAGE_IDLE_TTL_MS} (so the migration does not move dead images), and
 * rows whose file no entity has used since Oxy collected it. The images
 * themselves are Oxy's to delete (ADR 0041 D5).
 */
export async function sweepImageCache(now = Date.now()): Promise<number> {
  const missBefore = new Date(now - IMAGE_MISS_TTL_MS);
  const idleBefore = new Date(now - IMAGE_IDLE_TTL_MS);
  const forgetBefore = new Date(now - FORGET_UNUSED_MS);
  let removed = 0;
  for (;;) {
    const rows = await getDb().execute<{ key: string }>(sql`
      delete from ${imageCache} where ${imageCache.key} in (
        select ${imageCache.key} from ${imageCache}
        where ${or(
          and(eq(imageCache.status, 'missing'), lt(imageCache.fetchedAt, missBefore)),
          and(
            isNotNull(imageCache.bytes),
            isNull(imageCache.oxyFileId),
            lt(imageCache.lastAccessedAt, idleBefore),
          ),
          and(
            isNotNull(imageCache.oxyFileId),
            lt(imageCache.lastAccessedAt, forgetBefore),
            notExists(
              getDb()
                .select({ one: sql`1` })
                .from(imageReferences)
                .where(eq(imageReferences.imageKey, imageCache.key)),
            ),
          ),
        )}
        limit ${SWEEP_BATCH}
      ) returning ${imageCache.key} as key`);
    const count = Array.isArray(rows) ? rows.length : 0;
    removed += count;
    if (count < SWEEP_BATCH) return removed;
  }
}
