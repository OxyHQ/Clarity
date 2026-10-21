import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from './src/db/index.js';
import { searchDocuments, jobPostings } from './src/db/schema/index.js';
import { activeJobPredicate } from './src/search/jobs/lifecycle.js';
connectPostgres(process.env.DATABASE_URL);
const where = sql.join([
  sql`exists (select 1 from ${searchDocuments} where ${searchDocuments.id} = ${jobPostings.documentId} and ${searchDocuments.status} = 'indexed' and ${searchDocuments.noindex} = false)`,
  sql`(${activeJobPredicate()})`], sql` and `);
const q = process.env.Q ?? 'nurse';
for (let run = 0; run < 2; run += 1) {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`set local work_mem = '256MB'`);
    let t = performance.now();
    const lap = (label: string, extra = '') => { const now = performance.now(); console.log(run, label, Math.round(now - t), 'ms', extra); t = now; };
    const band = await tx.execute<{ id: string }>(sql`select job_posting_id as id from clarity_job_term_bands where tf6 @@ ${`'${q}'`}::tsquery`);
    lap('band6', String(band.length));
    await tx.execute(sql`select set_config('pg_trgm.similarity_threshold', '0.7', true)`);
    const sim = await tx.execute<{ id: string }>(sql`select job_posting_id as id from clarity_job_headlines where title % ${q} union select job_posting_id as id from clarity_job_headlines where employer_name % ${q}`);
    lap('sim0.7', String(sim.length));
    await tx.execute(sql`select set_config('pg_trgm.similarity_threshold', '0.3', true)`);
    const ids = [...new Set([...band, ...sim].map((r) => r.id))];
    const ranked = await tx.execute(sql`select id, ts_rank_cd(search_vector, websearch_to_tsquery('simple', ${q})) + greatest(similarity(title, ${q}), similarity(employer_name, ${q})) as score from clarity_job_postings where id = any(${sql.param(ids)}::text[]) and ${where} and (search_vector @@ websearch_to_tsquery('simple', ${q}) or title % ${q}) order by score desc, id limit 200`);
    lap('score', `${ids.length} candidates -> ${ranked.length}`);
    const plan = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (analyze, buffers) select id, ts_rank_cd(search_vector, websearch_to_tsquery('simple', ${q})) + greatest(similarity(title, ${q}), similarity(employer_name, ${q})) as score from clarity_job_postings where id = any(${sql.param(ids)}::text[]) and ${where} and (search_vector @@ websearch_to_tsquery('simple', ${q}) or title % ${q}) order by score desc, id limit 200`);
    if (run === 1) console.log(plan.map((r) => r['QUERY PLAN']).filter((l) => /Execution|->|Scan|Buffers/.test(l)).slice(0, 14).join('\n'));
  });
}
await closePostgres();
