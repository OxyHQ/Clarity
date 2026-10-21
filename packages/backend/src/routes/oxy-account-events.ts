import express, { Router } from 'express';
import { eraseDeletedAccountExperience } from '../db/experience-repository.js';
import { oxyClient } from '../middleware/auth.js';
import { CLARITY_AGENT_MANIFEST } from '../lib/clarity-agent-manifest.js';
import { log } from '../lib/logger.js';

const router = Router();
router.post('/oxy/account-events', express.text({ type: 'application/secevent+jwt', limit: '16kb' }), async (req, res) => {
  if (!req.is('application/secevent+jwt')) {
    res.status(415).json({ error: 'Expected application/secevent+jwt' });
    return;
  }
  if (typeof req.body !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(req.body)) {
    res.status(400).json({ error: 'Expected a compact security event token' });
    return;
  }
  // Signature, issuer, event type and exact audience are verified by Oxy's SDK.
  let event;
  try {
    event = await oxyClient.accountEvents.verify(req.body, {
      audience: CLARITY_AGENT_MANIFEST.backendApplication.applicationId,
    });
  } catch {
    // Also covers unavailable signing keys: Oxy must retry, never acknowledge erasure.
    res.status(503).json({ error: 'Account event could not be verified; retry' });
    return;
  }
  try {
    await eraseDeletedAccountExperience(event.userId, event.eventId);
    res.status(202).json({ received: true, eventId: event.eventId });
  } catch (err) {
    log.general.error({ err }, 'Experience account erasure failed');
    res.status(503).json({ error: 'Account erasure could not complete; retry' });
  }
});
export default router;
