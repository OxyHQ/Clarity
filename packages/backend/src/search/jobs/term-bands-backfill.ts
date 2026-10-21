/**
 * Fills `clarity_job_term_bands` and `clarity_job_headlines` for the listings
 * that predate their triggers (migration 0046), then records the backfill,
 * which the two-phase lexical ranking requires (lexical-ranking.ts).
 *
 * `ON CONFLICT DO NOTHING`: a row already there was written by the trigger
 * from the listing as it is now, and a listing changed while a batch read it
 * is rewritten by its trigger after — either way the newer row wins.
 * Idempotent and paced; run once after the deploy that carries 0046:
 *
 *   bun packages/backend/dist/db/backfill-job-term-bands.js --target-database=clarity
 */
import { sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../../db/index.js';

export async function backfillJobTermBandsBatch(
  db: ClarityExecutor,
  after: string | null,
  limit: number,
): Promise<{ last: string | null; read: number }> {
  const [row] = await db.execute<{ last: string | null; read: string }>(sql`
    with batch as (
      select id, search_vector, title, employer_name from clarity_job_postings
      where ${after === null ? sql`true` : sql`id > ${after}`}
      order by id
      limit ${limit}
    ), bands as (
      insert into clarity_job_term_bands (job_posting_id, tf3, tf6, tf12, tf24)
      select id, clarity_job_term_band(search_vector, 3), clarity_job_term_band(search_vector, 6),
        clarity_job_term_band(search_vector, 12), clarity_job_term_band(search_vector, 24)
      from batch
      on conflict (job_posting_id) do nothing
      returning 1
    ), headlines as (
      insert into clarity_job_headlines (job_posting_id, title, employer_name)
      select id, coalesce(title, ''), coalesce(employer_name, '') from batch
      on conflict (job_posting_id) do nothing
      returning 1
    )
    select (select max(id) from batch) as last, (select count(*) from batch) as read`);
  return { last: row?.last ?? null, read: Number(row?.read ?? 0) };
}

export async function countJobTermBands(
  db: ClarityExecutor,
): Promise<{ listings: number; bands: number; headlines: number }> {
  const [row] = await db.execute<{ listings: string; bands: string; headlines: string }>(sql`
    select (select count(*) from clarity_job_postings) as listings,
      (select count(*) from clarity_job_term_bands) as bands,
      (select count(*) from clarity_job_headlines) as headlines`);
  return {
    listings: Number(row?.listings ?? 0),
    bands: Number(row?.bands ?? 0),
    headlines: Number(row?.headlines ?? 0),
  };
}

export interface TermBandsBackfillOptions {
  batchSize: number;
  dutyCycle: number;
  log: (event: string, fields: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function backfillJobTermBands(
  db: ClarityExecutor,
  options: TermBandsBackfillOptions,
): Promise<{ read: number; listings: number }> {
  let after: string | null = null;
  let read = 0;
  for (let batches = 1; ; batches += 1) {
    const started = Date.now();
    const batch = await backfillJobTermBandsBatch(db, after, options.batchSize);
    read += batch.read;
    if (batches % 100 === 0) options.log('progress', { read, last: batch.last });
    if (batch.read < options.batchSize || batch.last === null) break;
    after = batch.last;
    const took = Date.now() - started;
    const rest = (took * (1 - options.dutyCycle)) / options.dutyCycle;
    if (rest > 0) await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(rest);
  }
  // Every listing in one snapshot: the triggers write their rows in the
  // listing's own transaction, so the three counts agree once the backfill is
  // complete.
  const counts = await countJobTermBands(db);
  if (counts.bands !== counts.listings || counts.headlines !== counts.listings) {
    throw new Error(
      `${counts.listings} listings, ${counts.bands} bands, ${counts.headlines} headlines: not recorded. Run again.`,
    );
  }
  await db.execute(sql`
    insert into clarity_job_term_bands_backfill (id) values (1) on conflict (id) do nothing`);
  options.log('recorded', counts);
  return { read, listings: counts.listings };
}
