import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker0 from '../packages/frontend/worker/index.js';

test('frontend keeps asset streams, headers and errors', async () => {
  const response = new Response('asset bytes', {
    headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=3600' },
  });
  const request = new Request('https://example.test/assets/app.js');
  const env = { ASSETS: { fetch: async () => response } };
  const ctx = {
    waitUntil() {
      throw new Error('the frontend Worker schedules no background work');
    },
  };
  assert.equal(await worker0.fetch(request, env, ctx), response);
  assert.equal(await response.text(), 'asset bytes');
  const failure = new Error('asset binding failure');
  env.ASSETS.fetch = async () => {
    throw failure;
  };
  await assert.rejects(worker0.fetch(request, env, ctx), (error) => error === failure);
});

test('missing static files remain 404 while navigation retains the SPA fallback', async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response('shell', { headers: { 'content-type': 'text/html' } }),
    },
  };
  const ctx = { waitUntil() {} };
  assert.equal(
    (await worker0.fetch(new Request('https://clarity.surf/missing.js'), env, ctx)).status,
    404,
  );
  assert.equal(
    await (await worker0.fetch(new Request('https://clarity.surf/settings'), env, ctx)).text(),
    'shell',
  );
});
