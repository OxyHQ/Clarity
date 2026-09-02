import { Router, type Request, type Response } from 'express';

import { authenticateToken } from '../middleware/auth.js';
import { proxyAliaJson } from '../lib/alia-agent-client.js';

const router = Router();

router.get('/', authenticateToken, async (req: Request, res: Response) => {
  await proxyAliaJson(req, res, '/credits');
});

router.get('/usage', authenticateToken, async (req: Request, res: Response) => {
  await proxyAliaJson(req, res, '/credits/usage');
});

export default router;
