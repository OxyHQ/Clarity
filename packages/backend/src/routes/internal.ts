import { Router } from 'express';

import { oxyServiceAuth } from '../middleware/auth.js';

const router = Router();

/**
 * A service token is not an Alia agent identity and must not be treated as one.
 * This endpoint stays explicit and fail-closed until Oxy/Alia publish and
 * provision the canonical service-to-agent delegation contract for Clarity.
 */
router.post('/trigger', oxyServiceAuth, (_req, res) => {
  res.status(503).json({
    error: 'Clarity agent service identity is not provisioned',
    code: 'clarity_agent_service_identity_unavailable',
  });
});

export default router;
