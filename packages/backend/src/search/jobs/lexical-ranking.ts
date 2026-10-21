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
 * term from band B is bounded so; otherwise one missing all of them). So:
 *
 *   1. candidates: the listings in band B (`clarity_job_term_bands`), and the
 *      M titles and M employers nearest the query (`clarity_job_headlines`,
 *      an ordered GiST scan) — every listing left out is less similar than
 *      S, the similarity of the M-th;
 *   2. the candidates that match are scored exactly;
 *   3. if the `depth`-th scores above 0.1 · n · (B − 1) + S, no listing left
 *      out can reach the top `depth`: they ARE the top `depth`.
 *
 * Otherwise a lower band, then more similar headlines, are tried; past the
 * last (or before the bands are complete) every match is scored, as before.
 * A broad query of several words is usually decided by its titles (exact
 * "Software Engineer" titles are its top 200), a broad single word by how
 * often it occurs: the nearest headlines bound the first, the bands the
 * second.
 */
import { type SQL, sql } from 'drizzle-orm';

import type { ClarityExecutor } from '../../db/index.js';

/** Bands to try, from the fewest candidates to the most. */
const BANDS = [24, 12, 6, 3] as const;
/** Nearest headlines read, and then read again, when a band alone does not prove the ranking. */
const NEAREST = [2_000, 8_000] as const;
/** Past this many candidates, two phases read about as much as one. */
const MAX_CANDIDATES = 25_000;
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

/** What no listing outside the candidates of `band` and similarity `similarity` can score. */
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

/**
 * Every match scored: the ranking as it always was, and the fallback. The
 * title arm of the match is read from the short headline rows, so its
 * trigram recheck reads titles, not listings.
 */
export async function rankEveryMatch(
  tx: ClarityExecutor,
  where: SQL,
  query: string,
  depth: number,
): Promise<string[]> {
  await tx.execute(sql.raw(`set local work_mem = '${SCORING_WORK_MEM}'`));
  const rows = await tx.execute<{ id: string }>(sql`
    select id from clarity_job_postings
    where ${where} and (
      search_vector @@ websearch_to_tsquery('simple', ${query})
      or id in (select job_posting_id from clarity_job_headlines where title % ${query})
    )
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

/**
 * The `count` titles and `count` employers nearest the query, in exact order
 * (GiST `<->` is 1 − `similarity`), and the similarity no headline left out
 * can exceed: the `count`-th's, or 0 when every headline was read.
 */
async function nearestHeadlines(
  tx: ClarityExecutor,
  query: string,
  count: number,
): Promise<{ ids: string[]; bound: number }> {
  const nearest = async (column: 'title' | 'employer_name') => {
    const rows = await tx.execute<{ id: string; similarity: number }>(sql`
      select job_posting_id as id, similarity(${sql.identifier(column)}, ${query}) as similarity
      from clarity_job_headlines
      order by ${sql.identifier(column)} <-> ${query}
      limit ${count}`);
    const bound = rows.length < count ? 0 : Number(rows[rows.length - 1]?.similarity ?? 0);
    return { ids: rows.map((row) => row.id), bound };
  };
  const titles = await nearest('title');
  const employers = await nearest('employer_name');
  return { ids: [...titles.ids, ...employers.ids], bound: Math.max(titles.bound, employers.bound) };
}

/** The top `depth` lexical matches, in rank order. `nearest` is a test seam. */
export async function rankLexically(
  tx: ClarityExecutor,
  where: SQL,
  query: string,
  depth: number,
  { nearest = NEAREST }: { nearest?: readonly number[] } = {},
): Promise<LexicalRanking> {
  await tx.execute(sql.raw(`set local work_mem = '${SCORING_WORK_MEM}'`));
  const [parsed] = await tx.execute<{ tsquery: string }>(
    sql`select websearch_to_tsquery('simple', ${query})::text as tsquery`,
  );
  const terms = queryTerms(parsed?.tsquery ?? '');
  if (terms.lexemes.length === 0 || !(await bandsComplete(tx))) {
    return { ids: await rankEveryMatch(tx, where, query, depth), plan: 'full' };
  }

  const banded = new Map<number, string[]>();
  for (const count of nearest) {
    const similar = await nearestHeadlines(tx, query, count);
    for (const band of BANDS) {
      if (!banded.has(band)) {
        const rows = await tx.execute<{ id: string }>(sql`
          select job_posting_id as id from clarity_job_term_bands
          where ${sql.identifier(`tf${band}`)} @@ ${bandQuery(terms)}::tsquery`);
        banded.set(
          band,
          rows.map((row) => row.id),
        );
      }
      const candidates = new Set([...(banded.get(band) ?? []), ...similar.ids]);
      if (candidates.size > MAX_CANDIDATES) break;
      const bound = excludedBound(terms, band, similar.bound);
      const ranked = await tx.execute<{ id: string; score: number }>(sql`
        select id, ${lexicalScore(query)} as score from clarity_job_postings
        where id = any(${sql.param([...candidates])}::text[]) and ${where} and ${lexicalMatch(query)}
        order by score desc, id
        limit ${depth}`);
      const last = ranked[depth - 1];
      if (last && Number(last.score) > bound + SCORE_EPSILON) {
        return { ids: ranked.map((row) => row.id), plan: `band${band}-nearest${count}` };
      }
    }
  }
  return { ids: await rankEveryMatch(tx, where, query, depth), plan: 'full' };
}
