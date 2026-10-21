import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../../db/index.js';
import { jobPostings, searchDocuments } from '../../../db/schema/index.js';
import { backfillJobTermBands } from '../term-bands-backfill.js';
import {
  bandQuery,
  excludedBound,
  queryTerms,
  rankEveryMatch,
  rankLexically,
} from '../lexical-ranking.js';

/**
 * The two-phase lexical ranking must return exactly what scoring every match
 * returns — the ranking job search always had — whatever the query's shape.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const run = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const word = (index: number) => `w${run}x${index}`;
const employers = ['Acme Robotics', `${word(1)} Labs`, 'Northwind', `${word(4)} ${word(5)} Group`];
let documentId = '';

/** A deterministic generator, so a failure reproduces. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

suite('two-phase lexical job ranking on Postgres', () => {
  beforeAll(async () => {
    connectPostgres(databaseUrl);
    const url = `https://lexical-ranking.example/${run}`;
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
    const random = generator(7);
    const rows = Array.from({ length: 400 }, (_, index) => {
      const words: string[] = [];
      for (let term = 0; term < 6; term += 1) {
        // Heavy-tailed term frequencies, 0 to ~40.
        const frequency = Math.floor(random() ** 3 * 40);
        for (let i = 0; i < frequency; i += 1) words.push(word(term));
      }
      for (let i = 0; i < 60; i += 1) words.push(`filler${Math.floor(random() * 50)}`);
      for (let i = words.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [words[i], words[j]] = [words[j], words[i]];
      }
      const title = [
        word(Math.floor(random() * 6)),
        random() < 0.5 ? word(Math.floor(random() * 6)) : 'Engineer',
      ]
        .slice(0, 1 + Math.floor(random() * 2))
        .join(' ');
      const employer = employers[Math.floor(random() * employers.length)];
      return { index, title, employer, text: words.join(' ') };
    });
    for (const row of rows) {
      const id = crypto.randomUUID();
      await getDb().execute(sql`
        insert into clarity_job_postings
          (id, document_id, source_key, canonical_url, title, normalized_title, employer_name, source_domain)
        values (${id}, ${documentId}, ${`k${row.index}`}, ${`${url}/${row.index}`},
          ${row.title}, ${row.title.toLowerCase()}, ${row.employer}, 'lexical-ranking.example')`);
      await getDb().execute(sql`
        insert into clarity_job_search_vectors (job_posting_id, search_vector)
        values (${id}, to_tsvector('simple', ${`${row.title}\n${row.employer}\n${row.text}`}))`);
    }
  });

  afterAll(async () => {
    await getDb().delete(jobPostings).where(eq(jobPostings.documentId, documentId));
    await getDb().delete(searchDocuments).where(eq(searchDocuments.id, documentId));
    await closePostgres();
  });

  it('reads a query as its terms and its shape', () => {
    const terms = queryTerms("'a' <-> 'b' & 'c'");
    expect(terms).toEqual({ lexemes: ['a', 'b', 'c'], conjunctive: true });
    expect(bandQuery(terms)).toBe("'a' & 'b' & 'c'");
    expect(queryTerms("'a' & !'b' | 'c'").conjunctive).toBe(false);
    expect(queryTerms("'o''neil'").lexemes).toEqual(["o''neil"]);
    expect(excludedBound(terms, 6, 0.5)).toBeCloseTo(0.1 * 3 * 5 + 0.5);
  });

  it('ranks every query shape exactly as scoring every match does', async () => {
    const queries = [
      word(0),
      word(3),
      `${word(0)} ${word(1)}`,
      `${word(2)} or ${word(5)}`,
      `"${word(0)} ${word(1)}"`,
      `${word(0)} -${word(3)}`,
      `${word(2)} ${word(3)} ${word(4)}`,
      `${word(1)} Engineer`,
      `${word(4)} ${word(5)} Group`,
      'Acme Robotics',
    ];
    const where = {
      listing: sql`clarity_job_postings.document_id = ${documentId}`,
      document: sql`clarity_search_documents.status = 'indexed' and clarity_search_documents.noindex = false`,
    };
    const plans: string[] = [];
    for (const depth of [5, 20, 50]) {
      for (const query of queries) {
        await getDb().transaction(async (tx) => {
          const every = await rankEveryMatch(tx, where, query, depth);
          // Every match scored whole: what a query with few matches gets.
          const small = await rankLexically(tx, where, query, depth);
          expect(small.ids, `${query} @ ${depth} (${small.plan})`).toEqual(every);
          expect(small.plan).toBe('small');
          // Few nearest headlines and no small-match shortcut, so the bound —
          // not reading every headline — decides.
          const fast = await rankLexically(tx, where, query, depth, {
            nearest: [20, 80],
            smallMatch: 0,
          });
          expect(fast.ids, `${query} @ ${depth} (${fast.plan})`).toEqual(every);
          plans.push(fast.plan);
        });
      }
    }
    // The bound proves most of them without scoring every match.
    expect(plans.filter((plan) => plan !== 'full').length).toBeGreaterThan(plans.length / 2);
  });

  it('keeps the bands equal to each listing as it is written', async () => {
    const [listing] = await getDb()
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(eq(jobPostings.documentId, documentId))
      .limit(1);
    await getDb().execute(sql`
      update clarity_job_search_vectors set
        search_vector = to_tsvector('simple', ${`${word(0)} `.repeat(30)})
      where job_posting_id = ${listing.id}`);
    await getDb().execute(sql`
      update clarity_job_postings set title = 'Renamed', employer_name = 'Renamed Co'
      where id = ${listing.id}`);
    const [bands] = await getDb().execute<{ tf24: string; title: string; employer: string }>(sql`
      select b.tf24::text as tf24, h.title, h.employer_name as employer
      from clarity_job_term_bands b join clarity_job_headlines h using (job_posting_id)
      where b.job_posting_id = ${listing.id}`);
    expect(bands).toEqual({ tf24: `'${word(0)}'`, title: 'Renamed', employer: 'Renamed Co' });
  });

  it('backfills the bands and headlines a listing lacks, and records it', async () => {
    const before = await getDb().execute<{ id: string; tf6: string }>(sql`
      select job_posting_id as id, tf6::text as tf6 from clarity_job_term_bands
      where job_posting_id in (select id from clarity_job_postings where document_id = ${documentId})
      order by 1`);
    await getDb().execute(sql`
      delete from clarity_job_term_bands where job_posting_id in
        (select id from clarity_job_postings where document_id = ${documentId})`);
    await getDb().execute(sql`
      delete from clarity_job_headlines where job_posting_id in
        (select id from clarity_job_postings where document_id = ${documentId})`);
    const result = await backfillJobTermBands(getDb(), {
      batchSize: 100,
      dutyCycle: 1,
      log: () => {},
    });
    expect(result.listings).toBeGreaterThanOrEqual(400);
    const after = await getDb().execute<{ id: string; tf6: string }>(sql`
      select job_posting_id as id, tf6::text as tf6 from clarity_job_term_bands
      where job_posting_id in (select id from clarity_job_postings where document_id = ${documentId})
      order by 1`);
    expect(after).toEqual(before);
    const [marker] = await getDb().execute<{ n: string }>(
      sql`select count(*) as n from clarity_job_term_bands_backfill`,
    );
    expect(Number(marker.n)).toBe(1);
  });

  it('ranks on a connection that has not loaded pg_trgm yet', async () => {
    // pg_trgm defines `similarity_threshold` only once it loads in a session:
    // reading it on a fresh connection used to fail the whole search.
    const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      const fresh = drizzle(client);
      const [setting] = await fresh.execute<{ value: string | null }>(
        sql`select current_setting('pg_trgm.similarity_threshold', true) as value`,
      );
      expect(setting.value ?? null).toBeNull();
      const where = {
        listing: sql`clarity_job_postings.document_id = ${documentId}`,
        document: sql`clarity_search_documents.status = 'indexed' and clarity_search_documents.noindex = false`,
      };
      const ranked = await fresh.transaction((tx) => rankLexically(tx as never, where, word(0), 5));
      const every = await getDb().transaction((tx) => rankEveryMatch(tx, where, word(0), 5));
      expect(ranked.ids).toEqual(every);
    } finally {
      await client.end();
    }
  });
});
