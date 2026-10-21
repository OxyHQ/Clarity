/**
 * The lexical arm of job search, ranked exactly as it always was —
 * `ts_rank_cd(search_vector, q) + greatest(similarity(title, q),
 * similarity(employer_name, q))`, ties by id — without reading every match.
 *
 * Measured in production (2026-10-21): "engineer" matched 111k listings and
 * scoring them all, each reading its 4.3 KB vector, took 30-65 s, past the
 * search's 10 s timeout, so every broad job query failed.
 *
 * ## Two phases, exact
 *
 * `ts_rank_cd` gives at most 0.1 per cover of the query, and a listing whose
 * query terms each occur fewer than B times scores at most 0.1 · n · (B − 1)
 * on them (n terms; for a query of AND and phrases, a listing missing any one
 * term from band B is bounded so; otherwise one missing all of them). Its
 * similarity is below S when its title and employer are not S-similar to the
 * query. So for a band B and threshold S:
 *
 *   1. candidates: the listings in band B (`clarity_job_term_bands`) and the
 *      ones whose title or employer is S-similar (`clarity_job_headlines`) —
 *      both read from indexes over short rows;
 *   2. the candidates that match are scored exactly;
 *   3. if the `depth`-th scores above 0.1 · n · (B − 1) + S, no listing left
 *      out can reach the top `depth`: they ARE the top `depth`.
 *
 * Otherwise the next, looser step is tried, and past the last one (or before
 * the bands are complete) every match is scored, as before.
 */
import { type SQL, sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../../db/index.js';

/** (band, similarity threshold), from the fewest candidates to the most. */
const STEPS: ReadonlyArray<readonly [3 | 6 | 12 | 24, number]> = [
  [24, 0.7],
  [12, 0.7],
  [6, 0.7],
  [6, 0.5],
  [3, 0.5],
  [3, 0.3],
];
/** Past this many candidates, two phases read about as much as one. */
const MAX_CANDIDATES = 20_000;
/** `ts_rank_cd` and `similarity` are float4: the bound keeps their rounding. */
const SCORE_EPSILON = 1e-4;
/** `work_mem` for scoring every match: a lossy bitmap rechecks — and detoasts — every row of a page. */
const SCORING_WORK_MEM = '256MB';

export interface QueryTerms {
  lexemes: string[];
  /** Only AND and phrases: a listing must hold every term. */
  conjunctive: boolean;
}

const QUOTED = /'((?:[^'\\]|''|\\.)*)'/g;

/** A `tsquery`'s distinct lexemes, as Postgres prints them, and whether it is conjunctive. */
export function queryTerms(tsquery: string): QueryTerms {
  const lexemes = new Set<string>();
  for (const match of tsquery.matchAll(QUOTED)) lexemes.add(match[1]);
  const operators = tsquery.replace(QUOTED, '');
  return { lexemes: [...lexemes], conjunctive: !/[|!]/.test(operators) };
}

/** The band query: every term (conjunctive) or any term, in `tsquery` syntax. */
export function bandQuery(terms: QueryTerms): string {
  return terms.lexemes.map((lexeme) => `'${lexeme}'`).join(terms.conjunctive ? ' & ' : ' | ');
}

/** What no listing outside the candidates of `band` and `similarity` can score. */
export function excludedBound(terms: QueryTerms, band: number, similarity: number): number {
  return 0.1 * terms.lexemes.length * (band - 1) + similarity;
}

function lexicalScore(query: string): SQL {
  return sql`ts_rank_cd(search_vector, websearch_to_tsquery('simple', ${query}))
    + greatest(similarity(title, ${query}), similarity(employer_name, ${query}))`;
}

function lexicalMatch(query: string): SQL {
  return sql`(search_vector @@ websearch_to_tsquery('simple', ${query}) or title % ${query})`;
}

export interface LexicalRanking {
  ids: string[];
  /** The step that proved the ranking, or `full` when every match was scored. */
  plan: string;
}

/** Every match scored: the ranking as it always was, and the fallback. */
export async function rankEveryMatch(
  tx: ClarityExecutor,
  where: SQL,
  query: string,
  depth: number,
): Promise<string[]> {
  await tx.execute(sql.raw(`set local work_mem = '${SCORING_WORK_MEM}'`));
  const rows = await tx.execute<{ id: string }>(sql`
    select id from clarity_job_postings
    where ${where} and ${lexicalMatch(query)}
    order by ${lexicalScore(query)} desc, id
    limit ${depth}`);
  return rows.map((row) => row.id);
}

async function bandsComplete(tx: ClarityExecutor): Promise<boolean> {
  const [row] = await tx.execute<{ complete: boolean }>(
    sql`select exists (select 1 from clarity_job_term_bands_backfill where id = 1) as complete`,
  );
  return Boolean(row?.complete);
}

/** The listings whose title or employer is at least `threshold`-similar to the query. */
async function similarCandidates(
  tx: ClarityExecutor,
  query: string,
  threshold: number,
): Promise<string[]> {
  const [current] = await tx.execute<{ value: string }>(
    sql`select current_setting('pg_trgm.similarity_threshold') as value`,
  );
  await tx.execute(
    sql`select set_config('pg_trgm.similarity_threshold', ${String(threshold)}, true)`,
  );
  try {
    // Short rows: the recheck of every index hit reads a title, not a listing.
    const rows = await tx.execute<{ id: string }>(sql`
      select job_posting_id as id from clarity_job_headlines where title % ${query}
      union
      select job_posting_id as id from clarity_job_headlines where employer_name % ${query}`);
    return rows.map((row) => row.id);
  } finally {
    await tx.execute(
      sql`select set_config('pg_trgm.similarity_threshold', ${current?.value ?? '0.3'}, true)`,
    );
  }
}

/** The top `depth` lexical matches, in rank order. */
export async function rankLexically(
  tx: ClarityExecutor,
  where: SQL,
  query: string,
  depth: number,
): Promise<LexicalRanking> {
  await tx.execute(sql.raw(`set local work_mem = '${SCORING_WORK_MEM}'`));
  const [parsed] = await tx.execute<{ tsquery: string }>(
    sql`select websearch_to_tsquery('simple', ${query})::text as tsquery`,
  );
  const terms = queryTerms(parsed?.tsquery ?? '');
  if (terms.lexemes.length === 0 || !(await bandsComplete(tx))) {
    return { ids: await rankEveryMatch(tx, where, query, depth), plan: 'full' };
  }

  for (const [band, similarity] of STEPS) {
    const banded = await tx.execute<{ id: string }>(sql`
      select job_posting_id as id from clarity_job_term_bands
      where ${sql.identifier(`tf${band}`)} @@ ${bandQuery(terms)}::tsquery`);
    const candidates = new Set(banded.map((row) => row.id));
    if (candidates.size > MAX_CANDIDATES) break;
    for (const id of await similarCandidates(tx, query, similarity)) candidates.add(id);
    if (candidates.size > MAX_CANDIDATES) break;
    if (candidates.size < depth) continue;

    const ranked = await tx.execute<{ id: string; score: number }>(sql`
      select id, ${lexicalScore(query)} as score from clarity_job_postings
      where id = any(${sql.param([...candidates])}::text[]) and ${where} and ${lexicalMatch(query)}
      order by score desc, id
      limit ${depth}`);
    const last = ranked[depth - 1];
    if (last && Number(last.score) > excludedBound(terms, band, similarity) + SCORE_EPSILON) {
      return { ids: ranked.map((row) => row.id), plan: `band${band}-sim${similarity}` };
    }
  }
  return { ids: await rankEveryMatch(tx, where, query, depth), plan: 'full' };
}
