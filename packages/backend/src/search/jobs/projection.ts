/**
 * Writes the normalized job projection for one document.
 *
 * The projection is derived state: every write is idempotent on
 * `(document_id, source_key)` and re-running a crawl converges. Listings that
 * vanish from a page are CLOSED, never deleted, so provenance and duplicate
 * grouping stay reconstructible.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';

import type { JobLocation, JobSourceType } from '@clarity/shared-types';

import { getDb, type ClarityExecutor } from '../../db/index.js';
import { jobClusters, jobPostings, jobPostingSignatures, searchDocuments } from '../../db/schema/index.js';
import { chunkText, embedChunks, replaceDocumentChunks } from '../chunking.js';
import { canonicalSourceRank, jobClusterSignatures } from './dedupe.js';
import { extractJobPostings, type ExtractedJobPosting } from './extract.js';
import { JOB_RECRAWL_INTERVAL_SECONDS, jobLifecycleStatus, type JobClosureReason } from './lifecycle.js';
import { annualizeSalary, normalizeCountry, resolveRegion, urlDomain } from './taxonomy.js';

export interface JobProjectionInput {
  documentId: string;
  documentStatus: string;
  postings: readonly ExtractedJobPosting[];
  sourceType: JobSourceType;
  submittedByApplicationId?: string;
  observedAt: Date;
}

/** Countries a listing is explicitly attached to, including remote eligibility. */
function countryCodes(posting: ExtractedJobPosting): string[] {
  const codes = new Set<string>();
  for (const location of posting.locations) if (location.countryCode) codes.add(location.countryCode);
  for (const requirement of posting.applicantLocationRequirements) {
    const country = normalizeCountry(requirement);
    if (country) { codes.add(country); continue; }
    for (const member of resolveRegion(requirement) ?? []) codes.add(member);
  }
  return [...codes];
}

function textIndexSource(posting: ExtractedJobPosting): string {
  return [
    posting.title,
    posting.employerName,
    posting.skills.join(' '),
    posting.locations.map((location: JobLocation) => location.raw).join(' '),
    posting.applicantLocationRequirements.join(' '),
    posting.employmentTypes.join(' '),
    posting.workplaceType ?? '',
    posting.occupationalCategory ?? '',
    posting.industry ?? '',
    (posting.description ?? '').slice(0, 8_000),
  ].filter(Boolean).join('\n');
}

export async function projectJobPostings(tx: ClarityExecutor, input: JobProjectionInput): Promise<string[]> {
  const sourceKeys = input.postings.map((posting) => posting.sourceKey);

  if (sourceKeys.length === 0) {
    await closeJobPostingsForDocument(tx, input.documentId, 'posting_absent');
    return [];
  }

  const ids: string[] = [];
  for (const posting of input.postings) {
    const status = jobLifecycleStatus({
      validThrough: posting.validThrough ?? null,
      lastSeenAt: input.observedAt,
      documentStatus: input.documentStatus,
    });
    const values = {
      documentId: input.documentId,
      sourceKey: posting.sourceKey,
      canonicalUrl: posting.canonicalUrl,
      applyUrl: posting.applyUrl,
      title: posting.title,
      normalizedTitle: posting.normalizedTitle,
      description: posting.description,
      descriptionFingerprint: posting.descriptionFingerprint,
      employerName: posting.employerName,
      employerUrl: posting.employerUrl,
      employerDomain: posting.employerDomain,
      employerLogoUrl: posting.employerLogoUrl,
      employerKey: posting.employerKey,
      locations: posting.locations,
      locationCountries: countryCodes(posting),
      locationRegions: [...new Set(posting.locations.flatMap((location) => location.region ? [location.region] : []))],
      locationLocalities: [...new Set(posting.locations.flatMap((location) => location.locality ? [location.locality] : []))],
      applicantLocationRequirements: posting.applicantLocationRequirements,
      workplaceType: posting.workplaceType,
      employmentTypes: posting.employmentTypes,
      salaryMin: posting.salary?.min,
      salaryMax: posting.salary?.max,
      salaryCurrency: posting.salary?.currency,
      salaryInterval: posting.salary?.interval,
      salaryAnnualMin: posting.salary?.min === undefined ? undefined : annualizeSalary(posting.salary.min, posting.salary.interval),
      salaryAnnualMax: posting.salary?.max === undefined ? undefined : annualizeSalary(posting.salary.max, posting.salary.interval),
      skills: posting.skills,
      qualifications: posting.qualifications,
      responsibilities: posting.responsibilities,
      educationRequirements: posting.educationRequirements,
      experienceRequirements: posting.experienceRequirements,
      industry: posting.industry,
      occupationalCategory: posting.occupationalCategory,
      identifier: posting.identifier,
      directApply: posting.directApply,
      publishedAt: posting.publishedAt,
      validThrough: posting.validThrough,
      status,
      closureReason: null,
      closedAt: null,
      sourceType: input.sourceType,
      sourceDomain: urlDomain(posting.canonicalUrl) ?? '',
      submittedByApplicationId: input.submittedByApplicationId,
      fieldEvidence: posting.evidence,
      searchVector: sql`to_tsvector('simple', ${textIndexSource(posting)})`,
      lastSeenAt: input.observedAt,
    };
    const [row] = await tx.insert(jobPostings)
      .values({ id: crypto.randomUUID(), firstSeenAt: input.observedAt, ...values })
      .onConflictDoUpdate({
        target: [jobPostings.documentId, jobPostings.sourceKey],
        set: { ...values, updatedAt: new Date() },
      })
      .returning({ id: jobPostings.id });
    ids.push(row.id);

    await tx.delete(jobPostingSignatures).where(eq(jobPostingSignatures.jobPostingId, row.id));
    const signatures = jobClusterSignatures(posting);
    if (signatures.length > 0) {
      await tx.insert(jobPostingSignatures)
        .values(signatures.map((signature) => ({ jobPostingId: row.id, signature: signature.value, kind: signature.kind })))
        .onConflictDoNothing();
    }
    await assignCluster(tx, row.id);
  }

  // Listings that vanished from this page were withdrawn: close them and let
  // their duplicate groups elect a copy that is still open.
  const withdrawn = await tx.update(jobPostings)
    .set({ status: 'closed', closedAt: input.observedAt, closureReason: 'posting_absent', updatedAt: new Date() })
    .where(and(
      eq(jobPostings.documentId, input.documentId),
      notInArray(jobPostings.sourceKey, sourceKeys),
      sql`${jobPostings.closedAt} is null`,
    ))
    .returning({ id: jobPostings.id });
  for (const row of withdrawn) await refreshClusterOf(tx, row.id);

  return ids;
}

/** Marks every listing on a document withdrawn without discarding its record. */
export async function closeJobPostingsForDocument(
  tx: ClarityExecutor,
  documentId: string,
  reason: JobClosureReason,
): Promise<number> {
  const closed = await tx.update(jobPostings)
    .set({ status: 'closed', closedAt: new Date(), closureReason: reason, updatedAt: new Date() })
    .where(and(eq(jobPostings.documentId, documentId), sql`${jobPostings.closedAt} is null`))
    .returning({ id: jobPostings.id });
  for (const row of closed) await refreshClusterOf(tx, row.id);
  return closed.length;
}

/**
 * Joins a listing to every cluster its signatures reach, merging those clusters
 * into one. Clusters are pure grouping metadata: no listing row is altered
 * beyond its `cluster_id`, so a wrong grouping is undone by clearing it.
 */
async function assignCluster(tx: ClarityExecutor, jobPostingId: string): Promise<void> {
  const [current] = await tx.select({ clusterId: jobPostings.clusterId }).from(jobPostings).where(eq(jobPostings.id, jobPostingId)).limit(1);
  const previousClusterId = current?.clusterId ?? null;
  const related = await tx.execute<{ id: string; clusterId: string | null }>(sql`
    select distinct other.id as id, other.cluster_id as "clusterId"
    from ${jobPostingSignatures} mine
    join ${jobPostingSignatures} theirs on theirs.signature = mine.signature
    join ${jobPostings} other on other.id = theirs.job_posting_id
    where mine.job_posting_id = ${jobPostingId}`);

  const memberIds = new Set<string>([jobPostingId, ...related.map((row) => row.id)]);
  const clusterIds = [...new Set(related.flatMap((row) => row.clusterId ? [row.clusterId] : []))].sort();

  if (memberIds.size === 1 && clusterIds.length === 0) {
    await tx.update(jobPostings).set({ clusterId: null, updatedAt: new Date() }).where(eq(jobPostings.id, jobPostingId));
    if (previousClusterId) await electCanonical(tx, previousClusterId);
    return;
  }

  let clusterId = clusterIds[0];
  if (!clusterId) {
    clusterId = crypto.randomUUID();
    await tx.insert(jobClusters).values({ id: clusterId, memberCount: memberIds.size });
  }
  await tx.update(jobPostings).set({ clusterId, updatedAt: new Date() }).where(inArray(jobPostings.id, [...memberIds]));
  if (clusterIds.length > 1) {
    await tx.update(jobPostings).set({ clusterId, updatedAt: new Date() }).where(inArray(jobPostings.clusterId, clusterIds.slice(1)));
    await tx.delete(jobClusters).where(inArray(jobClusters.id, clusterIds.slice(1)));
  }
  await electCanonical(tx, clusterId);
  if (previousClusterId && previousClusterId !== clusterId) await electCanonical(tx, previousClusterId);
}

async function refreshClusterOf(tx: ClarityExecutor, jobPostingId: string): Promise<void> {
  const [row] = await tx.select({ clusterId: jobPostings.clusterId }).from(jobPostings).where(eq(jobPostings.id, jobPostingId)).limit(1);
  if (row?.clusterId) await electCanonical(tx, row.clusterId);
}

/** Elects the copy Clarity shows for a cluster; all members stay retrievable. */
async function electCanonical(tx: ClarityExecutor, clusterId: string): Promise<void> {
  const members = await tx.select({
    id: jobPostings.id,
    canonicalUrl: jobPostings.canonicalUrl,
    employerDomain: jobPostings.employerDomain,
    sourceType: jobPostings.sourceType,
    firstSeenAt: jobPostings.firstSeenAt,
    closedAt: jobPostings.closedAt,
  }).from(jobPostings).where(eq(jobPostings.clusterId, clusterId));
  if (members.length === 0) {
    await tx.delete(jobClusters).where(eq(jobClusters.id, clusterId));
    return;
  }
  const ordered = [...members].sort((left, right) => {
    const openness = Number(Boolean(left.closedAt)) - Number(Boolean(right.closedAt));
    if (openness !== 0) return openness;
    const rank = canonicalSourceRank({
      canonicalUrl: left.canonicalUrl,
      employerDomain: left.employerDomain ?? undefined,
      sourceType: left.sourceType as JobSourceType,
    }) - canonicalSourceRank({
      canonicalUrl: right.canonicalUrl,
      employerDomain: right.employerDomain ?? undefined,
      sourceType: right.sourceType as JobSourceType,
    });
    if (rank !== 0) return rank;
    const seen = left.firstSeenAt.getTime() - right.firstSeenAt.getTime();
    return seen !== 0 ? seen : (left.id < right.id ? -1 : 1);
  });
  await tx.update(jobClusters)
    .set({ canonicalJobPostingId: ordered[0].id, memberCount: members.length, updatedAt: new Date() })
    .where(eq(jobClusters.id, clusterId));
}

/** Extractor identity recorded on chunks produced from an ingested payload. */
const INGEST_EXTRACTOR_VERSION = 'jobposting-ingest-1';

export interface JobIngestInput {
  /** The listing's public canonical URL, already canonicalized. */
  canonicalUrl: string;
  /** `schema.org/JobPosting` JSON-LD exactly as the publisher emits it. */
  structuredData: readonly unknown[];
  /**
   * The verified Clarity site proving the publisher owns this host, or `null`
   * for a listing Clarity read from a public feed it does not own.
   */
  siteId: string | null;
  sourceType: JobSourceType;
  submittedByApplicationId?: string;
  observedAt: Date;
}

/**
 * Supported boundary for a publisher that already knows a listing exists —
 * a first-party Oxy product, or an employer with a verified site.
 *
 * The payload is put through the SAME `JobPosting` normalizer the crawler
 * uses, so nothing enters the corpus that a crawl could not have produced. The
 * publisher's page stays the canonical source; this only removes the wait for
 * a crawler to discover it.
 */
export async function ingestJobPosting(input: JobIngestInput): Promise<{ documentId: string; jobPostingIds: string[] }> {
  const postings = extractJobPostings(input.structuredData, input.canonicalUrl, input.observedAt.toISOString(), 'api');
  if (postings.length === 0) throw new Error('no_job_posting');

  const [primary] = postings;
  const body = postings.map(textIndexSource).join('\n\n');
  const chunks = chunkText(body);
  let embeddings: number[][] | undefined;
  try {
    embeddings = await embedChunks(chunks.map((chunk) => chunk.text));
  } catch {
    embeddings = undefined;
  }

  return getDb().transaction(async (tx) => {
    const mutable = {
      siteId: input.siteId,
      status: 'indexed',
      documentType: 'job',
      title: primary.title,
      description: primary.description?.slice(0, 2_000),
      mainContent: body,
      structuredData: input.structuredData,
      fieldEvidence: primary.evidence,
      publisherName: primary.employerName,
      publishedAt: primary.publishedAt,
      fetchedAt: input.observedAt,
      indexedAt: input.observedAt,
      nextFetchAt: new Date(input.observedAt.getTime() + JOB_RECRAWL_INTERVAL_SECONDS * 1000),
    };
    const [document] = await tx.insert(searchDocuments)
      .values({ id: crypto.randomUUID(), requestedUrl: input.canonicalUrl, canonicalUrl: input.canonicalUrl, ...mutable })
      .onConflictDoUpdate({ target: searchDocuments.canonicalUrl, set: { ...mutable, updatedAt: input.observedAt } })
      .returning();
    await replaceDocumentChunks(tx, document.id, chunks, embeddings, INGEST_EXTRACTOR_VERSION);
    const jobPostingIds = await projectJobPostings(tx, {
      documentId: document.id,
      documentStatus: 'indexed',
      postings,
      sourceType: input.sourceType,
      submittedByApplicationId: input.submittedByApplicationId,
      observedAt: input.observedAt,
    });
    return { documentId: document.id, jobPostingIds };
  });
}
