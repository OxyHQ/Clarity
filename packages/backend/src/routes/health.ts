import { Router } from 'express';
import { checkPostgres } from '../db/index.js';
import { getRuntimeReadiness } from '../db/runtime-readiness.js';
import { getRedisClient } from '../lib/redis.js';

const router = Router();

async function snapshot() {
  const [databaseReady, readiness] = await Promise.all([checkPostgres(), getRuntimeReadiness()]);
  const cutover = readiness.ready;
  const agentConfigured = Boolean(process.env.CLARITY_ALIA_AGENT_ID?.trim());
  const mem = process.memoryUsage();
  return {
    status: databaseReady && cutover && agentConfigured ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    database: databaseReady ? 'connected' : 'unavailable',
    databaseEngine: 'postgresql',
    dataCutover: cutover ? 'attested' : 'unattested',
    readinessReason: readiness.ready === false ? readiness.reason : null,
    aliaAgent: agentConfigured ? 'configured' : 'unconfigured',
    redis: getRedisClient() ? 'connected' : 'unavailable',
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
  };
}

router.get('/', async (_req, res) => {
  const value = await snapshot();
  res.status(value.status === 'healthy' ? 200 : 503).json(value);
});

router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

router.get('/ready', async (_req, res) => {
  const value = await snapshot();
  if (value.database !== 'connected') {
    res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
    return;
  }
  if (value.aliaAgent !== 'configured') {
    res.status(503).json({ status: 'not_ready', reason: 'clarity_agent_unconfigured' });
    return;
  }
  if (value.dataCutover !== 'attested') {
    res.status(503).json({ status: 'not_ready', reason: value.readinessReason });
    return;
  }
  res.status(200).json({ status: 'ready' });
});

export default router;
