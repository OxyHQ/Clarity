import { getErrorStatus } from '@oxy.so/core';
import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import type { ExperienceErrorCode } from '@clarity.surf/sdk/experience';
import {
  createExperience,
  deleteExperience,
  eraseUserExperience,
  listExperience,
  updateExperience,
} from '../db/experience-repository.js';
import {
  canonicalEmployerId,
  experienceWriteError,
  parseExperienceInput,
  requirePersonalAccount,
} from '../lib/experience.js';
import { experienceAuth, experienceOptionalAuth, oxyClient } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

const router = Router();

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
router.get('/users/:userId', experienceOptionalAuth, async (req, res) => {
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
  // Privacy is not a rating. Work history has no trusted content-rating producer.
  // Own management is derived only from the SDK-verified original session, never a caller flag.
  const content = await oxyClient.safety.contentAccess(
    {
      resourceId: `experience:${userId}`,
      authorAccountId: userId,
      classification: 'unrated',
      audience: 'public',
      operation: req.user?.id === userId && !req.serviceApp ? 'manage_own' : 'read',
    },
    { accessToken: bearer?.[1] ?? null },
  );
  if (!content.allowed) {
    error(res, 404, 'not_found', 'Experience is not available');
    return;
  }
  res.json({ items: await listExperience(userId), nextCursor: null });
});

router.use(experienceAuth);
router.use(async (req, res, next) => {
  if (!req.user?.id || req.serviceApp) {
    error(res, 401, 'unauthorized', 'An authenticated user session is required');
    return;
  }
  await requirePersonalAccount(
    req.user.id,
    typeof req.user.kind === 'string' ? req.user.kind : undefined,
  );
  next();
});
router.post('/', async (req, res) => {
  const userId = authenticatedUserId(req, res);
  if (!userId) return;
  const input = parseExperienceInput(req.body);
  const employerOxyAccountId = await canonicalEmployerId(input.employerOxyAccountId);
  res.status(201).json(await createExperience(userId, { ...input, employerOxyAccountId }));
});
router.put('/:id', async (req, res) => {
  const userId = authenticatedUserId(req, res);
  if (!userId) return;
  const input = parseExperienceInput(req.body);
  const employerOxyAccountId = await canonicalEmployerId(input.employerOxyAccountId);
  const entry = await updateExperience(userId, String(req.params.id), {
    ...input,
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
  const refusal = experienceWriteError(err);
  if (refusal) {
    error(res, refusal.status, refusal.code, refusal.message);
    return;
  }
  log.general.error({ err }, 'Experience request failed');
  error(res, 503, 'service_unavailable', 'Experience is temporarily unavailable');
};
router.use(handleError);
export default router;
