import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { jobClusters, jobPostingSignatures, jobPostings } from '../../../db/schema/index.js';
import { JOB_FORBIDDEN_RANKING_SIGNALS, JOB_RANKING_SIGNALS } from '../ranking-contract.js';

const jobsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendSource = resolve(jobsDirectory, '..', '..');

/**
 * Files that produce or constrain job ranking. `ranking-contract.ts` is the
 * declaration of what is forbidden, so it names the forbidden things and is
 * deliberately not scanned.
 */
function rankingSources(): string[] {
  return readdirSync(jobsDirectory)
    .filter((entry) => entry.endsWith('.ts') && entry !== 'ranking-contract.ts')
    .map((entry) => join(jobsDirectory, entry))
    .filter((file) => statSync(file).isFile());
}

/** Comments state the policy; only executable code can violate it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const COMMERCIAL_TOKENS = [
  'stripe', 'billing', 'subscription', 'invoice', 'payment', 'checkout', 'coupon',
  'plans', 'planId', 'planSnapshot', 'entitlement', 'credit', 'tier', 'sponsor',
  'promoted', 'advertis', 'adSpend', 'mercaria', 'monetiz', 'boostAmount', 'bid',
];

const IDENTITY_TOKENS = ['oxyUserId', 'req.user', 'delegatedUserId', 'sessionId', 'viewerId', 'X-Oxy-User-Id'];

/** Matches a token only where an identifier could actually start. */
function mentions(source: string, token: string): boolean {
  return new RegExp(`(^|[^A-Za-z])${token}`, 'i').test(source);
}

describe('Clarity Jobs ranking contract', () => {
  it('states exactly the permitted ranking signals', () => {
    expect([...JOB_RANKING_SIGNALS]).toEqual([
      'lexical_relevance',
      'semantic_relevance',
      'freshness',
      'listing_completeness',
      'duplicate_suppression',
    ]);
    expect([...JOB_FORBIDDEN_RANKING_SIGNALS]).toEqual([
      'employer_payment',
      'subscription_tier',
      'advertising_spend',
      'commercial_licensing_tier',
      'mercaria_activity',
      'mention_engagement',
      'applicant_behaviour',
      'inferred_sensitive_traits',
    ]);
    for (const signal of JOB_FORBIDDEN_RANKING_SIGNALS) {
      expect(JOB_RANKING_SIGNALS as readonly string[]).not.toContain(signal);
    }
  });

  it('keeps every commercial token out of the ranking modules', () => {
    for (const file of rankingSources()) {
      const source = code(file);
      for (const token of COMMERCIAL_TOKENS) {
        expect(mentions(source, token), `${file} references ${token}`).toBe(false);
      }
    }
  });

  it('lets each jobs module reach only the tables its job requires', () => {
    // Per file, not a shared pool: widening one module must be a deliberate
    // edit here. A file absent from this map may reach no table at all.
    const allowedTables: Readonly<Record<string, readonly string[]>> = {
      'service.ts': ['jobPostings', 'jobClusters', 'searchChunks', 'searchDocuments'],
      'projection.ts': ['jobClusters', 'jobPostings', 'jobPostingSignatures', 'searchDocuments'],
      'lifecycle.ts': ['jobPostings', 'searchDocuments'],
      'reports.ts': ['jobPostings', 'jobReports'],
    };
    for (const file of rankingSources()) {
      const source = code(file);
      const schemaImport = /import\s*\{([^}]*)\}\s*from\s*'[^']*db\/schema\/index\.js'/.exec(source);
      if (!schemaImport) continue;
      const name = file.slice(file.lastIndexOf('/') + 1);
      const imported = schemaImport[1].split(',').map((entry) => entry.trim()).filter(Boolean);
      for (const table of imported) {
        expect(allowedTables[name] ?? [], `${name} imports table ${table}`).toContain(table);
      }
    }
  });

  it('keeps reader reports out of ranking entirely', () => {
    const service = code(join(jobsDirectory, 'service.ts'));
    expect(service).not.toMatch(/report/i);
    expect(service).not.toContain('jobReports');
  });

  it('never joins a product table into a job query', () => {
    const forbiddenTables = [
      'clarity_subscriptions', 'clarity_plans', 'clarity_plan_features', 'clarity_billing_customers',
      'clarity_credit_packages', 'clarity_features', 'clarity_conversations', 'clarity_messages',
    ];
    for (const file of rankingSources()) {
      const source = code(file);
      for (const table of forbiddenTables) {
        expect(source, `${file} references ${table}`).not.toContain(table);
      }
    }
  });

  it('gives the job projection no column able to express a commercial relationship', () => {
    for (const table of [jobPostings, jobClusters, jobPostingSignatures]) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        for (const token of COMMERCIAL_TOKENS) {
          expect(mentions(column.name, token), `${config.name}.${column.name}`).toBe(false);
        }
      }
    }
  });

  it('carries no viewer identity into job search or the public jobs surface', () => {
    const surfaces = [
      ...rankingSources(),
      join(backendSource, 'routes', 'jobs.ts'),
    ];
    for (const file of surfaces) {
      const source = code(file);
      for (const token of IDENTITY_TOKENS) {
        expect(source, `${file} references ${token}`).not.toContain(token);
      }
    }
  });

  it('gives the public jobs surface no write path into the corpus', () => {
    const source = code(join(backendSource, 'routes', 'jobs.ts'));
    expect(source).not.toMatch(/\.(insert|update|delete)\(/);
    expect(source).not.toContain('ingestJobPosting');
    expect(source).not.toContain('projectJobPostings');
  });

  it('reserves /v1/jobs for employment and /v1/operations for crawl work', () => {
    const platform = readFileSync(join(backendSource, 'routes', 'v1', 'search-platform.ts'), 'utf8');
    expect(platform).toContain("router.get('/operations/:id'");
    expect(platform).toContain("router.post('/operations/:id/cancel'");
    expect(platform).not.toMatch(/router\.(get|post)\('\/jobs\/:id\/cancel'/);
    expect(platform).toContain("router.post('/jobs/search'");
    const sdk = readFileSync(resolve(backendSource, '..', '..', 'sdk', 'src', 'client.ts'), 'utf8');
    expect(sdk).toContain('readonly operations = {');
    expect(sdk).toContain("this.request<JobSearchResponse>('POST', '/v1/jobs/search'");
    expect(sdk).not.toMatch(/IndexOperation>\('GET', `\/v1\/jobs\//);
  });
});
