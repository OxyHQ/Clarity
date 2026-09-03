import { Router, type Request, type Response } from 'express';

import { proxyAliaJson } from '../lib/alia-agent-client.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

for (const path of ['/export', '/summary', '/threats'] as const) {
  router.get(path, async (req: Request, res: Response) => {
    await proxyAliaJson(req, res, `/audit${path}`);
  });
}

export default router;
