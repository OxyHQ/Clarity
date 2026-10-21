import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from './src/db/index.js';
import { searchDocuments, jobPostings } from './src/db/schema/index.js';
import { activeJobPredicate } from './src/search/jobs/lifecycle.js';
import { rankEveryMatch, rankLexically } from './src/search/jobs/lexical-ranking.js';

connectPostgres(process.env.DATABASE_URL);
const where = sql.join(
  [
    sql`exists (select 1 from ${searchDocuments} where ${searchDocuments.id} = ${jobPostings.documentId} and ${searchDocuments.status} = 'indexed' and ${searchDocuments.noindex} = false)`,
    sql`(${activeJobPredicate()})`,
  ],
  sql` and `,
);
const QUERIES = (process.env.QUERIES ?? '').split('|').filter(Boolean);
const timed = async <T>(work: () => Promise<T>) => {
  const started = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - started) };
};
for (const query of QUERIES) {
  const fastCold = await timed(() => getDb().transaction((tx) => rankLexically(tx, where, query, 200)));
  const fastWarm = await timed(() => getDb().transaction((tx) => rankLexically(tx, where, query, 200)));
  const every = await timed(() => getDb().transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    return rankEveryMatch(tx, where, query, 200);
  }));
  const fast = fastCold.value.ids;
  const old = every.value;
  const top20 = old.slice(0, 20).filter((id, i) => fast[i] === id).length;
  const set200 = new Set(fast);
  console.log(JSON.stringify({
    query, plan: fastCold.value.plan, fastColdMs: fastCold.ms, fastWarmMs: fastWarm.ms, everyMatchMs: every.ms,
    identicalOrder: JSON.stringify(fast) === JSON.stringify(old),
    top20SamePosition: top20, top200Overlap: old.filter((id) => set200.has(id)).length, returned: fast.length,
  }));
}
await closePostgres();
