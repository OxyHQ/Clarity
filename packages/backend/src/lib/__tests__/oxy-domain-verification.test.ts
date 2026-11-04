import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OxyServer } from '@oxy.so/core/server';

import {
  DomainVerificationUnavailableError,
  verifyOxyDomainOwnership,
} from '../oxy-domain-verification.js';

/**
 * Domain verification against a fixture Oxy over real HTTP, through a real
 * `OxyServer` that mints its workload token from the fixture.
 *
 * The defect this guards: any non-2xx answer — an Oxy outage included — used to
 * read as "not verified", so a site owner was told their domain was not theirs
 * whenever Oxy blinked. Only Oxy's 403 and 404 are answers; everything else is
 * unavailable, and nothing is remembered between calls.
 */

type Answer = { status: number; body?: unknown };

let oxyHttp: Server;
let oxy: OxyServer;
let answers: Answer[] = [];
const requests: Array<{ authorization?: string; body: unknown }> = [];

const QUERY = {
  accountId: 'account-1',
  verifiedDomainId: 'domain-1',
  originHost: 'shop.example',
};

beforeAll(async () => {
  const fixture = express();
  fixture.use(express.json());
  fixture.post('/auth/service-token/workload/challenge', (_req, res) =>
    res.json({ nonce: 'test-challenge' }),
  );
  fixture.post('/auth/service-token/workload', (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const token = `e30.${Buffer.from(
      JSON.stringify({
        type: 'service',
        authority: 'first_party',
        appId: 'clarity-backend',
        aud: req.body.audience ?? 'oxy-api',
        iat: now,
        exp: now + 300,
      }),
    ).toString('base64url')}.fixture`;
    res.json({ token, expiresIn: 300, appName: 'Fixture' });
  });
  fixture.post('/auth/resources/domains/verify', (req, res) => {
    requests.push({ authorization: req.header('authorization'), body: req.body });
    const answer = answers.shift() ?? { status: 500, body: { error: 'no answer queued' } };
    res.status(answer.status).json(answer.body ?? {});
  });
  oxyHttp = fixture.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => oxyHttp.once('listening', resolve));
  oxy = new OxyServer({
    baseURL: `http://127.0.0.1:${(oxyHttp.address() as AddressInfo).port}`,
    serviceIdentity: 'when-anonymous',
    workloadCredentials: async () => ({
      AccessKeyId: 'test-domain-verification',
      SecretAccessKey: 'test-only-no-aws-secret',
      Token: 'test-temporary-session',
    }),
  });
});

afterAll(async () => {
  oxy?.dispose();
  await new Promise<void>((resolve) => oxyHttp.close(() => resolve()));
});

beforeEach(() => {
  answers = [];
  requests.length = 0;
});

describe('verifyOxyDomainOwnership', () => {
  it('asks Oxy as the workload, with exactly the query, and reads its answer', async () => {
    answers = [
      { status: 200, body: { verified: true } },
      { status: 200, body: { verified: false } },
    ];
    await expect(verifyOxyDomainOwnership(oxy, QUERY)).resolves.toBe(true);
    await expect(verifyOxyDomainOwnership(oxy, QUERY)).resolves.toBe(false);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.body).toEqual(QUERY);
      expect(request.authorization).toMatch(/^Bearer e30\./);
    }
  });

  it.each([403, 404])('reads Oxy %i as "not verified"', async (status) => {
    answers = [{ status, body: { error: { code: 'not_found', message: 'No such domain' } } }];
    await expect(verifyOxyDomainOwnership(oxy, QUERY)).resolves.toBe(false);
  });

  it.each([500, 502, 503, 401, 429, 400])(
    'never reads Oxy %i as "not verified"',
    async (status) => {
      answers = [{ status, body: { error: { code: 'unavailable', message: 'Down' } } }];
      await expect(verifyOxyDomainOwnership(oxy, QUERY)).rejects.toBeInstanceOf(
        DomainVerificationUnavailableError,
      );
    },
  );

  it('treats an answer that is not one as unavailable', async () => {
    answers = [{ status: 200, body: { verified: 'yes' } }];
    await expect(verifyOxyDomainOwnership(oxy, QUERY)).rejects.toBeInstanceOf(
      DomainVerificationUnavailableError,
    );
  });

  it('treats an unreachable Oxy as unavailable', async () => {
    const closed = express().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => closed.once('listening', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = new OxyServer({
      baseURL: `http://127.0.0.1:${port}`,
      workloadCredentials: async () => ({
        AccessKeyId: 'test-domain-verification',
        SecretAccessKey: 'test-only-no-aws-secret',
        Token: 'test-temporary-session',
      }),
    });
    try {
      await expect(verifyOxyDomainOwnership(unreachable, QUERY)).rejects.toBeInstanceOf(
        DomainVerificationUnavailableError,
      );
    } finally {
      unreachable.dispose();
    }
  });

  it('remembers neither an outage nor an answer', async () => {
    answers = [
      { status: 503, body: { error: { code: 'service_unavailable', message: 'Down' } } },
      { status: 200, body: { verified: true } },
      { status: 404 },
    ];
    await expect(verifyOxyDomainOwnership(oxy, QUERY)).rejects.toBeInstanceOf(
      DomainVerificationUnavailableError,
    );
    await expect(verifyOxyDomainOwnership(oxy, QUERY)).resolves.toBe(true);
    await expect(verifyOxyDomainOwnership(oxy, QUERY)).resolves.toBe(false);
    expect(requests).toHaveLength(3);
  });
});
