import { jobReportSchema, reportJobPosting } from '../../search/jobs/reports.js';
import {
  getJobPostingById,
  getJobPostingByUrl,
  jobCorpusStats,
  JobsError,
  jobSearchSchema,
  searchJobs,
} from '../../search/jobs/service.js';
import {
  type ClarityToolHandlers,
  notFound,
  parseInput,
  requiredString,
  ToolError,
} from './context.js';

/**
 * Jobs never receive the effective account: a search, a view or a report by
 * a person is not attributable to that person (AGENTS.md, Jobs).
 */
function rethrow(error: unknown): never {
  if (error instanceof JobsError) throw new ToolError(error.status, error.code, error.message);
  throw error;
}

export const JOB_HANDLERS: ClarityToolHandlers = {
  searchJobs: async (input) => {
    try {
      return { ...(await searchJobs(parseInput(jobSearchSchema, input))) };
    } catch (error) {
      rethrow(error);
    }
  },
  getJob: async (input) => {
    const job = await getJobPostingById(requiredString(input, 'jobId'));
    if (!job) throw notFound('job_not_found', 'Job posting not found');
    return { ...job };
  },
  getJobByUrl: async (input) => {
    try {
      const job = await getJobPostingByUrl(requiredString(input, 'url'));
      if (!job) throw notFound('job_not_found', 'Job posting not found');
      return { ...job };
    } catch (error) {
      rethrow(error);
    }
  },
  getJobStats: async () => ({ ...(await jobCorpusStats()) }),
  reportJob: async (input) => {
    const { jobId, ...report } = input;
    const accepted = await reportJobPosting(
      requiredString({ jobId }, 'jobId'),
      parseInput(jobReportSchema, report),
    );
    if (!accepted) throw notFound('job_not_found', 'Job posting not found');
    return { status: 'received' };
  },
};
