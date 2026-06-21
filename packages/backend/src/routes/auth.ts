import { Router } from 'express';
import { OxyServices } from '@oxyhq/core';
import { authenticateToken } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

const router = Router();

// Initialize Oxy client
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

/**
 * GET /auth/me
 * Get current user from Oxy session
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Get full user data from Oxy
    const user = await oxyClient.getUserById(req.user.id);

    res.json({
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
      },
    });
  } catch (error: unknown) {
    log.auth.error({ err: error }, 'Get user error');
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * POST /auth/logout
 * Logout - handled by Oxy on client side, this endpoint exists for compatibility
 */
router.post('/logout', authenticateToken, async (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

/**
 * POST /auth/authorize/codea
 * Developer app authorization was removed during Clarity pruning.
 */
router.post('/authorize/codea', authenticateToken, async (_req, res) => {
  res.status(410).json({ error: 'Developer app authorization is no longer available' });
});

/**
 * POST /auth/authorize/cowork
 * Developer app authorization was removed during Clarity pruning.
 */
router.post('/authorize/cowork', authenticateToken, async (_req, res) => {
  res.status(410).json({ error: 'Developer app authorization is no longer available' });
});

/**
 * POST /auth/token
 * Token exchange was removed during Clarity pruning.
 */
router.post('/token', async (_req, res) => {
  res.status(410).json({ error: 'Token exchange is no longer available' });
});

export default router;
