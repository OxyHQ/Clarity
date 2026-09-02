import { Router, Request, Response } from 'express';
import chatCompletionsRouter from './v1/chat-completions.js';
import modelsRouter from './v1/models.js';
import { authenticateToken } from '../middleware/auth.js';
import { sessionRateLimit } from '../middleware/session-rate-limit.js';
import { fetchAliaJson } from '../lib/alia-agent-client.js';
import { log } from '../lib/logger.js';

const router = Router();


router.get('/', (_req, res) => {
  res.json({
    message: 'AI Platform API v1',
    version: '1.0.0'
  });
});

// Public routes (no auth required)
router.use('/models', modelsRouter);

// Apply canonical Oxy user authentication to all other v1 routes.
router.use(authenticateToken);

// Apply product-tier burst protection. Inference accounting remains in Alia/Oxy.
router.use(sessionRateLimit);

/**
 * GET /v1/me
 * Get current user info (works for any authenticated client)
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!req.accessToken || req.serviceApp) {
      return res.status(401).json({ error: 'An authenticated Oxy user session is required' });
    }
    const credits = await fetchAliaJson<{
      credits: number;
      freeCredits: number;
      paidCredits: number;
    }>(req.accessToken, '/credits');

    res.json({
      id: userId,
      email: req.user?.email || '',
      name: req.user?.displayName || req.user?.email || '',
      credits: {
        free: credits.freeCredits,
        paid: credits.paidCredits,
        total: credits.credits,
      },
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to fetch user info');
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

/**
 * POST /v1/resolve-model
 * Removed: inference routing is owned by Alia/Oxy/Kaana.
 */
router.post('/resolve-model', async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Use /v1/chat/completions with Clarity model IDs. Direct inference routing is unavailable.',
  });
});

/**
 * POST /v1/report-usage
 * Removed: usage is tracked internally by the runtime.
 */
router.post('/report-usage', async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Usage is tracked automatically by Alia and Oxy inference.',
  });
});

router.use('/chat/completions', chatCompletionsRouter);

export default router;
