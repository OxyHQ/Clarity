/**
 * The public Clarity Jobs read surface behind `clarity.surf/jobs`.
 *
 * Job listings are public information, so this router carries no user identity
 * at all: nothing here reads a session, and no query is attributable to a
 * person. That is the mechanism behind the privacy rule that searching or
 * viewing a listing never discloses a named user to an employer.
 *
 * Publishing, ingestion and quota-bearing operations stay on the credentialed
 * `/v1` surface.
 */
import { Router, type Request, type Response } from 'express';

import { getClientIp } from '../lib/net-utils.js';
import { checkLimit } from '../lib/sliding-window-limiter.js';
import { log } from '../lib/logger.js';
import { sendError } from '../middleware/resource-auth.js';
import { CLARITY_JOBS_CAPABILITY } from '../search/jobs/capability.js';
import { jobReportSchema, reportJobPosting } from '../search/jobs/reports.js';
import {
  JobsError, getJobPostingById, getJobPostingByUrl, jobCorpusStats, jobSearchSchema, searchJobs,
} from '../search/jobs/service.js';

const router = Router();

/** Burst protection for an anonymous surface, keyed by address, never by user. */
router.use(async (req: Request, res: Response, next) => {
  const result = await checkLimit(`anon:${getClientIp(req)}`, 'free');
  if (result.allowed) { next(); return; }
  res.setHeader('retry-after', String(result.resetInSeconds ?? 60));
  sendError(res, 429, 'rate_limited', 'Too many requests. Please retry shortly.', req);
});

router.post('/search', async (req, res) => {
  const parsed = jobSearchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'Job search validation failed', req, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    return;
  }
  try {
    res.json(await searchJobs(parsed.data));
  } catch (error) {
    respond(error, req, res);
  }
});

router.get('/capability', (_req, res) => res.json(CLARITY_JOBS_CAPABILITY));

router.get('/stats', async (_req, res) => res.json(await jobCorpusStats()));

router.get('/by-url', async (req, res) => {
  if (typeof req.query.url !== 'string') { sendError(res, 400, 'invalid_request', 'url is required', req); return; }
  try {
    const job = await getJobPostingByUrl(req.query.url);
    if (!job) { sendError(res, 404, 'job_not_found', 'Job posting not found', req); return; }
    res.json(job);
  } catch (error) {
    respond(error, req, res);
  }
});

/** Anonymous abuse report. Stores no reporter identity and never affects rank. */
router.post('/:id/report', async (req, res) => {
  const parsed = jobReportSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'invalid_request', 'A supported report reason is required', req, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    return;
  }
  try {
    const accepted = await reportJobPosting(String(req.params.id), parsed.data);
    if (!accepted) { sendError(res, 404, 'job_not_found', 'Job posting not found', req); return; }
    res.status(202).json({ status: 'received' });
  } catch (error) {
    respond(error, req, res);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const job = await getJobPostingById(String(req.params.id));
    if (!job) { sendError(res, 404, 'job_not_found', 'Job posting not found', req); return; }
    res.json(job);
  } catch (error) {
    respond(error, req, res);
  }
});

function respond(error: unknown, req: Request, res: Response): void {
  if (error instanceof JobsError) {
    sendError(res, error.status, error.code, error.message, req);
    return;
  }
  log.general.error({ err: error }, 'Clarity Jobs request failed');
  sendError(res, 500, 'jobs_unavailable', 'Clarity Jobs is temporarily unavailable', req);
}

export default router;
