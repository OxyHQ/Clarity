import { and, gte, isNotNull, isNull, sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { imageCache, legacyImageReads, searchHosts } from '../db/schema/index.js';

/**
 * How often Clarity still answers an image from its OWN bytes — the number the
 * storage-retirement step waits on (docs/oxy-files.md).
 *
 * Counted in memory per (day, surface) and added to
 * `clarity_legacy_image_reads` by {@link flushLegacyReads}, so a busy image does
 * not turn every request into a write on one hot row.
 */
export type LegacyReadSurface = 'images' | 'favicons' | 'favicons_svg';

const pending = new Map<string, number>();

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function recordLegacyRead(surface: LegacyReadSurface, now = Date.now()): void {
  const key = `${today(now)}|${surface}`;
  pending.set(key, (pending.get(key) ?? 0) + 1);
}

/** Add the counted reads to Postgres. A failed write keeps them for the next flush. */
export async function flushLegacyReads(): Promise<number> {
  if (pending.size === 0) return 0;
  const entries = [...pending];
  pending.clear();
  try {
    await getDb()
      .insert(legacyImageReads)
      .values(
        entries.map(([key, reads]) => {
          const [day, surface] = key.split('|');
          return { day, surface, reads };
        }),
      )
      .onConflictDoUpdate({
        target: [legacyImageReads.day, legacyImageReads.surface],
        set: { reads: sql`${legacyImageReads.reads} + excluded.reads` },
      });
  } catch (error) {
    for (const [key, reads] of entries) pending.set(key, (pending.get(key) ?? 0) + reads);
    throw error;
  }
  return entries.reduce((sum, [, reads]) => sum + reads, 0);
}

/** Days of zero legacy reads the retirement step requires. */
export const RETIREMENT_QUIET_DAYS = 14;

export interface StorageRetirementStatus {
  /** Legacy reads per surface over the last {@link RETIREMENT_QUIET_DAYS} days. */
  legacyReads: Record<LegacyReadSurface, number>;
  /** Cache rows still holding Clarity's own bytes. */
  imagesNotMigrated: number;
  /** Non-SVG icons still held by Clarity rather than Oxy. */
  faviconsNotMigrated: number;
  /** SVG icons Clarity keeps until Oxy can hold them (TODO(oxy-4c)); not a blocker. */
  svgFaviconsKept: number;
  /** True when the byte columns may be retired (docs/oxy-files.md). */
  ready: boolean;
}

/** Whether Clarity's own image storage can be retired, and why not. */
export async function storageRetirementStatus(now = Date.now()): Promise<StorageRetirementStatus> {
  const since = today(now - (RETIREMENT_QUIET_DAYS - 1) * 24 * 60 * 60 * 1000);
  const reads = await getDb()
    .select({
      surface: legacyImageReads.surface,
      reads: sql<number>`coalesce(sum(${legacyImageReads.reads}), 0)::bigint`.mapWith(Number),
    })
    .from(legacyImageReads)
    .where(gte(legacyImageReads.day, since))
    .groupBy(legacyImageReads.surface);
  const legacyReads: Record<LegacyReadSurface, number> = {
    images: 0,
    favicons: 0,
    favicons_svg: 0,
  };
  for (const row of reads) legacyReads[row.surface as LegacyReadSurface] = row.reads;

  const [{ images }] = await getDb()
    .select({ images: sql<number>`count(*)::int`.mapWith(Number) })
    .from(imageCache)
    .where(isNotNull(imageCache.bytes));
  const [{ favicons }] = await getDb()
    .select({ favicons: sql<number>`count(*)::int`.mapWith(Number) })
    .from(searchHosts)
    .where(
      and(
        isNotNull(searchHosts.iconBytes),
        isNull(searchHosts.iconOxyFileId),
        sql`${searchHosts.iconContentType} not like 'image/svg%'`,
      ),
    );
  const [{ svg }] = await getDb()
    .select({ svg: sql<number>`count(*)::int`.mapWith(Number) })
    .from(searchHosts)
    .where(
      and(isNotNull(searchHosts.iconBytes), sql`${searchHosts.iconContentType} like 'image/svg%'`),
    );

  return {
    legacyReads,
    imagesNotMigrated: images,
    faviconsNotMigrated: favicons,
    svgFaviconsKept: svg,
    ready: legacyReads.images === 0 && legacyReads.favicons === 0 && images === 0 && favicons === 0,
  };
}
