import { Router, type Request, type Response } from 'express';

import { proxyAliaJson } from '../lib/alia-agent-client.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
router.use(authenticateToken);

const proxy = (path: string) => async (req: Request, res: Response) => {
  await proxyAliaJson(req, res, path);
};
const proxyMemory = (suffix = '') => proxy(`/memory${suffix}`);

router.get('/', proxyMemory());
router.get('/stats', proxyMemory('/stats'));
router.get('/semantic-search', proxyMemory('/semantic-search'));
router.get('/search', proxyMemory('/search'));
router.get('/duplicates', proxyMemory('/duplicates'));
router.get('/export/preview', proxyMemory('/export/preview'));
router.get('/export/json', proxyMemory('/export/json'));
router.get('/export/csv', proxyMemory('/export/csv'));
router.put('/context', proxyMemory('/context'));
router.put('/preferences', proxyMemory('/preferences'));
router.put('/settings', proxyMemory('/settings'));
router.post('/add', proxyMemory('/add'));
router.post('/import/validate', proxyMemory('/import/validate'));
router.post('/import', proxyMemory('/import'));
router.post('/import/from-text', proxyMemory('/import/from-text'));

router.put('/:memoryId', async (req, res) => {
  await proxyAliaJson(req, res, `/memory/${encodeURIComponent(String(req.params.memoryId))}`);
});
router.delete('/:memoryId', async (req, res) => {
  await proxyAliaJson(req, res, `/memory/${encodeURIComponent(String(req.params.memoryId))}`);
});

export default router;
