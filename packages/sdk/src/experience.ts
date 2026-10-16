/**
 * The Experience contract, checked in plain TypeScript: the API's request
 * validation and every client's response checks run this one implementation,
 * and a browser bundle that reads or edits work history downloads no schema
 * library. `tests/experience-parity.test.ts` holds it to the Zod 4 schema it
 * replaced (0.5.0), answer for answer.
 */

/** Personal career history is separate from public job listings and their taxonomy. */
export const EXPERIENCE_EMPLOYMENT_TYPES = [
  'full-time',
  'part-time',
  'self-employed',
  'freelance',
  'contract',
  'internship',
  'apprenticeship',
  'seasonal',
] as const;
export type ExperienceEmploymentType = (typeof EXPERIENCE_EMPLOYMENT_TYPES)[number];

export const EXPERIENCE_MAX_ENTRIES = 100;
export const EXPERIENCE_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'unknown_route',
  'gone',
  'experience_limit_reached',
  'invalid_employer',
  'conflict',
  'validation_failed',
  'rate_limited',
  'internal_error',
  'service_unavailable',
] as const;
export type ExperienceErrorCode = (typeof EXPERIENCE_ERROR_CODES)[number];

export const EXPERIENCE_LIMITS = {
  title: 200,
  employerOxyAccountId: 128,
  location: 300,
  description: 5000,
} as const;
const MONTH = /^(19|20)\d{2}-(0[1-9]|1[0-2])$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?Z$/;

/** Every field submitted here is published on the user's public profile. */
export interface ExperienceInput {
  title: string;
  employerOxyAccountId: string;
  employmentType?: ExperienceEmploymentType | null;
  location?: string | null;
  /** `YYYY-MM`, not in the future. */
  startDate: string;
  /** `YYYY-MM`, not before `startDate`; `null` for a current role. */
  endDate: string | null;
  description?: string | null;
}
export interface Experience extends ExperienceInput {
  id: string;
  oxyUserId: string;
  createdAt: string;
  updatedAt: string;
}
export interface ExperienceList {
  items: Experience[];
  nextCursor: null;
}

export interface ExperienceIssue {
  /**
   * `invalid_type` and `unrecognized_keys` mean a malformed body (a missing
   * field, a wrong type, a key the contract does not have); `invalid_value` is
   * a well-formed value a person has to correct.
   */
  code: 'invalid_type' | 'unrecognized_keys' | 'invalid_value';
  /** The offending field, e.g. `['endDate']` or `['items', 0, 'title']`; empty for the whole value. */
  path: (string | number)[];
  message: string;
}
/** Both arms name both fields so a consumer compiled without strictNullChecks still narrows. */
export type ExperienceValidation<T> =
  | { success: true; data: T; issues?: undefined }
  | { success: false; data?: undefined; issues: ExperienceIssue[] };

type Path = (string | number)[];
type Fields = Record<string, unknown>;

const INPUT_KEYS = [
  'title',
  'employerOxyAccountId',
  'employmentType',
  'location',
  'startDate',
  'endDate',
  'description',
] as const;
const RESOURCE_KEYS = [...INPUT_KEYS, 'id', 'oxyUserId', 'createdAt', 'updatedAt'] as const;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record with only `keys`, else an issue; the shape every contract object shares. */
function strictRecord(
  value: unknown,
  keys: readonly string[],
  path: Path,
  issues: ExperienceIssue[],
): Fields | null {
  if (!isRecord(value)) {
    issues.push({ code: 'invalid_type', path, message: 'Expected an object' });
    return null;
  }
  const unknownKeys = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknownKeys.length > 0) {
    issues.push({
      code: 'unrecognized_keys',
      path,
      message: `Unrecognized keys: ${unknownKeys.join(', ')}`,
    });
  }
  return value;
}

/** A string matching `valid`, else an issue; `invalid_type` when it is not a string at all. */
function string(
  source: Fields,
  key: string,
  valid: (value: string) => boolean,
  message: string,
  path: Path,
  issues: ExperienceIssue[],
): boolean {
  const value = source[key];
  if (typeof value !== 'string') {
    issues.push({ code: 'invalid_type', path: [...path, key], message: 'Expected a string' });
    return false;
  }
  if (!valid(value)) {
    issues.push({ code: 'invalid_value', path: [...path, key], message });
    return false;
  }
  return true;
}

function text(source: Fields, key: string, max: number, path: Path, issues: ExperienceIssue[]) {
  const ok = string(
    source,
    key,
    (value) => value.trim().length >= 1 && value.trim().length <= max,
    `Use 1–${max} characters`,
    path,
    issues,
  );
  return ok ? (source[key] as string).trim() : undefined;
}

/** `null`, absent, or text; a key that is present stays present, as it is stored. */
function optionalText(
  source: Fields,
  out: Fields,
  key: string,
  max: number,
  path: Path,
  issues: ExperienceIssue[],
): void {
  if (!(key in source)) return;
  const value = source[key];
  out[key] = value === undefined || value === null ? value : text(source, key, max, path, issues);
}

function month(source: Fields, key: string, path: Path, issues: ExperienceIssue[]) {
  const ok = string(source, key, (value) => MONTH.test(value), 'Use YYYY-MM', path, issues);
  return ok ? (source[key] as string) : undefined;
}

function isCalendarDatetime(value: string): boolean {
  const match = ISO_DATETIME.exec(value);
  if (!match) return false;
  const [year, monthNumber, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return monthNumber >= 1 && monthNumber <= 12 && day >= 1 && day <= daysInMonth;
}

/** The fields an entry and a stored row share, trimmed exactly as stored. */
function fields(source: Fields, path: Path, issues: ExperienceIssue[]): Fields {
  const out: Fields = {
    title: text(source, 'title', EXPERIENCE_LIMITS.title, path, issues),
    employerOxyAccountId: text(
      source,
      'employerOxyAccountId',
      EXPERIENCE_LIMITS.employerOxyAccountId,
      path,
      issues,
    ),
  };
  if ('employmentType' in source) {
    const employmentType = source.employmentType;
    if (
      employmentType != null &&
      !(EXPERIENCE_EMPLOYMENT_TYPES as readonly unknown[]).includes(employmentType)
    ) {
      issues.push({
        code: 'invalid_value',
        path: [...path, 'employmentType'],
        message: `Use one of ${EXPERIENCE_EMPLOYMENT_TYPES.join(', ')}`,
      });
    }
    out.employmentType = employmentType;
  }
  optionalText(source, out, 'location', EXPERIENCE_LIMITS.location, path, issues);
  out.startDate = month(source, 'startDate', path, issues);
  out.endDate = source.endDate === null ? null : month(source, 'endDate', path, issues);
  optionalText(source, out, 'description', EXPERIENCE_LIMITS.description, path, issues);
  return out;
}

function resource(value: unknown, path: Path, issues: ExperienceIssue[]): Fields {
  const source = strictRecord(value, RESOURCE_KEYS, path, issues);
  if (!source) return {};
  const out = fields(source, path, issues);
  for (const key of ['id', 'oxyUserId'] as const) {
    string(source, key, (id) => id.length > 0, 'Expected a non-empty string', path, issues);
    out[key] = source[key];
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    string(source, key, isCalendarDatetime, 'Expected an ISO 8601 UTC datetime', path, issues);
    out[key] = source[key];
  }
  return out;
}

function result<T>(data: Fields, issues: ExperienceIssue[]): ExperienceValidation<T> {
  return issues.length > 0 ? { success: false, issues } : { success: true, data: data as T };
}

/**
 * Checks an entry the way Clarity checks a write, returning it trimmed as it
 * will be stored. A period may not end before it starts or start in the future.
 */
export function validateExperienceInput(value: unknown): ExperienceValidation<ExperienceInput> {
  const issues: ExperienceIssue[] = [];
  const source = strictRecord(value, INPUT_KEYS, [], issues);
  if (!source) return { success: false, issues };
  const out = fields(source, [], issues);
  const { startDate, endDate } = out;
  if (typeof startDate === 'string' && typeof endDate === 'string' && endDate < startDate) {
    issues.push({
      code: 'invalid_value',
      path: ['endDate'],
      message: 'End date must not precede start date',
    });
  }
  if (typeof startDate === 'string' && startDate > new Date().toISOString().slice(0, 7)) {
    issues.push({
      code: 'invalid_value',
      path: ['startDate'],
      message: 'Start date must not be in the future',
    });
  }
  return result(out, issues);
}

/** Checks one stored entry as Clarity returns it; write-time date rules are not re-applied. */
export function validateExperience(value: unknown): ExperienceValidation<Experience> {
  const issues: ExperienceIssue[] = [];
  return result(resource(value, [], issues), issues);
}

/** Checks a profile's history as Clarity returns it: at most 100 entries, one page. */
export function validateExperienceList(value: unknown): ExperienceValidation<ExperienceList> {
  const issues: ExperienceIssue[] = [];
  const source = strictRecord(value, ['items', 'nextCursor'], [], issues);
  if (!source) return { success: false, issues };
  const items = source.items;
  if (!Array.isArray(items)) {
    issues.push({ code: 'invalid_type', path: ['items'], message: 'Expected an array' });
  } else if (items.length > EXPERIENCE_MAX_ENTRIES) {
    issues.push({
      code: 'invalid_value',
      path: ['items'],
      message: `Expected at most ${EXPERIENCE_MAX_ENTRIES} entries`,
    });
  }
  if (source.nextCursor !== null) {
    issues.push({ code: 'invalid_type', path: ['nextCursor'], message: 'Expected null' });
  }
  const parsed = Array.isArray(items)
    ? items.map((item, index) => resource(item, ['items', index], issues))
    : [];
  return result({ items: parsed, nextCursor: null }, issues);
}
