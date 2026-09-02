import { Router, type Request } from 'express';

import { proxyAliaJson } from '../lib/alia-agent-client.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
const authenticated = Router();
authenticated.use(authenticateToken);

authenticated.get('/', async (req, res) => proxyAliaJson(req, res, '/triggers'));
authenticated.post('/', async (req, res) => proxyAliaJson(req, res, '/triggers'));

const triggerPath = (req: Request, suffix = '') => (
  `/triggers/${encodeURIComponent(String(req.params.id))}${suffix}`
);

authenticated.get('/:id', async (req, res) => proxyAliaJson(req, res, triggerPath(req)));
authenticated.patch('/:id', async (req, res) => proxyAliaJson(req, res, triggerPath(req)));
authenticated.delete('/:id', async (req, res) => proxyAliaJson(req, res, triggerPath(req)));
authenticated.post('/:id/run', async (req, res) => (
  proxyAliaJson(req, res, triggerPath(req, '/run'), { timeoutMs: 15 * 60_000 })
));
authenticated.get('/:id/executions', async (req, res) => proxyAliaJson(req, res, triggerPath(req, '/executions')));
authenticated.post('/:id/regenerate-token', async (req, res) => (
  proxyAliaJson(req, res, triggerPath(req, '/regenerate-token'))
));

router.use('/', authenticated);

export default router;
