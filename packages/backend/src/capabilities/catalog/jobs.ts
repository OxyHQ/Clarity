import type { CatalogTool } from '@oxy.so/contracts';

import {
  JOB_FEED_STALE_AFTER_DAYS,
  JOB_RETENTION_DAYS,
  JOB_STALE_AFTER_DAYS,
} from '../../search/jobs/lifecycle.js';
import { JOB_RANKING_SIGNALS } from '../../search/jobs/ranking-contract.js';
import { JOB_REPORT_REASONS } from '../../search/jobs/reports.js';
import {
  CURRENCY_CODES,
  JOB_EMPLOYMENT_TYPES,
  JOB_LIFECYCLE_STATUSES,
  JOB_REGIONS,
  JOB_SALARY_INTERVALS,
  JOB_SENIORITY_LEVELS,
  JOB_WORKPLACE_TYPES,
} from '../../search/jobs/taxonomy.js';
import {
  actTool,
  enumInput,
  idInput,
  objectInput,
  optionalTextInput,
  readTool,
  urlInput,
} from './define.js';

/**
 * How a job answer is grounded. Employment facts come from the projection,
 * never from prose in a snippet: a field absent from a result was not stated by
 * the source, and the agent must say so rather than fill it in.
 */
const GROUNDING = [
  'A field missing from a result was not stated by the source: never infer it.',
  'Always show source.canonicalUrl: Clarity indexed the listing, it is not the employer.',
  `A listing is stale after ${JOB_STALE_AFTER_DAYS} days without confirmation (${JOB_FEED_STALE_AFTER_DAYS} for feed listings) and gone after ${JOB_RETENTION_DAYS}.`,
  'locations[].countryCode is ISO 3166-1 alpha-2; locations[].placeId, when present, is a GeoNames id (getPlace). A location without placeId was not matched to a single place.',
  'description, qualifications, responsibilities, educationRequirements, experienceRequirements and benefits are Markdown; every other text field is plain text.',
  `Ranking uses only ${JOB_RANKING_SIGNALS.join(', ')}; no commercial signal of any kind.`,
].join(' ');

/**
 * Clarity Jobs: PUBLIC job postings Clarity indexed. Nothing here records who
 * searched, viewed or reported — the handlers never pass the effective account
 * to the jobs module — so using these tools never discloses a named person to
 * an employer (AGENTS.md, Jobs).
 */
export const JOB_TOOLS: readonly CatalogTool[] = [
  readTool({
    name: 'searchJobs',
    description: `Search public job postings indexed by Clarity. Returns normalized employment fields (employer, locations, workplace type, employment types, salary when the source stated one, publication date and canonical source). Use it instead of reading job facts out of web snippets. ${GROUNDING}`,
    capability: 'jobs.read',
    input: objectInput({
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Free-text role description. Omit to browse by filters alone.',
      },
      mode: { ...enumInput(['lexical', 'semantic', 'hybrid']), default: 'hybrid' },
      locations: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 120 },
        description: `Country name or ISO 3166-1 alpha-2 code, city/region name, or a macro-region: ${Object.keys(JOB_REGIONS).join(', ')}. A value that is not a country or region matches city and region names as text.`,
      },
      workplaceTypes: { type: 'array', items: enumInput(JOB_WORKPLACE_TYPES) },
      employmentTypes: { type: 'array', items: enumInput(JOB_EMPLOYMENT_TYPES) },
      seniorities: {
        type: 'array',
        items: enumInput(JOB_SENIORITY_LEVELS),
        description:
          'Career level as the listing states it. Listings that state no level are excluded when this is set.',
      },
      employers: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 200 },
        description: 'Employer name or employer domain.',
      },
      sourceDomains: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 253 } },
      skills: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 80 },
      },
      salary: {
        type: 'object',
        additionalProperties: false,
        properties: {
          min: { type: 'number', minimum: 0 },
          max: { type: 'number', minimum: 0 },
          currency: {
            ...enumInput(CURRENCY_CODES),
            description: 'Active ISO 4217 code. Clarity never converts currencies.',
          },
          interval: { ...enumInput(JOB_SALARY_INTERVALS), default: 'year' },
        },
      },
      publishedAfter: { type: 'string', format: 'date-time' },
      publishedBefore: { type: 'string', format: 'date-time' },
      statuses: {
        type: 'array',
        minItems: 1,
        items: enumInput(JOB_LIFECYCLE_STATUSES),
        description: 'Defaults to active only. Expired and closed listings are never implied.',
      },
      includeDuplicates: {
        type: 'boolean',
        default: false,
        description: 'Return every syndicated copy instead of one grouped result.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      cursor: { type: 'string', maxLength: 512 },
    }),
  }),
  readTool({
    name: 'getJob',
    description: `Read one job posting by its Clarity id, with its full description. ${GROUNDING}`,
    capability: 'jobs.read',
    input: objectInput({ jobId: idInput }, ['jobId']),
  }),
  readTool({
    name: 'getJobByUrl',
    description:
      'Read the job posting Clarity has indexed for a listing URL. Answers not-found when Clarity has not indexed it.',
    capability: 'jobs.read',
    input: objectInput({ url: urlInput }, ['url']),
  }),
  readTool({
    name: 'getJobStats',
    description:
      'What Clarity Jobs holds right now: active listings, listings by status and source type, how many state a salary, and how many are grouped duplicates. For questions about the corpus itself, not about a role.',
    capability: 'jobs.read',
    input: objectInput({}),
  }),
  actTool({
    name: 'reportJob',
    description:
      'Report a job posting to Clarity (a scam, already filled, a duplicate, misleading or discriminatory). Reports are anonymous — no reporter identity is stored — and never change ranking.',
    capability: 'jobs.report',
    capabilityPackage: 'communicate',
    input: objectInput(
      {
        jobId: idInput,
        reason: enumInput(JOB_REPORT_REASONS),
        detail: optionalTextInput(1_000),
      },
      ['jobId', 'reason'],
    ),
  }),
];
