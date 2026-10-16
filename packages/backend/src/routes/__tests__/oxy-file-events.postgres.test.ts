import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, like } from 'drizzle-orm';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import {
  imageCache,
  imageReferences,
  oxyFileEvents,
  oxyFileReferenceOutbox,
} from '../../db/schema/index.js';
import router from '../oxy-file-events.js';

/**
 * `POST /webhooks/oxy/files` with Oxy's real signature scheme, against real
 * Postgres: the challenge is echoed, an unsigned or mis-signed body changes
 * nothing, each event acts once however often it is delivered, and a takedown
 * hides the image until it is lifted.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const SECRET = 'whsec_test_secret';

function signed(body: object, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  const text = JSON.stringify(body);
  const signature = createHmac('sha256', secret).update(`${at}.${text}`).digest('hex');
  return { text, header: `t=${at},v1=${signature}` };
}

function fileEvent(id: string, type: string, fileId = 'ofe-file') {
  return {
    id,
    type,
    occurredAt: new Date().toISOString(),
    file: { id: fileId, ownerKind: 'application', visibility: 'public', status: 'blocked' },
    references: [],
  };
}

suite('Oxy file events on Postgres', () => {
  let server: Server;
  let base: string;

  async function post(text: string, signature?: string) {
    return fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'oxy-signature': signature } : {}),
      },
      body: text,
    });
  }

  async function cleanup() {
    await getDb().delete(imageCache).where(like(imageCache.key, 'ofe-%'));
    await getDb().delete(imageReferences).where(like(imageReferences.entityId, 'ofe-%'));
    await getDb().delete(oxyFileEvents).where(like(oxyFileEvents.eventId, 'ofe-%'));
    await getDb()
      .delete(oxyFileReferenceOutbox)
      .where(like(oxyFileReferenceOutbox.entityId, 'ofe-%'));
  }

  beforeAll(async () => {
    process.env.OXY_FILES_WEBHOOK_SECRET = SECRET;
    connectPostgres(databaseUrl);
    await cleanup();
    server = createServer(express().use('/webhooks/oxy/files', router));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/oxy/files`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await closePostgres();
  });

  beforeEach(async () => {
    await cleanup();
    await getDb().insert(imageCache).values({
      key: 'ofe-key',
      sourceUrl: 'https://ofe.example/a.png',
      status: 'ready',
      oxyFileId: 'ofe-file',
    });
  });

  it('echoes the endpoint challenge', async () => {
    const response = await post(JSON.stringify({ type: 'webhook.challenge', challenge: 'c-1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'c-1' });
  });

  it('refuses an unsigned, mis-signed or stale event and changes nothing', async () => {
    const event = fileEvent('ofe-e0', 'file.blocked');
    expect((await post(JSON.stringify(event))).status).toBe(400);
    const wrong = signed(event, 'another-secret');
    expect((await post(wrong.text, wrong.header)).status).toBe(400);
    const stale = signed(event, SECRET, Math.floor(Date.now() / 1000) - 3600);
    expect((await post(stale.text, stale.header)).status).toBe(400);
    const [row] = await getDb().select().from(imageCache).where(eq(imageCache.key, 'ofe-key'));
    expect(row.status).toBe('ready');
  });

  it('hides a blocked image once, however often it is delivered, until it is unblocked', async () => {
    const blocked = signed(fileEvent('ofe-e1', 'file.blocked'));
    const first = await post(blocked.text, blocked.header);
    const again = await post(blocked.text, blocked.header);
    expect(await first.json()).toEqual({ received: true, duplicate: false });
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    const [hidden] = await getDb().select().from(imageCache).where(eq(imageCache.key, 'ofe-key'));
    expect(hidden.status).toBe('blocked');

    const unblocked = signed(fileEvent('ofe-e2', 'file.unblocked'));
    expect((await post(unblocked.text, unblocked.header)).status).toBe(200);
    const [shown] = await getDb().select().from(imageCache).where(eq(imageCache.key, 'ofe-key'));
    expect(shown.status).toBe('ready');
  });

  it('forgets a deleted file and re-sends the uses of a trashed one', async () => {
    await getDb().insert(imageReferences).values({
      entityType: 'search_document',
      entityId: 'ofe-doc',
      oxyFileId: 'ofe-file',
      imageKey: 'ofe-key',
    });
    await getDb()
      .delete(oxyFileReferenceOutbox)
      .where(like(oxyFileReferenceOutbox.entityId, 'ofe-%'));

    const trashed = signed(fileEvent('ofe-e3', 'file.trashed'));
    expect((await post(trashed.text, trashed.header)).status).toBe(200);
    const owed = await getDb()
      .select({ op: oxyFileReferenceOutbox.op })
      .from(oxyFileReferenceOutbox)
      .where(eq(oxyFileReferenceOutbox.entityId, 'ofe-doc'));
    expect(owed).toEqual([{ op: 'add' }]);

    const deleted = signed(fileEvent('ofe-e4', 'file.deleted'));
    expect((await post(deleted.text, deleted.header)).status).toBe(200);
    expect(await getDb().select().from(imageCache).where(eq(imageCache.key, 'ofe-key'))).toEqual(
      [],
    );
    expect(
      await getDb().select().from(imageReferences).where(eq(imageReferences.entityId, 'ofe-doc')),
    ).toEqual([]);
  });
});
