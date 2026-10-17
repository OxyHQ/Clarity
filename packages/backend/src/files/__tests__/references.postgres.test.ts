import { eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@oxy.so/core/server', () => ({ safeFetch: vi.fn() }));

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import {
  imageCache,
  imageReferences,
  jobPostings,
  oxyFileJobs,
  oxyFileReferenceOutbox,
  searchDocuments,
  searchHosts,
} from '../../db/schema/index.js';
import { setOxyFilesForTesting } from '../oxy-files.js';
import {
  IMAGE_IDLE_TTL_MS,
  drainReferenceOutbox,
  forgetOxyFile,
  reassertUses,
  reconcileDueReferences,
  releaseIdleReferences,
  setOxyFileBlocked,
} from '../references.js';
import { FakeOxyFiles, oxyError } from './fake-oxy-files.js';

/**
 * Clarity's reference inventory against real Postgres: every change reaches
 * the outbox in the same transaction (including the ones a document's or a
 * job's own change causes, cascades included), the outbox reaches Oxy in order,
 * the 30-day "last used" rule releases what nobody is shown, and the nightly
 * reconciliation sends the whole inventory.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const DOC = 'rft-doc';
const JOB = 'rft-job';
const KEY = 'rft-key';

async function outbox() {
  return getDb()
    .select({
      op: oxyFileReferenceOutbox.op,
      file: oxyFileReferenceOutbox.oxyFileId,
      entity: oxyFileReferenceOutbox.entityId,
    })
    .from(oxyFileReferenceOutbox)
    .where(like(oxyFileReferenceOutbox.entityId, 'rft-%'))
    .orderBy(oxyFileReferenceOutbox.id);
}

async function cleanup(): Promise<void> {
  await getDb().delete(searchDocuments).where(like(searchDocuments.id, 'rft-%'));
  await getDb().delete(imageReferences).where(like(imageReferences.entityId, 'rft-%'));
  await getDb().delete(imageCache).where(like(imageCache.key, 'rft-%'));
  await getDb().delete(searchHosts).where(like(searchHosts.host, 'rft-%'));
  await getDb().delete(oxyFileReferenceOutbox);
  await getDb().delete(oxyFileJobs);
}

async function seedEntities(): Promise<void> {
  await getDb().insert(searchDocuments).values({
    id: DOC,
    requestedUrl: 'https://rft.example/a',
    canonicalUrl: 'https://rft.example/a',
    imageUrl: 'https://rft.example/a.png',
  });
  await getDb().execute(sql`
    insert into clarity_job_postings
      (id, document_id, source_key, canonical_url, title, normalized_title, employer_name,
       employer_logo_url, source_domain, search_vector)
    values (${JOB}, ${DOC}, 'k', 'https://rft.example/a', 'Engineer', 'engineer', 'Rft',
            'https://rft.example/logo.png', 'rft.example', to_tsvector('simple', 'engineer'))`);
  await getDb()
    .insert(imageCache)
    .values({ key: KEY, sourceUrl: 'https://rft.example/a.png', status: 'ready', oxyFileId: 'f1' });
}

suite('Clarity file references on Postgres', () => {
  let oxy: FakeOxyFiles;

  beforeAll(async () => {
    connectPostgres(databaseUrl);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    setOxyFilesForTesting(undefined);
    await closePostgres();
  });

  beforeEach(async () => {
    oxy = new FakeOxyFiles();
    setOxyFilesForTesting(oxy);
    await seedEntities();
  });

  afterEach(cleanup);

  it('owes Oxy every change to the inventory, in the transaction that made it', async () => {
    await getDb()
      .insert(imageReferences)
      .values([
        { entityType: 'search_document', entityId: DOC, oxyFileId: 'f1', imageKey: KEY },
        { entityType: 'job_posting', entityId: JOB, oxyFileId: 'f1', imageKey: KEY },
      ]);
    await getDb()
      .update(imageReferences)
      .set({ oxyFileId: 'f2' })
      .where(eq(imageReferences.entityId, JOB));
    await getDb().delete(imageReferences).where(eq(imageReferences.entityId, JOB));

    expect(await outbox()).toEqual([
      { op: 'add', file: 'f1', entity: DOC },
      { op: 'add', file: 'f1', entity: JOB },
      { op: 'remove', file: 'f1', entity: JOB },
      { op: 'add', file: 'f2', entity: JOB },
      { op: 'remove', file: 'f2', entity: JOB },
    ]);
  });

  it('releases a use when its entity stops showing the image or is deleted', async () => {
    await getDb()
      .insert(imageReferences)
      .values([
        { entityType: 'search_document', entityId: DOC, oxyFileId: 'f1', imageKey: KEY },
        { entityType: 'job_posting', entityId: JOB, oxyFileId: 'f1', imageKey: KEY },
      ]);

    // Re-writing the same URL is not a change.
    await getDb()
      .update(searchDocuments)
      .set({ imageUrl: 'https://rft.example/a.png' })
      .where(eq(searchDocuments.id, DOC));
    expect(
      await getDb().select().from(imageReferences).where(eq(imageReferences.entityId, DOC)),
    ).toHaveLength(1);

    await getDb()
      .update(searchDocuments)
      .set({ imageUrl: 'https://rft.example/b.png' })
      .where(eq(searchDocuments.id, DOC));
    // Deleting the document cascades to its job posting, whose use goes too.
    await getDb().delete(searchDocuments).where(eq(searchDocuments.id, DOC));

    const left = await getDb()
      .select()
      .from(imageReferences)
      .where(inArray(imageReferences.entityId, [DOC, JOB]));
    expect(left).toEqual([]);
    const removals = (await outbox()).filter((row) => row.op === 'remove');
    expect(removals.map((row) => row.entity).sort()).toEqual([DOC, JOB]);
  });

  it('drains the outbox to Oxy in order, and backs the head off when Oxy is down', async () => {
    oxy.files.set('f1', {
      ...(await oxy.uploadAppFile(Buffer.from('one'), 'image/png')).file,
      id: 'f1',
      bytes: Buffer.from('one'),
    });
    await getDb()
      .insert(imageReferences)
      .values({ entityType: 'search_document', entityId: DOC, oxyFileId: 'f1', imageKey: KEY });
    await getDb().delete(imageReferences).where(eq(imageReferences.entityId, DOC));
    await getDb()
      .insert(imageReferences)
      .values({ entityType: 'search_document', entityId: DOC, oxyFileId: 'f1', imageKey: KEY });

    oxy.down = oxyError(503, 'SERVICE_UNAVAILABLE');
    expect(await drainReferenceOutbox()).toEqual({ sent: 0, failed: true });
    const [head] = await getDb()
      .select()
      .from(oxyFileReferenceOutbox)
      .orderBy(oxyFileReferenceOutbox.id)
      .limit(1);
    expect(head.attempts).toBe(1);
    expect(head.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    oxy.down = undefined;
    // Not before its back-off.
    expect((await drainReferenceOutbox()).sent).toBe(0);
    await getDb()
      .update(oxyFileReferenceOutbox)
      .set({ nextAttemptAt: new Date(0) });
    expect(await drainReferenceOutbox()).toEqual({ sent: 3, failed: false });
    expect(oxy.calls.filter((call) => !call.startsWith('upload'))).toEqual([
      `add:search_document/${DOC}`,
      `remove:search_document/${DOC}`,
      `add:search_document/${DOC}`,
    ]);
    expect(oxy.referencesOf('search_document', DOC)).toEqual(['f1']);
    expect(await outbox()).toEqual([]);
  });

  it('forgets a file Oxy refuses to be referenced, so the image is imported again', async () => {
    await getDb()
      .insert(imageReferences)
      .values({ entityType: 'search_document', entityId: DOC, oxyFileId: 'f1', imageKey: KEY });

    await drainReferenceOutbox();

    expect(await getDb().select().from(imageCache).where(eq(imageCache.key, KEY))).toEqual([]);
    expect(
      await getDb().select().from(imageReferences).where(eq(imageReferences.entityId, DOC)),
    ).toEqual([]);
  });

  it('releases only the uses nobody was shown for 30 days', async () => {
    const now = Date.now();
    await getDb()
      .insert(imageReferences)
      .values([
        {
          entityType: 'search_document',
          entityId: DOC,
          oxyFileId: 'f1',
          imageKey: KEY,
          lastUsedAt: new Date(now - IMAGE_IDLE_TTL_MS - 1000),
        },
        { entityType: 'job_posting', entityId: JOB, oxyFileId: 'f1', imageKey: KEY },
      ]);

    expect(await releaseIdleReferences(now)).toBeGreaterThanOrEqual(1);

    const left = await getDb()
      .select({ id: imageReferences.entityId })
      .from(imageReferences)
      .where(inArray(imageReferences.entityId, [DOC, JOB]));
    expect(left).toEqual([{ id: JOB }]);
    expect((await outbox()).at(-1)).toEqual({ op: 'remove', file: 'f1', entity: DOC });
  });

  it('reconciles the whole inventory of each entity type, once a day', async () => {
    oxy.files.set('f1', {
      ...(await oxy.uploadAppFile(Buffer.from('one'), 'image/png')).file,
      id: 'f1',
      bytes: Buffer.from('one'),
    });
    await getDb()
      .insert(imageReferences)
      .values({ entityType: 'search_document', entityId: DOC, oxyFileId: 'f1', imageKey: KEY });
    oxy.refs.add('f1|search_document|rft-stale');

    const first = await reconcileDueReferences();
    expect(first.search_document).toMatchObject({ added: 1, removed: 1 });
    expect(oxy.referencesOf('search_document', DOC)).toEqual(['f1']);
    expect(oxy.referencesOf('search_document', 'rft-stale')).toEqual([]);

    // Not due again until tomorrow.
    expect(await reconcileDueReferences()).toEqual({});
  });

  it('previews a reconciliation without changing references or the schedule', async () => {
    oxy.files.set('f1', {
      ...(await oxy.uploadAppFile(Buffer.from('one'), 'image/png')).file,
      id: 'f1',
      bytes: Buffer.from('one'),
    });
    await getDb()
      .insert(imageReferences)
      .values({ entityType: 'search_document', entityId: DOC, oxyFileId: 'f1', imageKey: KEY });
    oxy.refs.add('f1|search_document|rft-stale');

    const preview = await reconcileDueReferences({ dryRun: true });
    expect(preview.search_document).toMatchObject({ dryRun: true, added: 1, removed: 1 });
    expect(oxy.referencesOf('search_document', DOC)).toEqual([]);
    expect(oxy.referencesOf('search_document', 'rft-stale')).toEqual(['f1']);
    // A preview is not a run: nothing scheduled, so the real one is still due now.
    expect(await getDb().select().from(oxyFileJobs)).toEqual([]);
    expect(await reconcileDueReferences()).toMatchObject({
      search_document: { added: 1, removed: 1 },
    });
    expect(oxy.referencesOf('search_document', DOC)).toEqual(['f1']);
  });

  it('runs every entity type now when forced, even before its turn', async () => {
    expect(Object.keys(await reconcileDueReferences())).toHaveLength(3);
    expect(await reconcileDueReferences()).toEqual({});
    expect(Object.keys(await reconcileDueReferences({ force: true }))).toEqual([
      'search_document',
      'job_posting',
      'search_host',
    ]);
  });

  it('hides a blocked file, shows it again, and re-sends the uses of a trashed one', async () => {
    await getDb().insert(searchHosts).values({
      host: 'rft-host.example',
      iconStatus: 'ready',
      iconContentType: 'image/png',
      iconOxyFileId: 'f1',
    });
    await getDb()
      .insert(imageReferences)
      .values({ entityType: 'search_document', entityId: DOC, oxyFileId: 'f1', imageKey: KEY });

    await setOxyFileBlocked(getDb(), 'f1', true);
    const [cache] = await getDb().select().from(imageCache).where(eq(imageCache.key, KEY));
    const [host] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'rft-host.example'));
    expect([cache.status, host.iconStatus]).toEqual(['blocked', 'blocked']);

    await setOxyFileBlocked(getDb(), 'f1', false);
    const [shown] = await getDb().select().from(imageCache).where(eq(imageCache.key, KEY));
    expect(shown.status).toBe('ready');

    await getDb().delete(oxyFileReferenceOutbox);
    expect(await reassertUses(getDb(), 'f1')).toBe(1);
    expect(await outbox()).toEqual([{ op: 'add', file: 'f1', entity: DOC }]);

    await forgetOxyFile(getDb(), 'f1');
    const [forgotten] = await getDb()
      .select()
      .from(searchHosts)
      .where(eq(searchHosts.host, 'rft-host.example'));
    expect(forgotten).toMatchObject({ iconOxyFileId: null, iconStatus: 'pending' });
    expect(await getDb().select().from(jobPostings).where(eq(jobPostings.id, JOB))).toHaveLength(1);
  });
});
