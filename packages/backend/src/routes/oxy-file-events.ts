import { FileEventVerificationError, verifyFileEventSignature } from '@oxy.so/core/server';
import express, { Router } from 'express';

import { getDb } from '../db/index.js';
import { oxyFileEvents } from '../db/schema/index.js';
import { forgetOxyFile, reassertUses, setOxyFileBlocked } from '../files/references.js';
import { log } from '../lib/logger.js';

/**
 * `POST /webhooks/oxy/files` — Oxy's file events for the files Clarity owns
 * and uses (ADR 0043 D9), signed with the secret Oxy showed once when the
 * endpoint was set (console → Webhooks → File events), held in
 * `OXY_FILES_WEBHOOK_SECRET`.
 *
 * Mounted before `express.json()`: the signature is over the RAW body.
 * Delivery is at least once, so an event acts only through the request that
 * records its id; a repeat answers 200 and does nothing.
 *
 * - `file.blocked` / `file.unblocked`: a content claim took the file down (or
 *   a counter-notice brought it back) — every image and icon Clarity serves
 *   from it is hidden, or shown again.
 * - `file.deleted`: Oxy no longer has it; Clarity forgets it, and the next
 *   request for an image that used it imports it afresh.
 * - `file.trashed`: Oxy trashes a Clarity file only when it holds no Clarity
 *   reference; if Clarity still lists a use, the reference is sent again,
 *   which restores the file.
 * - `file.restored` / `file.visibility_changed`: nothing to change (Clarity's
 *   files are all public and only Clarity changes them).
 */
const router = Router();

function webhookSecret(): string {
  return process.env.OXY_FILES_WEBHOOK_SECRET?.trim() ?? '';
}

router.post('/', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let event: ReturnType<typeof verifyFileEventSignature>;
  try {
    event = verifyFileEventSignature(body, req.headers, webhookSecret());
  } catch (error) {
    if (error instanceof FileEventVerificationError) {
      res.status(400).json({ error: { code: 'invalid_event', message: error.message } });
      return;
    }
    throw error;
  }
  if (event.type === 'webhook.challenge') {
    res.json({ challenge: event.challenge });
    return;
  }

  const fileId = event.file.id;
  try {
    const acted = await getDb().transaction(async (tx) => {
      const recorded = await tx
        .insert(oxyFileEvents)
        .values({ eventId: event.id, type: event.type, oxyFileId: fileId })
        .onConflictDoNothing()
        .returning({ eventId: oxyFileEvents.eventId });
      if (recorded.length === 0) return false;
      switch (event.type) {
        case 'file.blocked':
          await setOxyFileBlocked(tx, fileId, true);
          break;
        case 'file.unblocked':
          await setOxyFileBlocked(tx, fileId, false);
          break;
        case 'file.deleted':
          await forgetOxyFile(tx, fileId);
          break;
        case 'file.trashed':
          await reassertUses(tx, fileId);
          break;
        case 'file.restored':
        case 'file.visibility_changed':
          break;
      }
      return true;
    });
    res.status(200).json({ received: true, duplicate: !acted });
  } catch (err) {
    log.general.error({ err, eventType: event.type }, 'Oxy file event could not be applied');
    // Not acknowledged: Oxy retries with back-off.
    res.status(503).json({ error: { code: 'retry', message: 'The event could not be applied' } });
  }
});

export default router;
