import { Router, type Request, type Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { sessionRateLimit } from '../middleware/session-rate-limit.js';
import searchPlatformRouter from './v1/search-platform.js';
import marketRouter from './v1/market.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    message: 'Clarity API v1',
    version: '1.0.0',
  });
});

// Credentialed surfaces. They authenticate an oxy_sk resource credential
// themselves, so they mount ahead of the user-session middleware below.
router.use(searchPlatformRouter);
router.use('/market', marketRouter);

// Apply canonical Oxy user authentication to all other v1 routes.
router.use(authenticateToken);

// Apply product-tier burst protection.
router.use(sessionRateLimit);

/**
 * GET /v1/me
 * The signed-in person, as Clarity sees them. Their Alia credits are Alia's
 * and are read from Alia by the client, not here.
 */
router.get('/me', (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId || req.serviceApp) {
    res.status(401).json({ error: 'An authenticated Oxy user session is required' });
    return;
  }
  res.json({
    id: userId,
    email: req.user?.email || '',
    name: req.user?.displayName || req.user?.email || '',
  });
});

export default router;
