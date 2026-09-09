/**
 * Reader reports about a listing.
 *
 * Two invariants make this safe to expose on an anonymous surface:
 *
 * 1. A report stores no reporter identity — not a user id, not an address.
 * 2. A report is an operator signal only. It is NOT a ranking input, and the
 *    ranking modules cannot reach this table; the ranking-contract test keeps
 *    it that way.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../../db/index.js';
import { jobPostings, jobReports } from '../../db/schema/index.js';

export const JOB_REPORT_REASONS = [
  'scam', 'already_filled', 'duplicate', 'misleading', 'discriminatory', 'other',
] as const;

export const jobReportSchema = z.object({
  reason: z.enum(JOB_REPORT_REASONS),
  detail: z.string().trim().max(1_000).optional(),
});

export type JobReportInput = z.infer<typeof jobReportSchema>;

/** Returns false when the listing does not exist; the caller answers 404. */
export async function reportJobPosting(jobPostingId: string, input: JobReportInput): Promise<boolean> {
  const database = getDb();
  const [job] = await database.select({ id: jobPostings.id }).from(jobPostings).where(eq(jobPostings.id, jobPostingId)).limit(1);
  if (!job) return false;
  await database.insert(jobReports).values({
    id: crypto.randomUUID(),
    jobPostingId: job.id,
    reason: input.reason,
    ...(input.detail ? { detail: input.detail } : {}),
  });
  return true;
}
