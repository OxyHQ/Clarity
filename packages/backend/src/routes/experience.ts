import { getErrorStatus } from '@oxy.so/core';
import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { experienceInputSchema, type ExperienceErrorCode } from '@clarity.surf/sdk/experience';
import {
  ExperienceLimitError,
  ExperienceAccountErasedError,
  createExperience,
  deleteExperience,
  eraseUserExperience,
  listExperience,
  updateExperience,
} from '../db/experience-repository.js';
import { authenticateToken, oxyClient } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

const router = Router();

/** Oxy resolves merged identities; Clarity never copies the employer's mutable profile. */
async function canonicalEmployerId(accountId: string, res: Response): Promise<string | null> {
  try {
    const organization = await oxyClient.organizations.get(accountId);
    if (organization.status !== 'active' && organization.status !== 'inactive') {
      error(res, 422, 'invalid_employer', 'Choose an available organization');
      return null;
    }
    return organization.accountId;
  } catch (err) {
    if ([403, 404, 410].includes(getErrorStatus(err) ?? 0)) {
      error(res, 422, 'invalid_employer', 'Choose an available organization');
      return null;
    }
    throw err;
  }
}
function authenticatedUserId(req: Request, res: Response): string | null {
  if (req.user?.id && !req.serviceApp) return req.user.id;
  error(res, 401, 'unauthorized', 'An authenticated user session is required');
  return null;
}
function error(
  res: Response,
  status: number,
  code: ExperienceErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
) {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

// Entries contain only deliberately published fields. Never cache deleted career data.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.get('/users/:userId', async (req, res) => {
  const userId = String(req.params.userId);
  if (!userId.trim() || userId.length > 128) {
    error(res, 400, 'bad_request', 'A valid Oxy user ID is required');
    return;
  }
  if (Object.keys(req.query).length) {
    error(res, 400, 'bad_request', 'This bounded profile list accepts no query parameters');
    return;
  }
  const authorization = req.get('authorization');
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (authorization !== undefined && !bearer) {
    error(res, 401, 'unauthorized', 'A valid user session is required');
    return;
  }
  let access: Awaited<ReturnType<typeof oxyClient.safety.profileAccess>>;
  try {
    // Oxy derives the viewer from the original bearer. Explicit null is truly
    // anonymous and never falls back to this backend's service identity.
    access = await oxyClient.safety.profileAccess(
      { subjectAccountId: userId },
      { accessToken: bearer?.[1] ?? null },
    );
  } catch (err) {
    if ([401, 403].includes(getErrorStatus(err) ?? 0)) {
      error(res, 401, 'unauthorized', 'A valid user session is required');
      return;
    }
    throw err;
  }
  if (!access.allowed) {
    // Private, blocked and unavailable accounts have the same outward shape.
    error(res, 404, 'not_found', 'Experience is not available');
    return;
  }
  res.json({ items: await listExperience(userId), nextCursor: null });
});

router.use(authenticateToken);
router.use(async (req, res, next) => {
  if (!req.user?.id || req.serviceApp) {
    error(res, 401, 'unauthorized', 'An authenticated user session is required');
    return;
  }
  const account = req.user.kind
    ? req.user
    : await oxyClient.users.get(req.user.id, { cache: false });
  if (account.kind !== 'personal') {
    error(res, 403, 'forbidden', 'Experience belongs to personal accounts');
    return;
  }
  next();
});
router.post('/', async (req, res) => {
  const userId = authenticatedUserId(req, res);
  if (!userId) return;
  const result = experienceInputSchema.safeParse(req.body);
  if (!result.success) {
    const malformed = result.error.issues.some(
      (issue) => issue.code === 'invalid_type' || issue.code === 'unrecognized_keys',
    );
    error(
      res,
      malformed ? 400 : 422,
      malformed ? 'bad_request' : 'validation_failed',
      'Check the experience fields',
    );
    return;
  }
  const employerOxyAccountId = await canonicalEmployerId(result.data.employerOxyAccountId, res);
  if (!employerOxyAccountId) return;
  res.status(201).json(await createExperience(userId, { ...result.data, employerOxyAccountId }));
});
router.put('/:id', async (req, res) => {
  const userId = authenticatedUserId(req, res);
  if (!userId) return;
  const result = experienceInputSchema.safeParse(req.body);
  if (!result.success) {
    const malformed = result.error.issues.some(
      (issue) => issue.code === 'invalid_type' || issue.code === 'unrecognized_keys',
    );
    error(
      res,
      malformed ? 400 : 422,
      malformed ? 'bad_request' : 'validation_failed',
      'Check the experience fields',
    );
    return;
  }
  const employerOxyAccountId = await canonicalEmployerId(result.data.employerOxyAccountId, res);
  if (!employerOxyAccountId) return;
  const entry = await updateExperience(userId, String(req.params.id), {
    ...result.data,
    employerOxyAccountId,
  });
  if (!entry) {
    error(res, 404, 'not_found', 'Experience not found');
    return;
  }
  res.json(entry);
});
router.delete('/', async (req, res) => {
  const userId = authenticatedUserId(req, res);
  if (!userId) return;
  await eraseUserExperience(userId);
  res.status(204).end();
});
router.delete('/:id', async (req, res) => {
  const userId = authenticatedUserId(req, res);
  if (!userId) return;
  if (!(await deleteExperience(userId, String(req.params.id)))) {
    error(res, 404, 'not_found', 'Experience not found');
    return;
  }
  res.status(204).end();
});
const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ExperienceLimitError) {
    error(
      res,
      422,
      'experience_limit_reached',
      'A profile can have at most 100 experience entries',
    );
    return;
  }
  if (err instanceof ExperienceAccountErasedError) {
    error(res, 403, 'forbidden', 'This account has been erased');
    return;
  }
  log.general.error({ err }, 'Experience request failed');
  error(res, 503, 'service_unavailable', 'Experience is temporarily unavailable');
};
router.use(handleError);
export default router;
