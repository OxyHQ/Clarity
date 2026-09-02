import { Router, type Request, type Response } from 'express';

import { authenticateToken } from '../middleware/auth.js';
import { proxyAliaJson } from '../lib/alia-agent-client.js';

const router = Router();
router.use(authenticateToken);

/** Inference telemetry is written and read in Alia PostgreSQL. */
for (const resource of ['usage', 'models', 'credits'] as const) {
  router.get(`/${resource}`, async (req: Request, res: Response) => {
    await proxyAliaJson(req, res, `/analytics/${resource}`);
  });
}

export default router;
