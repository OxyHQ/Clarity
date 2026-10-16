import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';

import { type ClarityExecutor, getDb } from '../db/index.js';
import {
  imageCache,
  imageReferences,
  oxyFileEvents,
  oxyFileJobs,
  oxyFileReferenceOutbox,
  searchHosts,
} from '../db/schema/index.js';
import { type ReferenceEntityType, REFERENCE_ENTITY_TYPES, oxyFiles } from './oxy-files.js';

/**
 * Clarity's side of ADR 0041's usage model: which entity shows which
 * Clarity-owned file (`clarity_image_references`, whose header defines when an
 * image STOPS being used), and keeping Oxy's `file_references` equal to it.
 *
 * - A use is recorded when an image is served ({@link useImage}); the row's
 *   insert, delete or file change is copied into the outbox by a trigger in the
 *   same transaction.
 * - {@link drainReferenceOutbox} sends the outbox to Oxy in order.
 * - {@link releaseIdleReferences} applies the 30-day "last used" rule.
 * - {@link reconcileDueReferences} is the nightly safety net (D6): the whole
 *   inventory per entity type, so a reference a crash or a bug lost is added
 *   and one Clarity no longer holds is removed.
 */

/** An image is in use while it is served at least this often from its entity. */
export const IMAGE_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often per entity, not on every hit. */
export const USE_TOUCH_MS = 24 * 60 * 60 * 1000;
/** Each entity type is reconciled this often. */
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Oxy's batch cap for `references.add`/`remove`. */
const OUTBOX_PAGE = 100;
/** How long a worker holds a job before another replica may take it. */
const JOB_LEASE_MS = 10 * 60 * 1000;
const RELEASE_BATCH = 500;
/** Oxy keeps an undelivered file event for 30 days; so does Clarity's dedupe. */
const FILE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ImageUse {
  entityType: ReferenceEntityType;
  entityId: string;
  oxyFileId: string;
  /** The `clarity_image_cache` key (documents and jobs); absent for a favicon. */
  imageKey?: string;
}

/**
 * Record that `use.entityType`/`use.entityId` is showing `use.oxyFileId` now.
 *
 * A known, current use costs one read (and a write at most once a day). A new
 * use — or one moved to another file — is written, and Oxy is told at once as
 * well as through the outbox: the file may be in Oxy's trash because Clarity
 * released it earlier, and a trashed file is not served until a reference
 * restores it. `false` means Oxy no longer has the file (deleted, or not
 * Clarity's to reference): it is forgotten here, and the caller fetches the
 * image afresh.
 */
export async function useImage(
  use: ImageUse,
  options: { now?: number; referencedInOxy?: boolean } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const [current] = await getDb()
    .select({ oxyFileId: imageReferences.oxyFileId, lastUsedAt: imageReferences.lastUsedAt })
    .from(imageReferences)
    .where(
      and(
        eq(imageReferences.entityType, use.entityType),
        eq(imageReferences.entityId, use.entityId),
      ),
    )
    .limit(1);
  if (current && current.oxyFileId === use.oxyFileId) {
    if (now - current.lastUsedAt.getTime() > USE_TOUCH_MS) {
      await getDb()
        .update(imageReferences)
        .set({ lastUsedAt: new Date(now) })
        .where(
          and(
            eq(imageReferences.entityType, use.entityType),
            eq(imageReferences.entityId, use.entityId),
          ),
        );
    }
    return true;
  }

  await getDb()
    .insert(imageReferences)
    .values({
      entityType: use.entityType,
      entityId: use.entityId,
      oxyFileId: use.oxyFileId,
      imageKey: use.imageKey ?? null,
      lastUsedAt: new Date(now),
    })
    .onConflictDoUpdate({
      target: [imageReferences.entityType, imageReferences.entityId],
      set: {
        oxyFileId: use.oxyFileId,
        imageKey: use.imageKey ?? null,
        lastUsedAt: new Date(now),
      },
    });
  if (options.referencedInOxy) return true;

  try {
    const [result] = await oxyFiles().references.add([
      { fileId: use.oxyFileId, entityType: use.entityType, entityId: use.entityId },
    ]);
    if (result?.result === 'not_found') {
      await forgetOxyFile(getDb(), use.oxyFileId);
      return false;
    }
  } catch {
    // Oxy is unreachable: the outbox row the trigger wrote delivers it later.
  }
  return true;
}

/**
 * Forget a file Oxy no longer has for Clarity (deleted, or refused as a
 * reference): the cache rows holding it go — and with them, by cascade, every
 * use of it — and a host holding it as its icon is due for a fresh fetch. The
 * next request imports the image again.
 */
export async function forgetOxyFile(executor: ClarityExecutor, oxyFileId: string): Promise<void> {
  await executor.delete(imageCache).where(eq(imageCache.oxyFileId, oxyFileId));
  await executor
    .delete(imageReferences)
    .where(
      and(eq(imageReferences.entityType, 'search_host'), eq(imageReferences.oxyFileId, oxyFileId)),
    );
  await executor
    .update(searchHosts)
    .set({
      iconOxyFileId: null,
      iconStatus: sql`case when ${searchHosts.iconBytes} is not null then ${searchHosts.iconStatus} else 'pending' end`,
      iconNextFetchAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(searchHosts.iconOxyFileId, oxyFileId));
}

/**
 * Hide (`blocked: true`) or show again everything Clarity serves from a file
 * Oxy took down after a content claim (ADR 0041 D10). The uses stay: the image
 * is still what those entities show, it is just not served.
 */
export async function setOxyFileBlocked(
  executor: ClarityExecutor,
  oxyFileId: string,
  blocked: boolean,
): Promise<void> {
  await executor
    .update(imageCache)
    .set({ status: blocked ? 'blocked' : 'ready' })
    .where(
      and(
        eq(imageCache.oxyFileId, oxyFileId),
        inArray(imageCache.status, blocked ? ['ready', 'missing'] : ['blocked']),
      ),
    );
  await executor
    .update(searchHosts)
    .set({ iconStatus: blocked ? 'blocked' : 'ready', updatedAt: new Date() })
    .where(
      and(
        eq(searchHosts.iconOxyFileId, oxyFileId),
        inArray(searchHosts.iconStatus, blocked ? ['ready', 'pending', 'missing'] : ['blocked']),
      ),
    );
}

/**
 * Re-send Clarity's uses of a file Oxy moved to trash. Oxy trashes an
 * application's file only when it holds no reference to it; if Clarity still
 * lists one, Oxy lost it (or a removal raced a new use), and re-adding it
 * restores the file. Returns how many uses were re-sent.
 */
export async function reassertUses(executor: ClarityExecutor, oxyFileId: string): Promise<number> {
  const uses = await executor
    .select({ entityType: imageReferences.entityType, entityId: imageReferences.entityId })
    .from(imageReferences)
    .where(eq(imageReferences.oxyFileId, oxyFileId));
  if (uses.length === 0) return 0;
  await executor.insert(oxyFileReferenceOutbox).values(
    uses.map((use) => ({
      op: 'add',
      oxyFileId,
      entityType: use.entityType,
      entityId: use.entityId,
    })),
  );
  return uses.length;
}

/**
 * The "last used" rule: release every use not served for
 * {@link IMAGE_IDLE_TTL_MS}. The delete's trigger owes Oxy the removal; Oxy
 * then trashes a file nothing else uses after 24 hours and deletes it 30 days
 * later (ADR 0041 D5), and a request in between restores it.
 */
export async function releaseIdleReferences(now = Date.now()): Promise<number> {
  const idleBefore = new Date(now - IMAGE_IDLE_TTL_MS);
  let released = 0;
  for (;;) {
    const rows = await getDb().execute<{ entity_id: string }>(sql`
      delete from ${imageReferences}
      where (${imageReferences.entityType}, ${imageReferences.entityId}) in (
        select ${imageReferences.entityType}, ${imageReferences.entityId} from ${imageReferences}
        where ${imageReferences.lastUsedAt} < ${idleBefore.toISOString()}::timestamptz
        limit ${RELEASE_BATCH}
      ) returning ${imageReferences.entityId} as entity_id`);
    const count = Array.isArray(rows) ? rows.length : 0;
    released += count;
    if (count < RELEASE_BATCH) return released;
  }
}

/** Forget delivered file events older than Oxy's own delivery window. */
export async function expireFileEvents(now = Date.now()): Promise<number> {
  const rows = await getDb()
    .delete(oxyFileEvents)
    .where(lt(oxyFileEvents.receivedAt, new Date(now - FILE_EVENT_RETENTION_MS)))
    .returning({ eventId: oxyFileEvents.eventId });
  return rows.length;
}

/** Take `name`'s lease when it is due; `false` when another replica holds it or it is not due. */
async function leaseJob(name: string): Promise<boolean> {
  await getDb().insert(oxyFileJobs).values({ name }).onConflictDoNothing();
  const leased = await getDb().execute<{ name: string }>(sql`
    update ${oxyFileJobs}
    set leased_until = now() + ${`${JOB_LEASE_MS} milliseconds`}::interval, updated_at = now()
    where ${oxyFileJobs.name} = ${name}
      and ${oxyFileJobs.nextRunAt} <= now()
      and (${oxyFileJobs.leasedUntil} is null or ${oxyFileJobs.leasedUntil} < now())
    returning ${oxyFileJobs.name} as name`);
  return Array.isArray(leased) && leased.length === 1;
}

async function finishJob(name: string, nextRunInMs: number, result: unknown): Promise<void> {
  await getDb()
    .update(oxyFileJobs)
    .set({
      leasedUntil: null,
      nextRunAt: new Date(Date.now() + nextRunInMs),
      lastResult: result as object,
      updatedAt: new Date(),
    })
    .where(eq(oxyFileJobs.name, name));
}

/** Back-off of the outbox head after `attempts` failures: 30 s doubling, at most an hour. */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

/**
 * Send owed reference changes to Oxy, oldest first, up to `limit`.
 *
 * Strictly in order — an add and a later remove of the same use must reach Oxy
 * in that order — so one replica drains at a time (a lease), consecutive rows
 * of the same operation go as one batch, and a failed batch stops the drain
 * with the head backed off. Oxy's per-item answers are all final: `not_found`
 * on a remove means there was nothing to remove, and on an add it means the
 * file is gone, which is forgotten here so the next request imports it again.
 */
export async function drainReferenceOutbox(limit = 1000): Promise<{
  sent: number;
  failed: boolean;
}> {
  if (!(await leaseJob('outbox'))) return { sent: 0, failed: false };
  let sent = 0;
  let failed = false;
  try {
    while (sent < limit) {
      const rows = await getDb()
        .select()
        .from(oxyFileReferenceOutbox)
        .orderBy(asc(oxyFileReferenceOutbox.id))
        .limit(OUTBOX_PAGE);
      if (rows.length === 0) break;
      if (rows[0].nextAttemptAt.getTime() > Date.now()) break;
      const op = rows[0].op;
      const batch = [];
      for (const row of rows) {
        if (row.op !== op) break;
        batch.push(row);
      }
      const ids = batch.map((row) => row.id);
      const references = batch.map((row) => ({
        fileId: row.oxyFileId,
        entityType: row.entityType,
        entityId: row.entityId,
      }));
      try {
        const results =
          op === 'add'
            ? await oxyFiles().references.add(references)
            : await oxyFiles().references.remove(references);
        await getDb().transaction(async (tx) => {
          if (op === 'add') {
            const gone = new Set(
              results.filter((r) => r.result === 'not_found').map((r) => r.fileId),
            );
            for (const fileId of gone) await forgetOxyFile(tx, fileId);
          }
          await tx.delete(oxyFileReferenceOutbox).where(inArray(oxyFileReferenceOutbox.id, ids));
        });
        sent += batch.length;
      } catch (error) {
        failed = true;
        const head = batch[0];
        await getDb()
          .update(oxyFileReferenceOutbox)
          .set({
            attempts: head.attempts + 1,
            nextAttemptAt: new Date(Date.now() + outboxBackoffMs(head.attempts + 1)),
            lastError: error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
          })
          .where(eq(oxyFileReferenceOutbox.id, head.id));
        break;
      }
    }
  } finally {
    await finishJob('outbox', 0, { sent, failed });
  }
  return { sent, failed };
}

/** Every use of one entity type, streamed in pages for `references.reconcile`. */
async function* inventoryOf(
  entityType: ReferenceEntityType,
): AsyncGenerator<{ fileId: string; entityId: string }> {
  let after = '';
  for (;;) {
    const rows = await getDb()
      .select({ entityId: imageReferences.entityId, fileId: imageReferences.oxyFileId })
      .from(imageReferences)
      .where(and(eq(imageReferences.entityType, entityType), gt(imageReferences.entityId, after)))
      .orderBy(asc(imageReferences.entityId))
      .limit(1000);
    for (const row of rows) yield row;
    if (rows.length < 1000) return;
    after = rows[rows.length - 1].entityId;
  }
}

/**
 * Reconcile each entity type whose turn has come (D6): Oxy adds the uses it
 * is missing and removes the ones Clarity no longer lists — never one made
 * after the reconciliation began. Run by the worker; returns what each did.
 */
export async function reconcileDueReferences(
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<Record<string, unknown>> {
  const outcome: Record<string, unknown> = {};
  for (const entityType of REFERENCE_ENTITY_TYPES) {
    const job = `reconcile:${entityType}`;
    if (options.force) {
      await getDb()
        .insert(oxyFileJobs)
        .values({ name: job })
        .onConflictDoUpdate({ target: oxyFileJobs.name, set: { nextRunAt: new Date(0) } });
    }
    if (!(await leaseJob(job))) continue;
    try {
      const result = await oxyFiles().references.reconcile(entityType, inventoryOf(entityType), {
        dryRun: options.dryRun === true,
      });
      outcome[entityType] = result;
      await finishJob(job, RECONCILE_INTERVAL_MS, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      outcome[entityType] = { error: message };
      // Tried again in an hour, not a day: a failed safety net is not a run.
      await finishJob(job, 60 * 60 * 1000, { error: message });
    }
  }
  return outcome;
}
