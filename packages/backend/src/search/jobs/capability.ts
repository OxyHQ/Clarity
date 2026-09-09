/**
 * The structured Jobs capability Clarity publishes for its Alia agent.
 *
 * An agent answering "find remote React Native jobs in Europe posted this week"
 * calls this tool and reports the normalized fields it returns. Employment
 * facts must come from the projection, never from prose in a snippet: a field
 * absent from the result was not stated by the source, and the agent must say
 * so rather than fill it in.
 */
import { JOB_RANKING_SIGNALS } from './ranking-contract.js';
import { JOB_STALE_AFTER_DAYS } from './lifecycle.js';
import {
  JOB_EMPLOYMENT_TYPES, JOB_LIFECYCLE_STATUSES, JOB_REGIONS, JOB_SALARY_INTERVALS, JOB_WORKPLACE_TYPES,
} from './taxonomy.js';

export const CLARITY_JOBS_CAPABILITY = {
  name: 'clarity_jobs_search',
  description:
    'Search public job postings indexed by Clarity. Returns normalized employment fields (employer, locations, workplace type, employment types, salary when the source stated one, publication date and canonical source). Use it instead of reading job facts out of generic web snippets.',
  endpoint: { method: 'POST', path: '/v1/jobs/search', scope: 'clarity:search' },
  grounding: {
    factualLayer: 'clarity_jobs_projection',
    absentFieldPolicy: 'A field missing from a result was not stated by the source. Never infer it.',
    attribution: 'Always show source.canonicalUrl. Clarity indexed the listing; it is not the employer.',
    staleAfterDays: JOB_STALE_AFTER_DAYS,
  },
  ranking: { signals: JOB_RANKING_SIGNALS, commercialSignals: 'none' },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', maxLength: 500, description: 'Free-text role description. Omit to browse by filters alone.' },
      mode: { type: 'string', enum: ['lexical', 'semantic', 'hybrid'], default: 'hybrid' },
      locations: {
        type: 'array', maxItems: 20, items: { type: 'string', maxLength: 120 },
        description: `Country name or ISO code, city/region name, or a macro-region: ${Object.keys(JOB_REGIONS).join(', ')}.`,
      },
      workplaceTypes: { type: 'array', items: { type: 'string', enum: [...JOB_WORKPLACE_TYPES] } },
      employmentTypes: { type: 'array', items: { type: 'string', enum: [...JOB_EMPLOYMENT_TYPES] } },
      employers: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 }, description: 'Employer name or employer domain.' },
      sourceDomains: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 253 } },
      skills: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } },
      salary: {
        type: 'object', additionalProperties: false,
        properties: {
          min: { type: 'number', minimum: 0 },
          max: { type: 'number', minimum: 0 },
          currency: { type: 'string', pattern: '^[A-Za-z]{3}$', description: 'ISO 4217. Clarity never converts currencies.' },
          interval: { type: 'string', enum: [...JOB_SALARY_INTERVALS], default: 'year' },
        },
      },
      publishedAfter: { type: 'string', format: 'date-time' },
      publishedBefore: { type: 'string', format: 'date-time' },
      statuses: {
        type: 'array', items: { type: 'string', enum: [...JOB_LIFECYCLE_STATUSES] },
        description: 'Defaults to active only. Expired and closed listings are never implied.',
      },
      includeDuplicates: { type: 'boolean', default: false, description: 'Return every syndicated copy instead of one grouped result.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      cursor: { type: 'string' },
    },
  },
} as const;
