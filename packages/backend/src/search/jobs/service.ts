/**
 * Clarity Jobs search.
 *
 * ## Ranking contract
 *
 * Organic position is produced from exactly {@link JOB_RANKING_SIGNALS} and
 * nothing else. Structured filters are CONSTRAINTS evaluated before ranking;
 * they narrow the candidate set and never boost a listing inside it.
 *
 * No commercial state — what an employer paid, a subscription tier, ad spend,
 * a licensing tier, Mercaria activity, Mention engagement — is reachable from
 * this module. It queries the job projection, the document corpus and the
 * chunk index; it holds no reference to billing, plan, subscription or credit
 * state, and `src/search/jobs/__tests__/ranking-contract.test.ts` fails the
 * build if one is introduced. There is no `pay more → rank higher` path.
 *
 * Searching does not identify the person searching: no route into this module
 * carries a user identity, and nothing here is written per viewer.
 */
import { eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type {
  JobEmploymentType, JobLifecycleStatus, JobLocation, JobPosting, JobSalaryInterval,
  JobSearchResponse, JobSearchResult, JobSource, JobSourceType, JobWorkplaceType,
} from '@clarity/shared-types';

import { getDb } from '../../db/index.js';
import { jobClusters, jobPostings, searchChunks, searchDocuments } from '../../db/schema/index.js';
import { createOxyEmbeddings } from '../../lib/oxy-embeddings.js';
import { canonicalizePublicUrl, decodeSearchCursor, encodeSearchCursor, escapeLike, excerpt } from '../query-primitives.js';
import { activeJobPredicate } from './lifecycle.js';
import {
  JOB_EMPLOYMENT_TYPES, JOB_LIFECYCLE_STATUSES, JOB_SALARY_INTERVALS, JOB_WORKPLACE_TYPES,
  annualizeSalary, normalizeCountry, resolveRegion,
} from './taxonomy.js';

export { JOB_FORBIDDEN_RANKING_SIGNALS, JOB_RANKING_SIGNALS } from './ranking-contract.js';

const RECIPROCAL_RANK_CONSTANT = 60;
const CANDIDATE_DEPTH = 200;
/** Relevance dominates; freshness and completeness only break near-ties. */
const FRESHNESS_WEIGHT = 0.004;
const COMPLETENESS_WEIGHT = 0.002;
const FRESHNESS_DECAY_DAYS = 30;
/** Weights for the filter-only browse ordering, where there is no query. */
const BROWSE_FRESHNESS_WEIGHT = 0.7;
const BROWSE_COMPLETENESS_WEIGHT = 0.3;

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const jobSearchSchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  mode: z.enum(['lexical', 'semantic', 'hybrid']).default('hybrid'),
  locations: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  workplaceTypes: z.array(z.enum(JOB_WORKPLACE_TYPES)).max(JOB_WORKPLACE_TYPES.length).optional(),
  employmentTypes: z.array(z.enum(JOB_EMPLOYMENT_TYPES)).max(JOB_EMPLOYMENT_TYPES.length).optional(),
  employers: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  sourceDomains: z.array(z.string().trim().max(253).regex(domainPattern)).max(20).optional(),
  skills: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  salary: z.object({
    min: z.number().min(0).max(100_000_000).optional(),
    max: z.number().min(0).max(100_000_000).optional(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
    interval: z.enum(JOB_SALARY_INTERVALS).default('year'),
  }).optional(),
  publishedAfter: z.coerce.date().optional(),
  publishedBefore: z.coerce.date().optional(),
  statuses: z.array(z.enum(JOB_LIFECYCLE_STATUSES)).min(1).max(JOB_LIFECYCLE_STATUSES.length).optional(),
  includeDuplicates: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type JobSearchInput = z.infer<typeof jobSearchSchema>;

export class JobsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'JobsError';
  }
}

type JobRow = typeof jobPostings.$inferSelect;

function likePattern(value: string): string {
  return `%${escapeLike(value.toLowerCase())}%`;
}

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

/** Structured constraints. These narrow candidates; they never add score. */
function filterClauses(input: JobSearchInput): SQL[] {
  const filters: SQL[] = [
    sql`exists (select 1 from ${searchDocuments} where ${searchDocuments.id} = ${jobPostings.documentId} and ${searchDocuments.status} = 'indexed' and ${searchDocuments.noindex} = false)`,
  ];

  const statuses: JobLifecycleStatus[] = input.statuses ?? ['active'];
  const statusClauses: SQL[] = [];
  if (statuses.includes('active')) statusClauses.push(activeJobPredicate());
  const explicit = statuses.filter((status) => status !== 'active');
  if (explicit.length > 0) {
    statusClauses.push(sql`${jobPostings.status} in (${sql.join(explicit.map((status) => sql`${status}`), sql`, `)})`);
  }
  filters.push(sql`(${sql.join(statusClauses, sql` or `)})`);

  if (input.locations?.length) {
    const clauses = input.locations.map((token) => {
      const codes = new Set<string>(resolveRegion(token) ?? []);
      const country = normalizeCountry(token);
      if (country) codes.add(country);
      const pattern = likePattern(token);
      const parts: SQL[] = [];
      if (codes.size > 0) parts.push(sql`${jobPostings.locationCountries} && ${textArray([...codes])}`);
      parts.push(sql`exists (select 1 from unnest(${jobPostings.locationLocalities}) as value where lower(value) like ${pattern} escape '\\')`);
      parts.push(sql`exists (select 1 from unnest(${jobPostings.locationRegions}) as value where lower(value) like ${pattern} escape '\\')`);
      parts.push(sql`exists (select 1 from unnest(${jobPostings.applicantLocationRequirements}) as value where lower(value) like ${pattern} escape '\\')`);
      return sql`(${sql.join(parts, sql` or `)})`;
    });
    filters.push(sql`(${sql.join(clauses, sql` or `)})`);
  }

  if (input.workplaceTypes?.length) {
    filters.push(sql`${jobPostings.workplaceType} in (${sql.join(input.workplaceTypes.map((type) => sql`${type}`), sql`, `)})`);
  }
  if (input.employmentTypes?.length) {
    filters.push(sql`${jobPostings.employmentTypes} && ${textArray(input.employmentTypes)}`);
  }
  if (input.employers?.length) {
    const values = input.employers.map((employer) => employer.toLowerCase());
    filters.push(sql`(lower(${jobPostings.employerName}) = any(${textArray(values)}) or ${jobPostings.employerDomain} = any(${textArray(values)}))`);
  }
  if (input.sourceDomains?.length) {
    const clauses = input.sourceDomains.map((domain) => {
      const host = domain.toLowerCase();
      return sql`(${jobPostings.sourceDomain} = ${host} or ${jobPostings.sourceDomain} like ${`%.${escapeLike(host)}`} escape '\\')`;
    });
    filters.push(sql`(${sql.join(clauses, sql` or `)})`);
  }
  if (input.skills?.length) {
    const values = input.skills.map((skill) => skill.toLowerCase());
    filters.push(sql`exists (select 1 from unnest(${jobPostings.skills}) as value where lower(value) = any(${textArray(values)}))`);
  }
  if (input.salary) {
    const interval: JobSalaryInterval = input.salary.interval;
    if (input.salary.min !== undefined) {
      filters.push(sql`coalesce(${jobPostings.salaryAnnualMax}, ${jobPostings.salaryAnnualMin}) >= ${annualizeSalary(input.salary.min, interval)}`);
    }
    if (input.salary.max !== undefined) {
      filters.push(sql`coalesce(${jobPostings.salaryAnnualMin}, ${jobPostings.salaryAnnualMax}) <= ${annualizeSalary(input.salary.max, interval)}`);
    }
    if (input.salary.currency) filters.push(sql`${jobPostings.salaryCurrency} = ${input.salary.currency.toUpperCase()}`);
  }
  // Timestamps are bound as ISO text with an explicit cast: a raw `sql` param
  // carries no column type, so a Date would reach the driver unmapped.
  if (input.publishedAfter) filters.push(sql`${jobPostings.publishedAt} >= ${input.publishedAfter.toISOString()}::timestamptz`);
  if (input.publishedBefore) filters.push(sql`${jobPostings.publishedAt} <= ${input.publishedBefore.toISOString()}::timestamptz`);

  return filters;
}

/** Recency of the listing itself, decaying smoothly. */
function freshnessExpression(): SQL {
  return sql`exp(- greatest(extract(epoch from (now() - coalesce(${jobPostings.publishedAt}, ${jobPostings.firstSeenAt}))) / 86400.0, 0) / ${sql.raw(FRESHNESS_DECAY_DAYS.toFixed(1))})`;
}

/** How much of the employment record the source actually stated. */
function completenessExpression(): SQL {
  return sql`((case when ${jobPostings.description} is not null and length(${jobPostings.description}) > 200 then 1 else 0 end)
    + (case when ${jobPostings.salaryCurrency} is not null then 1 else 0 end)
    + (case when ${jobPostings.employerUrl} is not null then 1 else 0 end)
    + (case when array_length(${jobPostings.locationCountries}, 1) is not null then 1 else 0 end)
    + (case when array_length(${jobPostings.employmentTypes}, 1) is not null then 1 else 0 end)
    + (case when array_length(${jobPostings.skills}, 1) is not null then 1 else 0 end))::float / 6.0`;
}

function rankedStatement(input: JobSearchInput, embedding: number[] | undefined, offset: number): SQL {
  const where = sql.join(filterClauses(input), sql` and `);
  const scored = input.query
    ? scoredWithQuery(input, embedding, where, input.query)
    : sql`
      select ${jobPostings.id} as job_id, ${jobPostings.clusterId} as cluster_id,
        ${jobClusters.canonicalJobPostingId} as canonical_job_posting_id,
        ${sql.raw(String(BROWSE_FRESHNESS_WEIGHT))} * ${freshnessExpression()}
          + ${sql.raw(String(BROWSE_COMPLETENESS_WEIGHT))} * ${completenessExpression()} as score
      from ${jobPostings} left join ${jobClusters} on ${jobClusters.id} = ${jobPostings.clusterId}
      where ${where}
      order by score desc, ${jobPostings.id}
      limit ${CANDIDATE_DEPTH}`;

  const selection = input.includeDuplicates
    ? sql`select job_id as "jobId", score from scored order by score desc, job_id`
    : sql`
      select job_id as "jobId", score from (
        select job_id, score, row_number() over (
          partition by coalesce(cluster_id, job_id)
          order by (case when job_id = canonical_job_posting_id then 0 else 1 end), score desc, job_id
        ) as member_rank
        from scored
      ) as grouped
      where member_rank = 1
      order by score desc, job_id`;

  return sql`with scored as (${scored}) ${selection} limit ${input.limit + 1} offset ${offset}`;
}

function scoredWithQuery(input: JobSearchInput, embedding: number[] | undefined, where: SQL, query: string): SQL {
  const lexical = sql`
    select ${jobPostings.id} as job_id, row_number() over (
      order by ts_rank_cd(${jobPostings.searchVector}, websearch_to_tsquery('simple', ${query}))
        + greatest(similarity(${jobPostings.title}, ${query}), similarity(${jobPostings.employerName}, ${query})) desc,
        ${jobPostings.id}
    ) as rank
    from ${jobPostings}
    where ${where} and (
      ${jobPostings.searchVector} @@ websearch_to_tsquery('simple', ${query})
      or ${jobPostings.title} % ${query}
      or ${jobPostings.employerName} % ${query}
    )
    order by rank limit ${CANDIDATE_DEPTH}`;

  const semantic = embedding ? sql`
    select ${jobPostings.id} as job_id, row_number() over (
      order by min(${searchChunks.embedding} <=> ${JSON.stringify(embedding)}::vector) asc, ${jobPostings.id}
    ) as rank
    from ${jobPostings}
    inner join ${searchChunks} on ${searchChunks.documentId} = ${jobPostings.documentId}
    where ${where} and ${searchChunks.embedding} is not null
    group by ${jobPostings.id}
    order by rank limit ${CANDIDATE_DEPTH}` : undefined;

  const constant = sql.raw(String(RECIPROCAL_RANK_CONSTANT));
  const fused = input.mode === 'hybrid' && semantic ? sql`
    with lexical as (${lexical}), semantic as (${semantic})
    select coalesce(lexical.job_id, semantic.job_id) as job_id,
      coalesce(1.0 / (${constant} + lexical.rank), 0) + coalesce(1.0 / (${constant} + semantic.rank), 0) as relevance
    from lexical full outer join semantic on lexical.job_id = semantic.job_id`
    : input.mode === 'semantic' && semantic ? sql`
    with semantic as (${semantic})
    select job_id, 1.0 / (${constant} + rank) as relevance from semantic`
    : sql`
    with lexical as (${lexical})
    select job_id, 1.0 / (${constant} + rank) as relevance from lexical`;

  return sql`
    select relevant.job_id as job_id, ${jobPostings.clusterId} as cluster_id,
      ${jobClusters.canonicalJobPostingId} as canonical_job_posting_id,
      relevant.relevance
        + ${sql.raw(String(FRESHNESS_WEIGHT))} * ${freshnessExpression()}
        + ${sql.raw(String(COMPLETENESS_WEIGHT))} * ${completenessExpression()} as score
    from (${fused}) as relevant
    inner join ${jobPostings} on ${jobPostings.id} = relevant.job_id
    left join ${jobClusters} on ${jobClusters.id} = ${jobPostings.clusterId}`;
}

/** Takes input already validated by {@link jobSearchSchema}. */
export async function searchJobs(input: JobSearchInput): Promise<JobSearchResponse> {
  const offset = decodeSearchCursor(input.cursor);
  if (offset === undefined) throw new JobsError(400, 'invalid_cursor', 'The search cursor is invalid');

  let embedding: number[] | undefined;
  let degraded: JobSearchResponse['degraded'];
  if (input.query && input.mode !== 'lexical') {
    try {
      [embedding] = await createOxyEmbeddings([input.query]);
    } catch {
      if (input.mode === 'semantic') throw new JobsError(503, 'semantic_unavailable', 'Semantic job search is temporarily unavailable');
      degraded = { from: 'hybrid', to: 'lexical', reason: 'embedding_route_unavailable' };
    }
  }

  const ranks = await getDb().execute<{ jobId: string; score: number }>(rankedStatement(input, embedding, offset));
  const page = ranks.slice(0, input.limit);
  const jobsById = await hydrate(page.map((row) => row.jobId));
  const data: JobSearchResult[] = page.flatMap((rank) => {
    const job = jobsById.get(rank.jobId);
    return job ? [{ ...job, snippet: excerpt(job.description), score: Number(rank.score) }] : [];
  });

  return {
    data,
    mode: input.query ? input.mode : 'lexical',
    ...(degraded ? { degraded } : {}),
    ...(ranks.length > input.limit ? { nextCursor: encodeSearchCursor(offset + input.limit) } : {}),
  };
}

export async function getJobPostingById(id: string): Promise<JobPosting | undefined> {
  const jobs = await hydrate([id]);
  return jobs.get(id);
}

/** Resolves a listing by its canonical page or its apply URL. */
export async function getJobPostingByUrl(url: string): Promise<JobPosting | undefined> {
  let canonical: string;
  try {
    canonical = canonicalizePublicUrl(url);
  } catch {
    throw new JobsError(400, 'invalid_request', 'url must be a public HTTP(S) URL');
  }
  const [row] = await getDb().select({ id: jobPostings.id }).from(jobPostings)
    .where(or(eq(jobPostings.canonicalUrl, canonical), eq(jobPostings.applyUrl, canonical)))
    .orderBy(jobPostings.firstSeenAt)
    .limit(1);
  if (!row) return undefined;
  const jobs = await hydrate([row.id]);
  return jobs.get(row.id);
}

/** Loads full listings plus every sibling source in their duplicate group. */
async function hydrate(ids: readonly string[]): Promise<Map<string, JobPosting>> {
  if (ids.length === 0) return new Map();
  const database = getDb();
  const rows = await database.select().from(jobPostings).where(inArray(jobPostings.id, [...ids]));
  const clusterIds = [...new Set(rows.flatMap((row) => row.clusterId ? [row.clusterId] : []))];
  const siblings = clusterIds.length > 0
    ? await database.select().from(jobPostings).where(inArray(jobPostings.clusterId, clusterIds))
    : [];
  return new Map(rows.map((row) => [row.id, serializeJobPosting(row, siblings)]));
}

function jobSource(row: JobRow): JobSource {
  return {
    type: row.sourceType as JobSourceType,
    domain: row.sourceDomain,
    canonicalUrl: row.canonicalUrl,
    ...(row.applyUrl ? { applyUrl: row.applyUrl } : {}),
    documentId: row.documentId,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    status: row.status as JobLifecycleStatus,
  };
}

export function serializeJobPosting(row: JobRow, clusterMembers: readonly JobRow[] = []): JobPosting {
  return {
    id: row.id,
    documentId: row.documentId,
    canonicalUrl: row.canonicalUrl,
    ...(row.applyUrl ? { applyUrl: row.applyUrl } : {}),
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    employer: {
      name: row.employerName,
      ...(row.employerUrl ? { url: row.employerUrl } : {}),
      ...(row.employerDomain ? { domain: row.employerDomain } : {}),
      ...(row.employerLogoUrl ? { logoUrl: row.employerLogoUrl } : {}),
    },
    locations: (row.locations as JobLocation[]) ?? [],
    applicantLocationRequirements: row.applicantLocationRequirements,
    ...(row.workplaceType ? { workplaceType: row.workplaceType as JobWorkplaceType } : {}),
    employmentTypes: row.employmentTypes as JobEmploymentType[],
    ...(row.salaryCurrency && row.salaryInterval ? {
      salary: {
        ...(row.salaryMin === null ? {} : { min: row.salaryMin }),
        ...(row.salaryMax === null ? {} : { max: row.salaryMax }),
        currency: row.salaryCurrency,
        interval: row.salaryInterval as JobSalaryInterval,
      },
    } : {}),
    skills: row.skills,
    ...(row.qualifications ? { qualifications: row.qualifications } : {}),
    ...(row.responsibilities ? { responsibilities: row.responsibilities } : {}),
    ...(row.educationRequirements ? { educationRequirements: row.educationRequirements } : {}),
    ...(row.experienceRequirements ? { experienceRequirements: row.experienceRequirements } : {}),
    ...(row.industry ? { industry: row.industry } : {}),
    ...(row.occupationalCategory ? { occupationalCategory: row.occupationalCategory } : {}),
    ...(row.identifier ? { identifier: row.identifier } : {}),
    ...(row.directApply === null ? {} : { directApply: row.directApply }),
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    ...(row.validThrough ? { validThrough: row.validThrough.toISOString() } : {}),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    status: row.status as JobLifecycleStatus,
    source: jobSource(row),
    otherSources: clusterMembers
      .filter((member) => member.id !== row.id && member.clusterId === row.clusterId && row.clusterId !== null)
      .map(jobSource),
    evidence: (row.fieldEvidence as JobPosting['evidence']) ?? {},
  };
}

export interface JobCorpusStats {
  active: number;
  byStatus: Record<string, number>;
  bySourceType: Record<string, number>;
  withSalary: number;
  grouped: number;
  clusters: number;
}

/**
 * Aggregate corpus health. Operational counters only — nothing here is per
 * viewer, and no query is attributable to a person.
 */
export async function jobCorpusStats(): Promise<JobCorpusStats> {
  const database = getDb();
  const [totals] = await database.execute<{
    active: number; withSalary: number; grouped: number;
  }>(sql`
    select
      count(*) filter (where ${activeJobPredicate()})::int as "active",
      count(*) filter (where ${jobPostings.salaryCurrency} is not null)::int as "withSalary",
      count(*) filter (where ${jobPostings.clusterId} is not null)::int as "grouped"
    from ${jobPostings}`);
  const statuses = await database.execute<{ key: string; total: number }>(sql`
    select ${jobPostings.status} as key, count(*)::int as total from ${jobPostings} group by ${jobPostings.status}`);
  const sourceTypes = await database.execute<{ key: string; total: number }>(sql`
    select ${jobPostings.sourceType} as key, count(*)::int as total from ${jobPostings} group by ${jobPostings.sourceType}`);
  const [clusters] = await database.execute<{ total: number }>(sql`select count(*)::int as total from ${jobClusters}`);
  return {
    active: totals?.active ?? 0,
    byStatus: Object.fromEntries(statuses.map((row) => [row.key, row.total])),
    bySourceType: Object.fromEntries(sourceTypes.map((row) => [row.key, row.total])),
    withSalary: totals?.withSalary ?? 0,
    grouped: totals?.grouped ?? 0,
    clusters: clusters?.total ?? 0,
  };
}
