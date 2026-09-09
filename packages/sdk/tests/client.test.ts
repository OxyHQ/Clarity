import { describe, expect, it, vi } from 'vitest';
import { ClarityClient, ClarityError } from '../src/client.js';

describe('ClarityClient', () => {
  it('sends API keys and idempotency keys without Node-only APIs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'job_1', status: 'queued' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new ClarityClient({ apiKey: 'oxy_sk_test', baseUrl: 'https://clarity.test/', fetch: fetcher });
    await client.indexing.urls({ urls: ['https://example.com'] }, { idempotencyKey: 'request-1' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://clarity.test/v1/index/urls');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oxy_sk_test');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('request-1');
  });

  it('returns typed API errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'scope_missing', message: 'Missing scope', requestId: 'req_1' },
    }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const client = new ClarityClient({ accessToken: 'token', fetch: fetcher });
    const error = await client.search({ query: 'test' }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClarityError);
    expect(error).toMatchObject({ code: 'scope_missing', status: 403, requestId: 'req_1' });
  });

  it('rejects ambiguous authentication', () => {
    expect(() => new ClarityClient({ apiKey: 'key', accessToken: 'token' })).toThrow('exactly one');
  });

  it('routes crawl/index work to the operations namespace', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'op_1', kind: 'urls', status: 'succeeded', pagesDiscovered: 1, pagesCompleted: 1,
      createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new ClarityClient({ apiKey: 'oxy_sk_test', baseUrl: 'https://clarity.test', fetch: fetcher });
    const operation = await client.operations.wait('op_1');
    expect(operation.status).toBe('succeeded');
    expect(fetcher.mock.calls[0][0]).toBe('https://clarity.test/v1/operations/op_1');
    expect(client).not.toHaveProperty('jobs.cancel');
  });

  it('searches employment listings through clarity.jobs', async () => {
    const job = {
      id: 'job_1', documentId: 'doc_1', canonicalUrl: 'https://acme.example/careers/rn',
      title: 'React Native Developer', employer: { name: 'Acme', domain: 'acme.example' },
      locations: [], applicantLocationRequirements: ['Spain'], workplaceType: 'remote',
      employmentTypes: ['full_time'], skills: [], firstSeenAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-08T00:00:00.000Z', status: 'active',
      source: {
        type: 'web', domain: 'acme.example', canonicalUrl: 'https://acme.example/careers/rn',
        documentId: 'doc_1', firstSeenAt: '2026-09-01T00:00:00.000Z',
        lastSeenAt: '2026-09-08T00:00:00.000Z', status: 'active',
      },
      otherSources: [], evidence: {}, score: 0.5,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [job], mode: 'hybrid',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new ClarityClient({ apiKey: 'oxy_sk_test', baseUrl: 'https://clarity.test', fetch: fetcher });

    const results = await client.jobs.search({
      query: 'React Native developer',
      locations: ['europe'],
      workplaceTypes: ['remote'],
      employmentTypes: ['full_time'],
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://clarity.test/v1/jobs/search');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'React Native developer',
      locations: ['europe'],
      workplaceTypes: ['remote'],
      employmentTypes: ['full_time'],
    });
    expect(results.data[0].source.canonicalUrl).toBe('https://acme.example/careers/rn');
    expect(results.data[0]).not.toHaveProperty('sponsored');
  });

  it('hands a newly published listing to Clarity through jobs.ingest', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      url: 'https://mention.earth/jobs/7', operationId: 'op_2', status: 'indexed',
    }), { status: 202, headers: { 'content-type': 'application/json' } }));
    const client = new ClarityClient({ apiKey: 'oxy_sk_test', baseUrl: 'https://clarity.test', fetch: fetcher });
    const result = await client.jobs.ingest({
      url: 'https://mention.earth/jobs/7',
      jobPosting: { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Community Manager' },
    }, { idempotencyKey: 'mention-job-7' });
    expect(result.status).toBe('indexed');
    expect(fetcher.mock.calls[0][0]).toBe('https://clarity.test/v1/jobs/ingest');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('idempotency-key')).toBe('mention-job-7');
  });
});
