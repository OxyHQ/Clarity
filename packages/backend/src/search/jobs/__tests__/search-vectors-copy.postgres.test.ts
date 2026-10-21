import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import { jobPostings, searchDocuments } from '../../../db/schema/index.js';
import { copyJobSearchVectors } from '../search-vectors-copy.js';

/**
 * The listings' vectors in their inline table (migration 0054): the trigger
 * mirrors every vector written, the one-shot copies what predates it, and the
 * copy is recorded only when every listing has its vector.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
let documentId = '';

/** Each test listing's vector beside the one its inline row holds. */
async function vectors(): Promise<{ id: string; listing: string; copy: string | null }[]> {
  return getDb().execute(sql`
    select p.id, p.search_vector::text as listing, v.search_vector::text as copy
    from clarity_job_postings p
    left join clarity_job_search_vectors v on v.job_posting_id = p.id
    where p.document_id = ${documentId}
    order by p.id`);
}

suite('listing vectors in their inline table on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const url = `https://search-vectors.example/${run}`;
    const [document] = await getDb()
      .insert(searchDocuments)
      .values({
        id: crypto.randomUUID(),
        requestedUrl: url,
        canonicalUrl: url,
        status: 'indexed',
        documentType: 'job',
      })
      .returning();
    documentId = document.id;
    for (const index of [0, 1, 2]) {
      await getDb().execute(sql`
        insert into clarity_job_postings
          (id, document_id, source_key, canonical_url, title, normalized_title, employer_name, source_domain, search_vector)
        values (${crypto.randomUUID()}, ${documentId}, ${`k${index}`}, ${`${url}/${index}`},
          'Welder', 'welder', 'Acme', 'search-vectors.example',
          to_tsvector('simple', ${`welder ${run} ${'steel '.repeat(index + 1)}`}))`);
    }
  });

  afterAll(async () => {
    await getDb().delete(jobPostings).where(eq(jobPostings.documentId, documentId));
    await getDb().delete(searchDocuments).where(eq(searchDocuments.id, documentId));
    await closePostgres();
  });

  it('mirrors every vector written, and stores it inline', async () => {
    let rows = await vectors();
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.copy === row.listing)).toBe(true);

    await getDb().execute(sql`
      update clarity_job_postings set search_vector = to_tsvector('simple', 'pipefitter')
      where id = ${rows[0].id}`);
    rows = await vectors();
    expect(rows[0].copy).toBe("'pipefitter':1");

    const [storage] = await getDb().execute<{ storage: string }>(sql`
      select attstorage as storage from pg_attribute
      where attrelid = 'clarity_job_search_vectors'::regclass and attname = 'search_vector'`);
    expect(storage?.storage).toBe('m');
  });

  it('copies the vectors that predate the trigger, records the copy and indexes it', async () => {
    const before = await vectors();
    await getDb().execute(sql`
      delete from clarity_job_search_vectors where job_posting_id in
        (select id from clarity_job_postings where document_id = ${documentId})`);
    expect((await vectors()).every((row) => row.copy === null)).toBe(true);

    const events: string[] = [];
    const result = await copyJobSearchVectors(getDb(), {
      batchSize: 2,
      dutyCycle: 1,
      log: (event) => events.push(event),
    });
    expect(events).toEqual(expect.arrayContaining(['counted', 'indexed', 'recorded']));
    expect(result.listings).toBeGreaterThanOrEqual(3);
    expect(await vectors()).toEqual(before);

    const [marker] = await getDb().execute<{ rows: string }>(
      sql`select rows from clarity_job_search_vectors_copy where id = 1`,
    );
    expect(Number(marker?.rows)).toBe(result.listings);
    const [index] = await getDb().execute<{ valid: boolean }>(sql`
      select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = 'clarity_job_search_vectors_search_idx'`);
    expect(index?.valid).toBe(true);
  });

  it('removes a vector with its listing', async () => {
    const [first] = await vectors();
    await getDb().delete(jobPostings).where(eq(jobPostings.id, first.id));
    const [left] = await getDb().execute<{ n: string }>(sql`
      select count(*) as n from clarity_job_search_vectors where job_posting_id = ${first.id}`);
    expect(Number(left?.n)).toBe(0);
  });
});
