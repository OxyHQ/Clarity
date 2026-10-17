/**
 * The catalogue's handlers, called the way both MCP lanes call them, with the
 * domain behind them stubbed: the effective account, the refusals, the
 * idempotency receipts and the promises each domain makes (Jobs never learns
 * who asked; experience is personal accounts only; a plan feature counts only
 * when it is enabled outright).
 */
import type { InvocationContext } from '@oxy.so/mcp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Bun runs this suite too: plain factories over the whole module, no
// `vi.hoisted` or `importOriginal`.
const domain = {
  searchJobs: vi.fn(),
  reportJobPosting: vi.fn(),
  getJobPostingById: vi.fn(),
  searchIndex: vi.fn(),
  getUserEntitlements: vi.fn(),
  usersGet: vi.fn(),
  organizationsGet: vi.fn(),
  createExperience: vi.fn(),
  markAsRead: vi.fn(),
  submitFeedback: vi.fn(),
  claimEffectReceipt: vi.fn(),
  completeEffectReceipt: vi.fn(),
  releaseEffectReceipt: vi.fn(),
};

class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

vi.mock('../../search/jobs/service.js', () => ({
  JobsError: DomainError,
  jobSearchSchema: z.object({}).passthrough(),
  searchJobs: domain.searchJobs,
  getJobPostingById: domain.getJobPostingById,
  getJobPostingByUrl: vi.fn(),
  jobCorpusStats: vi.fn(),
}));
vi.mock('../../search/jobs/reports.js', () => ({
  JOB_REPORT_REASONS: ['scam', 'other'],
  jobReportSchema: z.object({ reason: z.enum(['scam', 'other']), detail: z.string().optional() }),
  reportJobPosting: domain.reportJobPosting,
}));
vi.mock('../../search/document-search.js', () => ({
  DOCUMENT_TYPES: ['page'],
  SEARCH_MODES: ['lexical', 'semantic', 'hybrid'],
  SearchError: DomainError,
  searchSchema: z.object({ query: z.string().min(1) }).passthrough(),
  searchIndex: domain.searchIndex,
  findDocument: vi.fn(),
  findDocumentByUrl: vi.fn(),
}));
vi.mock('../../lib/plan-access.js', () => ({ getUserEntitlements: domain.getUserEntitlements }));
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    users: { get: domain.usersGet },
    organizations: { get: domain.organizationsGet },
  },
}));
vi.mock('../../db/experience-repository.js', () => ({
  ExperienceAccountErasedError: class extends Error {},
  ExperienceLimitError: class extends Error {},
  createExperience: domain.createExperience,
  updateExperience: vi.fn(),
  deleteExperience: vi.fn(),
  listExperience: vi.fn(),
}));
vi.mock('../../lib/notification-service.js', () => ({
  markAsRead: domain.markAsRead,
  markAllAsRead: vi.fn(),
  dismissNotification: vi.fn(),
  getUnreadCount: vi.fn(),
}));
vi.mock('../../lib/feedback.js', () => ({
  FEEDBACK_TYPES: ['bug', 'feature', 'improvement', 'other'],
  submitFeedback: domain.submitFeedback,
  listFeedback: vi.fn(),
  findFeedback: vi.fn(),
}));
vi.mock('../../db/capability-receipt-repository.js', () => ({
  claimEffectReceipt: domain.claimEffectReceipt,
  completeEffectReceipt: domain.completeEffectReceipt,
  releaseEffectReceipt: domain.releaseEffectReceipt,
}));

const { CLARITY_CAPABILITY_CATALOG } = await import('../clarity.catalog.js');
const { CLARITY_INVOCATION_HANDLERS, effectiveAccountOf } = await import('../clarity.handlers.js');

const PERSON = 'person-1';

function oauthPrincipal(account: string) {
  return {
    kind: 'oauth' as const,
    subject: account,
    clientId: 'claude',
    originAccountId: account,
    activeAccountId: account,
    scopes: [],
    resource: 'https://mcp.clarity.surf',
  };
}

async function callTool(
  name: string,
  input: Record<string, unknown> = {},
  options: { idempotencyKey?: string; account?: string } = {},
) {
  const tool = CLARITY_CAPABILITY_CATALOG.tools.find((entry) => entry.name === name);
  const handler = CLARITY_INVOCATION_HANDLERS[name];
  if (!tool || !handler) throw new Error(`No catalogue tool named ${name}`);
  const headers: Record<string, string> = {};
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  const result = await handler(input, {
    appId: 'clarity',
    tool,
    principal: oauthPrincipal(options.account ?? PERSON),
    request: { requestInfo: { headers }, signal: new AbortController().signal },
  } as unknown as InvocationContext);
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  return {
    isError: result.isError === true,
    structured,
    error: structured.error as { code: string; status: number; message: string } | undefined,
  };
}

beforeEach(() => {
  for (const mock of Object.values(domain)) mock.mockReset();
  domain.claimEffectReceipt.mockResolvedValue({ kind: 'claimed', id: 'receipt-1' });
});

describe('the effective account', () => {
  it('is the ticket’s effective account on the internal lane and the active one on OAuth', () => {
    expect(
      effectiveAccountOf({
        kind: 'capability',
        claims: { resource: { effectiveAccountId: 'ticket-account' } },
      } as never),
    ).toBe('ticket-account');
    expect(effectiveAccountOf(oauthPrincipal('active-account') as never)).toBe('active-account');
  });
});

describe('refusals', () => {
  it('turn a domain refusal into an MCP error with the route’s code and status', async () => {
    domain.searchIndex.mockRejectedValue(
      new DomainError(503, 'semantic_unavailable', 'Semantic search is temporarily unavailable'),
    );
    const result = await callTool('search', { query: 'pixel', mode: 'semantic' });
    expect(result.isError).toBe(true);
    expect(result.error).toMatchObject({ code: 'semantic_unavailable', status: 503 });
  });

  it('never leak an unexpected error’s message', async () => {
    domain.searchIndex.mockRejectedValue(new Error('connection string postgres://secret'));
    const result = await callTool('search', { query: 'pixel' });
    expect(result.error).toEqual({
      code: 'internal_error',
      message: 'The tool failed unexpectedly.',
      status: 500,
    });
  });

  it('validate input with the route’s own schema', async () => {
    const result = await callTool('getMarketQuotes', { assets: ['https://evil.example'] });
    expect(result.error).toMatchObject({ code: 'invalid_request', status: 400 });
  });
});

describe('idempotency', () => {
  it('replays a completed receipt instead of running the effect again', async () => {
    domain.claimEffectReceipt.mockResolvedValue({ kind: 'replay', result: { success: true } });
    const result = await callTool(
      'markNotificationRead',
      { notificationId: 'n-1' },
      { idempotencyKey: 'k-1' },
    );
    expect(result.structured).toEqual({ success: true });
    expect(domain.markAsRead).not.toHaveBeenCalled();
  });

  it('stores the result of a first call, scoped to the effective account and tool', async () => {
    domain.markAsRead.mockResolvedValue(true);
    await callTool('markNotificationRead', { notificationId: 'n-1' }, { idempotencyKey: 'k-1' });
    expect(domain.claimEffectReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ oxyUserId: PERSON, tool: 'markNotificationRead' }),
    );
    expect(domain.claimEffectReceipt.mock.calls[0]?.[0]).not.toHaveProperty('idempotencyKey');
    expect(domain.completeEffectReceipt).toHaveBeenCalledWith('receipt-1', { success: true });
  });

  it('releases the claim of an effect that failed', async () => {
    domain.markAsRead.mockResolvedValue(false);
    const result = await callTool(
      'markNotificationRead',
      { notificationId: 'n-1' },
      { idempotencyKey: 'k-1' },
    );
    expect(result.error).toMatchObject({ code: 'notification_not_found', status: 404 });
    expect(domain.releaseEffectReceipt).toHaveBeenCalledWith('receipt-1');
  });

  it('refuses a key reused with different input', async () => {
    domain.claimEffectReceipt.mockResolvedValue({ kind: 'input_mismatch' });
    const result = await callTool(
      'markNotificationRead',
      { notificationId: 'n-2' },
      { idempotencyKey: 'k-1' },
    );
    expect(result.error).toMatchObject({ code: 'idempotency_key_reused', status: 422 });
  });
});

describe('Jobs', () => {
  it('searches without ever passing who asked', async () => {
    domain.searchJobs.mockResolvedValue({ data: [], total: 0 });
    await callTool('searchJobs', { query: 'react native', locations: ['ES'] });
    expect(domain.searchJobs).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(domain.searchJobs.mock.calls[0])).not.toContain(PERSON);
  });

  it('records a report without a reporter identity, and answers not-found for an unknown job', async () => {
    domain.reportJobPosting.mockResolvedValue(true);
    expect((await callTool('reportJob', { jobId: 'job-1', reason: 'scam' })).structured).toEqual({
      status: 'received',
    });
    expect(domain.reportJobPosting).toHaveBeenCalledWith('job-1', { reason: 'scam' });

    domain.reportJobPosting.mockResolvedValue(false);
    expect((await callTool('reportJob', { jobId: 'gone', reason: 'scam' })).error).toMatchObject({
      code: 'job_not_found',
      status: 404,
    });
  });
});

describe('experience', () => {
  const entry = {
    title: 'Designer',
    employerOxyAccountId: 'org-1',
    startDate: '2022-10',
    endDate: null,
  };

  it('is refused for an account that is not personal', async () => {
    domain.usersGet.mockResolvedValue({ kind: 'organization' });
    const result = await callTool('addExperience', entry);
    expect(result.error).toMatchObject({ code: 'forbidden', status: 403 });
    expect(domain.createExperience).not.toHaveBeenCalled();
  });

  it('stores an entry for the effective account under the employer Oxy resolves', async () => {
    domain.usersGet.mockResolvedValue({ kind: 'personal' });
    domain.organizationsGet.mockResolvedValue({ status: 'active', accountId: 'org-canonical' });
    domain.createExperience.mockResolvedValue({ id: 'e-1', ...entry });
    await callTool('addExperience', entry);
    expect(domain.createExperience).toHaveBeenCalledWith(PERSON, {
      ...entry,
      employerOxyAccountId: 'org-canonical',
    });
  });
});

describe('feedback', () => {
  it('is sent as the effective account', async () => {
    domain.submitFeedback.mockResolvedValue({ id: 'f-1' });
    await callTool('submitFeedback', { type: 'bug', message: 'The map is blank' });
    expect(domain.submitFeedback).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ type: 'bug', message: 'The map is blank' }),
    );
  });
});

describe('feature gates', () => {
  it.each([
    ['checkDeepResearch', { 'deep-research': true }, true],
    ['checkDeepResearch', { 'deep-research': 3 }, false],
    ['checkDeepResearch', {}, false],
    ['checkPowerLevelPro', { 'power-level-pro': true }, true],
    ['checkPowerLevelUltra', { 'power-level-pro': true }, false],
  ] as const)('%s with %j answers available=%s', async (tool, features, available) => {
    domain.getUserEntitlements.mockResolvedValue({ features, planId: 'free' });
    expect((await callTool(tool)).structured).toEqual({ available });
    expect(domain.getUserEntitlements).toHaveBeenCalledWith(PERSON);
  });
});
