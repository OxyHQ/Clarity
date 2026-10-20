/**
 * Search Clarity's index, and read one of its documents — the use cases behind
 * `POST /v1/search`, `GET /v1/documents/*` and the capability catalogue's
 * `search`, `getDocument` and `getDocumentByUrl` tools. One implementation, so
 * a tool answers exactly what the route answers.
 *
 * Quotas are not here: they meter a credentialed caller (`search/quotas.ts`)
 * and the route charges them before it calls in.
 */
import { eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../db/index.js';
import {
  searchChunkHalfvec,
  searchChunks,
  searchChunkTsvector,
  searchDocuments,
} from '../db/schema/index.js';
import { embedQuery } from './chunking.js';
import {
  iconHostsOf,
  publicDocument,
  searchResult,
  searchResultColumns,
  type DocumentCardRow,
} from './public-document.js';
import {
  canonicalizePublicUrl,
  decodeSearchCursor,
  encodeSearchCursor,
  escapeLike,
} from './query-primitives.js';
import { discoverWeb, recordDiscoveredPages } from './web-discovery.js';

export const DOCUMENT_TYPES = [
  'page',
  'article',
  'news',
  'job',
  'product',
  'video',
  'event',
  'recipe',
  'profile',
  'documentation',
  'other',
] as const;

export const SEARCH_MODES = ['lexical', 'semantic', 'hybrid'] as const;

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: z.enum(SEARCH_MODES).default('hybrid'),
  types: z.array(z.enum(DOCUMENT_TYPES)).max(DOCUMENT_TYPES.length).optional(),
  domains: z
    .array(
      z
        .string()
        .trim()
        .max(253)
        .regex(
          /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
        ),
    )
    .max(50)
    .optional(),
  language: z.string().max(35).optional(),
  publishedAfter: z.coerce.date().optional(),
  publishedBefore: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type SearchInput = z.infer<typeof searchSchema>;

/** A search refused for a reason its caller can act on; `status` is the HTTP answer. */
export class SearchError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'semantic_unavailable' | 'invalid_cursor' | 'search_timeout',
    message: string,
  ) {
    super(message);
  }
}

/**
 * How long a search waits for its query embedding. The embedding call's own
 * default (30 s) is sized for indexing; a search that has not got one by now
 * ranks lexically and says so (`degraded`), as it does when the route fails.
 */
export const QUERY_EMBEDDING_TIMEOUT_MS = 2_500;

export async function searchIndex(input: SearchInput) {
  let queryEmbedding: number[] | undefined;
  let degraded:
    | { from: 'hybrid'; to: 'lexical'; reason: 'embedding_route_unavailable' }
    | undefined;
  if (input.mode !== 'lexical') {
    queryEmbedding = await embedQuery(input.query, AbortSignal.timeout(QUERY_EMBEDDING_TIMEOUT_MS));
    if (!queryEmbedding) {
      if (input.mode === 'semantic') {
        throw new SearchError(
          503,
          'semantic_unavailable',
          'Semantic search is temporarily unavailable',
        );
      }
      degraded = { from: 'hybrid', to: 'lexical', reason: 'embedding_route_unavailable' };
    }
  }
  const offset = decodeSearchCursor(input.cursor);
  if (offset === undefined) {
    throw new SearchError(400, 'invalid_cursor', 'The search cursor is invalid');
  }
  const ranks = await rankedSearch(input, queryEmbedding, offset);
  const ids = ranks.slice(0, input.limit).map((row) => row.documentId);
  const documents = ids.length
    ? await getDb()
        .select(searchResultColumns)
        .from(searchDocuments)
        .where(inArray(searchDocuments.id, ids))
    : [];
  const documentsById = new Map(documents.map((row) => [row.id, row]));
  const data: { row: DocumentCardRow; score: number }[] = ranks
    .slice(0, input.limit)
    .flatMap((rank) => {
      const row = documentsById.get(rank.documentId);
      return row ? [{ row, score: Number(rank.score) }] : [];
    });
  // What the index could not fill on the first page, the public web does. Not
  // for a type or date filter: a search engine's snippet can honour neither.
  const discoverable =
    offset === 0 &&
    data.length < input.limit &&
    !input.types?.length &&
    !input.publishedAfter &&
    !input.publishedBefore;
  if (discoverable) {
    const seen = new Set(data.map((result) => result.row.canonicalUrl));
    const pages = await discoverWeb({
      query: input.query,
      language: input.language,
      domains: input.domains,
      limit: input.limit,
    });
    const discovered = await recordDiscoveredPages(
      getDb(),
      pages.filter((page) => !seen.has(page.canonicalUrl)),
    );
    // Below every indexed match: the index read the page, the engines did not.
    data.push(...discovered.slice(0, input.limit - data.length).map((row) => ({ row, score: 0 })));
  }
  const icons = await iconHostsOf(data.map((result) => result.row));
  return {
    data: data.map((result) => searchResult(result.row, result.score, icons)),
    mode: input.mode,
    ...(degraded ? { degraded } : {}),
    ...(ranks.length > input.limit ? { nextCursor: encodeSearchCursor(offset + input.limit) } : {}),
  };
}

/**
 * How many nearest CHUNKS the semantic arm reads from the HNSW index before it
 * groups them into documents and applies the document filters. Ordering the
 * chunks by distance and limiting is the only shape the index serves: the
 * earlier `min(embedding <=> q)` grouped by document compared the query with
 * every embedded chunk (549k in production, 2026-10-17) and ran past two
 * minutes, so every hybrid search outlived its callers. A filter is applied
 * after the nearest chunks are found, so a filtered search reads a wider pool —
 * up to pgvector's ceiling for `hnsw.ef_search`, which bounds what the index
 * can return.
 */
const SEMANTIC_CANDIDATE_CHUNKS = 400;
const FILTERED_SEMANTIC_CANDIDATE_CHUNKS = 1_000;

/**
 * The longest a ranking may run. A caller that gives up does not stop a query
 * already in Postgres, so without this an abandoned search keeps reading the
 * index and slows the searches behind it.
 *
 * Sized from production (2026-10-17): with the shared instance's disk busy, a
 * cold hybrid ranking reads ~10k blocks at ~1.3 ms each and takes 7–10 s; warm
 * it takes milliseconds. With the query embedding (2.5 s) that answers inside
 * the SDK's 15 s whenever the index fills the page; web discovery (5 s) runs
 * only when it does not.
 */
export const SEARCH_STATEMENT_TIMEOUT_MS = 10_000;
const QUERY_CANCELED = '57014';

export function isStatementTimeout(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === QUERY_CANCELED) return true;
  }
  return false;
}

/** The ranking behind `searchIndex`; exported for its Postgres suite. */
export async function rankedSearch(
  input: SearchInput,
  embedding: number[] | undefined,
  offset: number,
) {
  const filters: SQL[] = [
    sql`${searchDocuments.status} = 'indexed'`,
    sql`${searchDocuments.noindex} = false`,
  ];
  if (input.types?.length)
    filters.push(
      sql`${searchDocuments.documentType} in (${sql.join(
        input.types.map((type) => sql`${type}`),
        sql`, `,
      )})`,
    );
  if (input.language) filters.push(sql`${searchDocuments.language} = ${input.language}`);
  // A raw `sql` parameter carries no column type, so bind timestamps as ISO
  // text with an explicit cast rather than handing the driver a Date.
  if (input.publishedAfter)
    filters.push(
      sql`${searchDocuments.publishedAt} >= ${input.publishedAfter.toISOString()}::timestamptz`,
    );
  if (input.publishedBefore)
    filters.push(
      sql`${searchDocuments.publishedAt} <= ${input.publishedBefore.toISOString()}::timestamptz`,
    );
  if (input.domains?.length) {
    const domains = input.domains.map((domain) =>
      new URL(`https://${domain}`).hostname.toLowerCase(),
    );
    filters.push(
      sql`(${sql.join(
        domains.map(
          (domain) =>
            sql`${searchDocuments.canonicalUrl} like ${`%://${escapeLike(domain)}/%`} escape '\\'`,
        ),
        sql` or `,
      )})`,
    );
  }
  const where = sql.join(filters, sql` and `);
  const filtered = Boolean(
    input.types?.length ||
      input.language ||
      input.publishedAfter ||
      input.publishedBefore ||
      input.domains?.length,
  );
  const candidateChunks = filtered ? FILTERED_SEMANTIC_CANDIDATE_CHUNKS : SEMANTIC_CANDIDATE_CHUNKS;
  // Candidates first, one indexed arm each — the chunks' full-text index and
  // the title trigram index — and only those documents are scored. Written as
  // one join filtered by an OR across both tables, no index could serve it:
  // every chunk of every document was scored, and a search took 18 s.
  //
  // The description takes no part, as an arm or in the score. Descriptions
  // average ~1.7k characters (whole listings): trigram similarity against text
  // that long matches almost every row and ranks nothing, and computing it cost
  // seconds; the text they hold is already in the chunks the full-text arm reads.
  //
  // Both rankings group by the DOCUMENT's primary key, not the chunk's foreign
  // key: the score reads the document's title and description, which Postgres
  // accepts ungrouped only when they depend on a grouped primary key.
  const tsquery = sql`websearch_to_tsquery('simple', ${input.query})`;
  const lexical = sql`
    with candidates as (
      select ${searchChunks.documentId} as id from ${searchChunks} where ${searchChunkTsvector} @@ ${tsquery}
      union
      select ${searchDocuments.id} from ${searchDocuments} where ${searchDocuments.title} % ${input.query}
    )
    select ${searchDocuments.id} as document_id,
      row_number() over (order by coalesce(max(ts_rank_cd(${searchChunkTsvector}, ${tsquery})), 0) + similarity(coalesce(${searchDocuments.title}, ''), ${input.query}) desc, ${searchDocuments.id}) as rank
    from candidates
    inner join ${searchDocuments} on ${searchDocuments.id} = candidates.id
    left join ${searchChunks} on ${searchChunks.documentId} = ${searchDocuments.id} and ${searchChunkTsvector} @@ ${tsquery}
    where ${where}
    group by ${searchDocuments.id}
    order by rank limit 100`;
  // The nearest chunks first, straight from the HNSW index (see
  // SEMANTIC_CANDIDATE_CHUNKS), then each document at its nearest chunk.
  // Half precision on both sides: `searchChunkHalfvec` is the expression the
  // HNSW index holds (schema, migration 0034), and the planner uses the index
  // only for an ORDER BY on exactly that expression.
  const queryVector = embedding ? sql`${JSON.stringify(embedding)}::halfvec(1024)` : undefined;
  const semantic = queryVector
    ? sql`
    select ${searchDocuments.id} as document_id,
      row_number() over (order by min(nearest.distance) asc, ${searchDocuments.id}) as rank
    from (
      select ${searchChunks.documentId} as document_id, ${searchChunkHalfvec} <=> ${queryVector} as distance
      from ${searchChunks}
      where ${searchChunks.embedding} is not null
      order by ${searchChunkHalfvec} <=> ${queryVector}
      limit ${candidateChunks}
    ) nearest
    inner join ${searchDocuments} on ${searchDocuments.id} = nearest.document_id
    where ${where}
    group by ${searchDocuments.id}
    order by rank limit 100`
    : undefined;
  const statement =
    input.mode === 'hybrid' && semantic
      ? sql`
    with lexical as (${lexical}), semantic as (${semantic}), fused as (
      select coalesce(lexical.document_id, semantic.document_id) as document_id,
        coalesce(1.0 / (60 + lexical.rank), 0) + coalesce(1.0 / (60 + semantic.rank), 0) as score
      from lexical full outer join semantic on lexical.document_id = semantic.document_id
    ) select document_id as "documentId", score from fused order by score desc, document_id limit ${input.limit + 1} offset ${offset}`
      : input.mode === 'semantic' && semantic
        ? sql`
    with semantic as (${semantic}) select document_id as "documentId", 1.0 / (60 + rank) as score
    from semantic order by score desc, document_id limit ${input.limit + 1} offset ${offset}`
        : sql`
    with lexical as (${lexical}) select document_id as "documentId", 1.0 / (60 + rank) as score
    from lexical order by score desc, document_id limit ${input.limit + 1} offset ${offset}`;
  try {
    return await getDb().transaction(async (tx) => {
      // `set local` takes no bind parameter; both values are this module's constants.
      await tx.execute(sql.raw(`set local statement_timeout = ${SEARCH_STATEMENT_TIMEOUT_MS}`));
      // The index returns at most `ef_search` rows, so it must cover the pool.
      if (embedding) await tx.execute(sql.raw(`set local hnsw.ef_search = ${candidateChunks}`));
      return tx.execute<{ documentId: string; score: number }>(statement);
    });
  } catch (error) {
    if (isStatementTimeout(error)) {
      throw new SearchError(
        503,
        'search_timeout',
        'Search took too long; try a more specific query',
      );
    }
    throw error;
  }
}

export type PublicDocument = ReturnType<typeof publicDocument>;

/** One indexed document by its Clarity id, as the public sees it; `undefined` when unknown. */
export async function findDocument(id: string): Promise<PublicDocument | undefined> {
  const [row] = await getDb()
    .select()
    .from(searchDocuments)
    .where(eq(searchDocuments.id, id))
    .limit(1);
  return row ? publicDocument(row, await iconHostsOf([row])) : undefined;
}

/** One indexed document by its canonical URL (any public URL that canonicalises to it). */
export async function findDocumentByUrl(url: string): Promise<PublicDocument | undefined> {
  const [row] = await getDb()
    .select()
    .from(searchDocuments)
    .where(eq(searchDocuments.canonicalUrl, canonicalizePublicUrl(url)))
    .limit(1);
  return row ? publicDocument(row, await iconHostsOf([row])) : undefined;
}
