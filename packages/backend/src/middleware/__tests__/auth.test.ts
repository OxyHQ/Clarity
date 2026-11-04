import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { experienceOptionalAuth } from '../auth.js';

/**
 * The Experience profile read is open to anonymous viewers, but a credential
 * that is PRESENTED must be a valid bearer: the route forwards
 * `req.accessToken` to Oxy's visibility decision, so a malformed one must never
 * reach it as "anonymous". That refusal is the real middleware's
 * (`strictOptionalBearer`), not a re-parse of `Authorization` in the route.
 * None of these cases reaches Oxy.
 */
let server: Server;
let base: string;
const seen: Array<string | null> = [];

beforeAll(async () => {
  const app = express();
  app.get('/profile', experienceOptionalAuth, (req, res) => {
    seen.push(req.accessToken ?? null);
    res.json({ ok: true });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('experienceOptionalAuth', () => {
  it('admits an anonymous viewer with no access token', async () => {
    seen.length = 0;
    expect((await fetch(`${base}/profile`)).status).toBe(200);
    expect(seen).toEqual([null]);
  });

  it.each([
    ['a non-Bearer scheme', 'Basic aW52YWxpZA=='],
    ['an empty header', ''],
    ['a bearer that is not a token', 'Bearer not-a-jwt'],
  ])('refuses %s instead of reading it as anonymous', async (_case, authorization) => {
    seen.length = 0;
    const response = await fetch(`${base}/profile`, { headers: { authorization } });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });
});
