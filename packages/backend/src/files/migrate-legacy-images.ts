import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import {
  imageCache,
  imageReferences,
  jobPostings,
  searchDocuments,
  searchHosts,
} from '../db/schema/index.js';
import { STORED_IMAGE_RENDITION, renderStoredImage } from '../search/image-render.js';
import { isBlocked, isSvg, oxyFiles, svgUploadRefusal } from './oxy-files.js';
import { IMAGE_IDLE_TTL_MS } from './references.js';

/**
 * Copy the images Clarity kept itself into Oxy Files (ADR 0043 stage 4).
 *
 * - `clarity_image_cache.bytes` (the WebP renditions of document previews and
 *   employer logos) and `clarity_search_hosts.icon_bytes` (favicons, SVG ones
 *   included) become Clarity-owned public files.
 * - Each upload is VERIFIED: Oxy's SHA-256 and size of what it stored must equal
 *   those of the bytes sent, or the row is left as it was and reported. An SVG
 *   is the exception Oxy defines: stage 4c stores only its SANITIZED document,
 *   so what is checked is that Oxy stored an SVG at all (`image/svg+xml`, not
 *   empty), and the report carries the stored hash beside Clarity's.
 * - SAFE BEFORE STAGE 4C: an Oxy without it refuses the SVG type, and the row is
 *   left as it was (`refused`), still served from Postgres. An SVG stage 4c
 *   cannot sanitize (`invalid_svg`) is left too, unless `releaseInvalidSvg`
 *   drops Clarity's copy so the worker fetches the host's icon afresh.
 * - RESUMABLE: a row is moved (file id written, bytes cleared) in one statement
 *   after its own upload, so an interrupted run resumes where it stopped, and a
 *   repeated upload is free — Oxy deduplicates an application's bytes.
 * - The entities showing a moved image get their use recorded (documents and
 *   jobs pointing at its source URL, if it was read in the last 30 days; the
 *   host of an icon), so Oxy does not collect what Clarity still serves.
 * - PREVIEW changes nothing and calls nothing; it reports what apply would do.
 *
 * The report names content by SHA-256 only — never a URL or a host.
 */

export interface MigrationReportLine {
  kind: 'image' | 'favicon';
  sha256: string;
  bytes: number;
  outcome:
    | 'would_upload'
    | 'uploaded'
    | 'sha256_mismatch'
    | 'blocked'
    | 'refused'
    | 'unrenderable'
    | 'invalid_svg'
    | 'released_invalid_svg'
    | 'oxy_unavailable';
  oxyFileId?: string;
  /** The SHA-256 Oxy stored, when it is not Clarity's: a sanitized SVG. */
  storedSha256?: string;
}

export interface MigrationSummary {
  apply: boolean;
  images: Record<string, number>;
  favicons: Record<string, number>;
  usesRecorded: number;
}

export interface MigrationOptions {
  apply: boolean;
  /** Rows read per page. */
  batchSize?: number;
  /** Stop after this many rows of each kind (a canary run). */
  limit?: number;
  report?: (line: MigrationReportLine) => void;
  now?: number;
  /**
   * Drop Clarity's copy of an SVG favicon Oxy refused as `INVALID_SVG` (stage
   * 4c: not a document it can make safe), so the host shows no icon until the
   * worker fetches one Oxy accepts. Off by default: such a row is left, still
   * served from Postgres, and blocks the storage retirement until decided.
   */
  releaseInvalidSvg?: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function count(summary: Record<string, number>, outcome: string): void {
  summary[outcome] = (summary[outcome] ?? 0) + 1;
}

/** Upload one legacy copy and check that Oxy stored exactly these bytes. */
async function upload(
  bytes: Buffer,
  contentType: string,
): Promise<Pick<MigrationReportLine, 'outcome' | 'oxyFileId' | 'storedSha256'>> {
  try {
    const { file } = await oxyFiles().uploadAppFile(bytes, contentType, { visibility: 'public' });
    if (isSvg(contentType)) {
      // Stored sanitized (stage 4c): the hash is Oxy's document, not ours.
      if (!isSvg(file.mime) || file.size <= 0) return { outcome: 'sha256_mismatch' };
      return {
        outcome: 'uploaded',
        oxyFileId: file.id,
        ...(file.sha256 !== sha256(bytes) ? { storedSha256: file.sha256 } : {}),
      };
    }
    if (file.sha256 !== sha256(bytes) || file.size !== bytes.length) {
      return { outcome: 'sha256_mismatch' };
    }
    return { outcome: 'uploaded', oxyFileId: file.id };
  } catch (error) {
    if (isBlocked(error)) return { outcome: 'blocked' };
    if (isSvg(contentType) && svgUploadRefusal(error) === 'invalid_svg')
      return { outcome: 'invalid_svg' };
    const status = (error as { status?: unknown }).status;
    if (status === 413 || status === 415 || status === 400) return { outcome: 'refused' };
    return { outcome: 'oxy_unavailable' };
  }
}

async function migrateImages(options: MigrationOptions, summary: MigrationSummary): Promise<void> {
  const batch = options.batchSize ?? 100;
  let after = '';
  let seen = 0;
  while (options.limit === undefined || seen < options.limit) {
    const rows = await getDb()
      .select({ key: imageCache.key, bytes: imageCache.bytes, rendition: imageCache.rendition })
      .from(imageCache)
      .where(
        and(
          isNotNull(imageCache.bytes),
          isNull(imageCache.oxyFileId),
          eq(imageCache.status, 'ready'),
          gt(imageCache.key, after),
        ),
      )
      .orderBy(asc(imageCache.key))
      .limit(batch);
    if (rows.length === 0) return;
    for (const row of rows) {
      after = row.key;
      if (options.limit !== undefined && seen >= options.limit) return;
      seen += 1;
      if (!row.bytes) continue;
      // An older pipeline may have kept a site's original: what moves is the
      // rendition Clarity serves, never the original.
      const rendered =
        row.rendition >= STORED_IMAGE_RENDITION
          ? row.bytes
          : (await renderStoredImage(row.bytes))?.bytes;
      if (!rendered) {
        const line = {
          kind: 'image',
          sha256: sha256(row.bytes),
          bytes: row.bytes.length,
          outcome: 'unrenderable',
        } as const;
        options.report?.(line);
        count(summary.images, line.outcome);
        // Nothing servable to move: the row goes, and the next request
        // imports the image from its source.
        if (options.apply) await getDb().delete(imageCache).where(eq(imageCache.key, row.key));
        continue;
      }
      const digest = sha256(rendered);
      if (!options.apply) {
        options.report?.({
          kind: 'image',
          sha256: digest,
          bytes: rendered.length,
          outcome: 'would_upload',
        });
        count(summary.images, 'would_upload');
        continue;
      }
      const result = await upload(rendered, 'image/webp');
      options.report?.({ kind: 'image', sha256: digest, bytes: rendered.length, ...result });
      count(summary.images, result.outcome);
      if (result.outcome === 'uploaded' && result.oxyFileId) {
        await getDb()
          .update(imageCache)
          .set({ oxyFileId: result.oxyFileId, bytes: null, contentType: null, byteSize: 0 })
          .where(and(eq(imageCache.key, row.key), isNull(imageCache.oxyFileId)));
      } else if (result.outcome === 'blocked') {
        // Taken down after a content claim: Clarity stops serving it too.
        await getDb().delete(imageCache).where(eq(imageCache.key, row.key));
      }
    }
  }
}

async function migrateFavicons(
  options: MigrationOptions,
  summary: MigrationSummary,
): Promise<void> {
  const batch = options.batchSize ?? 100;
  let after = '';
  let seen = 0;
  const now = new Date(options.now ?? Date.now());
  while (options.limit === undefined || seen < options.limit) {
    const rows = await getDb()
      .select({
        host: searchHosts.host,
        bytes: searchHosts.iconBytes,
        contentType: searchHosts.iconContentType,
      })
      .from(searchHosts)
      .where(
        and(
          isNotNull(searchHosts.iconBytes),
          isNull(searchHosts.iconOxyFileId),
          eq(searchHosts.iconStatus, 'ready'),
          gt(searchHosts.host, after),
        ),
      )
      .orderBy(asc(searchHosts.host))
      .limit(batch);
    if (rows.length === 0) return;
    for (const row of rows) {
      after = row.host;
      if (!row.bytes || !row.contentType) continue;
      if (options.limit !== undefined && seen >= options.limit) return;
      seen += 1;
      const digest = sha256(row.bytes);
      if (!options.apply) {
        options.report?.({
          kind: 'favicon',
          sha256: digest,
          bytes: row.bytes.length,
          outcome: 'would_upload',
        });
        count(summary.favicons, 'would_upload');
        continue;
      }
      const uploaded = await upload(row.bytes, row.contentType);
      const result =
        uploaded.outcome === 'invalid_svg' && options.releaseInvalidSvg
          ? { outcome: 'released_invalid_svg' as const }
          : uploaded;
      options.report?.({ kind: 'favicon', sha256: digest, bytes: row.bytes.length, ...result });
      count(summary.favicons, result.outcome);
      if (result.outcome === 'uploaded' && result.oxyFileId) {
        const oxyFileId = result.oxyFileId;
        await getDb().transaction(async (tx) => {
          const moved = await tx
            .update(searchHosts)
            .set({ iconOxyFileId: oxyFileId, iconBytes: null, updatedAt: now })
            .where(and(eq(searchHosts.host, row.host), isNull(searchHosts.iconOxyFileId)))
            .returning({ host: searchHosts.host });
          if (moved.length === 0) return;
          const recorded = await tx
            .insert(imageReferences)
            .values({ entityType: 'search_host', entityId: row.host, oxyFileId, lastUsedAt: now })
            .onConflictDoNothing()
            .returning({ entityId: imageReferences.entityId });
          summary.usesRecorded += recorded.length;
        });
      } else if (result.outcome === 'blocked') {
        await getDb()
          .update(searchHosts)
          .set({ iconStatus: 'missing', iconBytes: null, updatedAt: now })
          .where(eq(searchHosts.host, row.host));
      } else if (result.outcome === 'released_invalid_svg') {
        // Only on request: the host shows no icon until the worker, due now,
        // fetches one Oxy accepts.
        await getDb()
          .update(searchHosts)
          .set({
            iconStatus: 'missing',
            iconBytes: null,
            iconNextFetchAt: now,
            updatedAt: now,
          })
          .where(and(eq(searchHosts.host, row.host), isNull(searchHosts.iconOxyFileId)));
      }
    }
  }
}

/**
 * Record the uses of moved images by the entities that show them, a page of
 * entities at a time (joined on the source URL, which has no index of its own
 * on the entity tables). Idempotent: an entity with a use keeps it.
 */
async function recordEntityUses(
  options: MigrationOptions,
  summary: MigrationSummary,
): Promise<void> {
  if (!options.apply) return;
  const now = options.now ?? Date.now();
  const usedSince = new Date(now - IMAGE_IDLE_TTL_MS);
  const page = 5000;

  let after = '';
  for (;;) {
    const ids = await getDb()
      .select({ id: searchDocuments.id })
      .from(searchDocuments)
      .where(and(isNotNull(searchDocuments.imageUrl), gt(searchDocuments.id, after)))
      .orderBy(asc(searchDocuments.id))
      .limit(page);
    if (ids.length === 0) break;
    after = ids[ids.length - 1].id;
    const recorded = await getDb().execute<{ entity_id: string }>(sql`
      insert into ${imageReferences} (entity_type, entity_id, oxy_file_id, image_key, last_used_at)
      select 'search_document', d.id, c.oxy_file_id, c.key, c.last_accessed_at
      from ${searchDocuments} d
      join ${imageCache} c on c.source_url = d.image_url
      where ${inArray(
        sql`d.id`,
        ids.map((row) => row.id),
      )}
        and c.status = 'ready' and c.oxy_file_id is not null
        and c.last_accessed_at >= ${usedSince.toISOString()}::timestamptz
      on conflict do nothing
      returning entity_id`);
    summary.usesRecorded += Array.isArray(recorded) ? recorded.length : 0;
    if (ids.length < page) break;
  }

  after = '';
  for (;;) {
    const ids = await getDb()
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(isNotNull(jobPostings.employerLogoUrl), gt(jobPostings.id, after)))
      .orderBy(asc(jobPostings.id))
      .limit(page);
    if (ids.length === 0) break;
    after = ids[ids.length - 1].id;
    const recorded = await getDb().execute<{ entity_id: string }>(sql`
      insert into ${imageReferences} (entity_type, entity_id, oxy_file_id, image_key, last_used_at)
      select 'job_posting', j.id, c.oxy_file_id, c.key, c.last_accessed_at
      from ${jobPostings} j
      join ${imageCache} c on c.source_url = j.employer_logo_url
      where ${inArray(
        sql`j.id`,
        ids.map((row) => row.id),
      )}
        and c.status = 'ready' and c.oxy_file_id is not null
        and c.last_accessed_at >= ${usedSince.toISOString()}::timestamptz
      on conflict do nothing
      returning entity_id`);
    summary.usesRecorded += Array.isArray(recorded) ? recorded.length : 0;
    if (ids.length < page) break;
  }
}

/** Run the migration (or its preview). */
export async function migrateLegacyImages(options: MigrationOptions): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    apply: options.apply,
    images: {},
    favicons: {},
    usesRecorded: 0,
  };
  await migrateImages(options, summary);
  await migrateFavicons(options, summary);
  await recordEntityUses(options, summary);
  return summary;
}
