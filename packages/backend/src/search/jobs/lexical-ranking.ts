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
 *   2. the candidates that match are scored exactly — each only when its own
 *      ceiling (the same bound, from the highest band holding it, plus its
 *      exact similarity) can still reach the `depth`-th score;
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
/**
 * Pages a bitmap scan asks the disk for ahead of reading them: the bands' and
 * the full-text index's matches are read that way. The shared instance's
 * default (1) reads one at a time: a band of 2,379 listings took 1.4 s cold;
 * at 128 one of 34,381 took 1.3 s (production, 2026-10-21).
 */
const READ_AHEAD = 128;

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
  await tx.execute(sql.raw(`set local effective_io_concurrency = ${READ_AHEAD}`));
  // The match as a union of its two indexed arms, joined by key: written as
  // one OR with a sub-select, no bitmap could serve it and the planner read
  // every listing (42 s for "react developer", production 2026-10-21).
  const rows = await tx.execute<{ id: string }>(sql`
    with matches as (
      select id from clarity_job_postings
      where search_vector @@ websearch_to_tsquery('simple', ${query})
      union
      select job_posting_id from clarity_job_headlines where title % ${query}
    )
    select clarity_job_postings.id from matches
    join clarity_job_postings on clarity_job_postings.id = matches.id
    where ${where}
    order by ${lexicalScore(query)} desc, clarity_job_postings.id
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
  return {
    ids: [...new Set([...titles.ids, ...employers.ids])],
    bound: Math.max(titles.bound, employers.bound),
  };
}

/** Candidates scored at a time, highest ceiling first. */
const SCORING_BATCH = 500;

/** The top `depth` lexical matches, in rank order. `nearest` is a test seam. */
export async function rankLexically(
  tx: ClarityExecutor,
  where: SQL,
  query: string,
  depth: number,
  { nearest = NEAREST }: { nearest?: readonly number[] } = {},
): Promise<LexicalRanking> {
  await tx.execute(sql.raw(`set local work_mem = '${SCORING_WORK_MEM}'`));
  await tx.execute(sql.raw(`set local effective_io_concurrency = ${READ_AHEAD}`));
  const [parsed] = await tx.execute<{ tsquery: string }>(
    sql`select websearch_to_tsquery('simple', ${query})::text as tsquery`,
  );
  const terms = queryTerms(parsed?.tsquery ?? '');
  if (terms.lexemes.length === 0 || !(await bandsComplete(tx))) {
    return { ids: await rankEveryMatch(tx, where, query, depth), plan: 'full' };
  }

  // Every listing scored so far: its exact score, or null when it does not
  // match or is filtered out. A score never changes within one ranking, so
  // no listing is read twice.
  const scores = new Map<string, number | null>();
  const score = async (ids: readonly string[]) => {
    const unscored = ids.filter((id) => !scores.has(id));
    if (unscored.length === 0) return;
    const rows = await tx.execute<{ id: string; score: number }>(sql`
      select id, ${lexicalScore(query)} as score from clarity_job_postings
      where id = any(${sql.param(unscored)}::text[]) and ${where} and ${lexicalMatch(query)}`);
    for (const id of unscored) scores.set(id, null);
    for (const row of rows) scores.set(row.id, Number(row.score));
  };
  const matched = () => [...scores.values()].filter((value): value is number => value !== null);
  /** The `depth`-th largest of `values`, or -Infinity while there are fewer. */
  const nth = (values: number[]) =>
    values.length < depth
      ? Number.NEGATIVE_INFINITY
      : values.sort((left, right) => right - left)[depth - 1];

  // A candidate's similarity term, read from its short headline row: what
  // its score holds besides `ts_rank_cd`.
  const similarity = new Map<string, number>();
  const readSimilarity = async (ids: readonly string[]) => {
    const missing = ids.filter((id) => !similarity.has(id) && !scores.has(id));
    if (missing.length === 0) return;
    const rows = await tx.execute<{ id: string; similarity: number }>(sql`
      select job_posting_id as id,
        greatest(similarity(title, ${query}), similarity(employer_name, ${query})) as similarity
      from clarity_job_headlines
      where job_posting_id = any(${sql.param(missing)}::text[])`);
    for (const row of rows) similarity.set(row.id, Number(row.similarity));
  };

  // The highest band read so far that holds each listing. A listing in band
  // b but not in the next band up, b', holds some term (every term, for a
  // disjunctive query) fewer than b' times, so its `ts_rank_cd` is at most
  // 0.1 · n · (b' − 1) — the bound the excluded listings get, applied to
  // each candidate. Only a listing in the top band has no such ceiling.
  const level = new Map<string, number>();
  const ceiling = (id: string, lowest: number) => {
    const held = level.get(id);
    const above =
      held === undefined ? lowest : BANDS[BANDS.indexOf(held as (typeof BANDS)[number]) - 1];
    if (above === undefined) return Number.POSITIVE_INFINITY;
    return excludedBound(terms, above, similarity.get(id) ?? 1);
  };

  const banded = new Map<number, string[]>();
  for (const count of nearest) {
    const similar = await nearestHeadlines(tx, query, count);
    for (const band of BANDS) {
      if (!banded.has(band)) {
        const rows = await tx.execute<{ id: string }>(sql`
          select job_posting_id as id from clarity_job_term_bands
          where ${sql.identifier(`tf${band}`)} @@ ${bandQuery(terms)}::tsquery`);
        const ids = rows.map((row) => row.id);
        banded.set(band, ids);
        for (const id of ids) if (!level.has(id)) level.set(id, band);
      }
      const inBand = banded.get(band) ?? [];
      if (inBand.length > MAX_CANDIDATES) break;

      // Each candidate is read only if its ceiling can still reach the
      // `depth`-th score: highest ceiling first, until none can. A band whose
      // candidates could not lift the `depth`-th score above the bound even
      // at their ceilings cannot prove the ranking: nothing is read for it.
      const bound = excludedBound(terms, band, similar.bound);
      const candidates = [...new Set([...inBand, ...similar.ids])];
      await readSimilarity(candidates);
      const pending = candidates
        .filter((id) => !scores.has(id))
        .map((id) => ({ id, ceiling: ceiling(id, band) }))
        .sort((left, right) => right.ceiling - left.ceiling);
      const reachable = nth([
        ...matched(),
        ...pending.slice(0, depth).map((entry) => entry.ceiling),
      ]);
      if (reachable <= bound + SCORE_EPSILON) continue;
      for (let start = 0; start < pending.length; start += SCORING_BATCH) {
        if (pending[start].ceiling + SCORE_EPSILON < nth(matched())) break;
        await score(pending.slice(start, start + SCORING_BATCH).map((entry) => entry.id));
      }

      if (nth(matched()) > bound + SCORE_EPSILON) {
        return { ids: await ordered(tx, scores, depth), plan: `band${band}-nearest${count}` };
      }
    }
  }
  return { ids: await rankEveryMatch(tx, where, query, depth), plan: 'full' };
}

/**
 * The top `depth` of the scored listings, ordered by Postgres exactly as the
 * single statement ordered them: score descending, ties by id in the
 * database's collation.
 */
async function ordered(
  tx: ClarityExecutor,
  scores: ReadonlyMap<string, number | null>,
  depth: number,
): Promise<string[]> {
  const matched = [...scores].filter((entry): entry is [string, number] => entry[1] !== null);
  const rows = await tx.execute<{ id: string }>(sql`
    select id from unnest(
      ${sql.param(matched.map(([id]) => id))}::text[],
      ${sql.param(matched.map(([, value]) => value))}::float8[]
    ) as scored(id, score)
    order by score desc, id
    limit ${depth}`);
  return rows.map((row) => row.id);
}
