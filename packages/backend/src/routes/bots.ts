import { Router } from 'express';

import { proxyAliaJson } from '../lib/alia-agent-client.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
const SUPPORTED_CHANNELS = new Set(['telegram', 'discord']);

export function buildAliaBotPath(platform: unknown, suffix: string): string | null {
  const channel = String(platform).toLowerCase();
  if (!SUPPORTED_CHANNELS.has(channel)) return null;
  return `/bots/${suffix.replace(':platform', encodeURIComponent(channel))}`;
}

router.get('/internal/:platform/check-token/:token', authenticateToken, async (req, res) => {
  const path = buildAliaBotPath(
    req.params.platform,
    `internal/:platform/check-token/${encodeURIComponent(String(req.params.token))}`,
  );
  if (!path) {
    res.status(404).json({ error: 'Unsupported channel.' });
    return;
  }
  await proxyAliaJson(req, res, path);
});

router.post('/platform/:platform/link', authenticateToken, async (req, res) => {
  const path = buildAliaBotPath(req.params.platform, 'platform/:platform/link');
  if (!path) {
    res.status(404).json({ error: 'Unsupported channel.' });
    return;
  }
  await proxyAliaJson(req, res, path);
});

export default router;
