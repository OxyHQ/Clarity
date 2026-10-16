import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ZodSafeParseResult } from 'zod';
import {
  type ExperienceValidation,
  validateExperience,
  validateExperienceInput,
  validateExperienceList,
} from '../src/experience.js';
import {
  experienceInputSchema,
  experienceListSchema,
  experienceSchema,
} from './experienceReferenceSchema.js';

const input = {
  title: 'Designer',
  employerOxyAccountId: 'organization-apple',
  startDate: '2022-10',
  endDate: null,
};
const stored = {
  ...input,
  id: 'id',
  oxyUserId: 'owner',
  createdAt: '2022-10-01T00:00:00Z',
  updatedAt: '2022-10-01T00:00:00.123Z',
};

/** Shapes a client or a server can plausibly send, valid and not. */
function variants(base: Record<string, unknown>): unknown[] {
  const patches: Record<string, unknown>[] = [
    {},
    { title: '  Designer  ' },
    { title: ' ' },
    { title: '' },
    { title: 'x'.repeat(200) },
    { title: ` ${'x'.repeat(200)} ` },
    { title: 'x'.repeat(201) },
    { title: 5 },
    { title: undefined },
    { employerOxyAccountId: '' },
    { employerOxyAccountId: 'x'.repeat(129) },
    { employerOxyAccountId: null },
    { employmentType: 'full-time' },
    { employmentType: 'seasonal' },
    { employmentType: null },
    { employmentType: undefined },
    { employmentType: 'gig' },
    { employmentType: 1 },
    { location: ' Barcelona ' },
    { location: null },
    { location: '' },
    { location: '   ' },
    { location: 'x'.repeat(300) },
    { location: 'x'.repeat(301) },
    { location: 3 },
    { description: 'Shipped things.' },
    { description: 'x'.repeat(5001) },
    { description: null },
    { startDate: '2022-00' },
    { startDate: '2022-13' },
    { startDate: '22-01' },
    { startDate: '2022-1' },
    { startDate: '2022-01-01' },
    { startDate: '1899-12' },
    { startDate: '1900-01' },
    { startDate: '2099-01' },
    { startDate: null },
    { startDate: undefined },
    { endDate: '2022-10' },
    { endDate: '2023-01' },
    { endDate: '2021-01' },
    { endDate: '2022-13' },
    { endDate: undefined },
    { endDate: '2021-01', title: '' },
    { startDate: '2022-13', endDate: '2021-01' },
    { extra: true },
    { id: 'chosen-id' },
    { oxyUserId: 'another-user' },
  ];
  const omitted = Object.keys(base).map((key) => {
    const { [key]: _, ...rest } = base;
    return rest;
  });
  return [
    ...patches.map((patch) => ({ ...base, ...patch })),
    ...omitted,
    null,
    'entry',
    42,
    [],
    [base],
  ];
}

/** The API answers 400 for a malformed body and 422 for values to correct (routes/experience.ts). */
const malformed = (codes: string[]) =>
  codes.some((code) => code === 'invalid_type' || code === 'unrecognized_keys');

function sameAnswer(plain: ExperienceValidation<unknown>, zod: ZodSafeParseResult<unknown>) {
  expect(plain.success).toBe(zod.success);
  if (plain.success && zod.success) expect(plain.data).toStrictEqual(zod.data);
  if (!plain.success && !zod.success) {
    expect(malformed(plain.issues.map((issue) => issue.code))).toBe(
      malformed(zod.error.issues.map((issue) => issue.code)),
    );
  }
}

describe('plain Experience checks answer as the 0.5.0 Zod schemas did', () => {
  it.each(variants(input).map((value) => [JSON.stringify(value), value]))(
    'input %s',
    (_, value) => {
      sameAnswer(validateExperienceInput(value), experienceInputSchema.safeParse(value));
    },
  );

  const datetimes = [
    '2022-10-01T00:00:00Z',
    '2022-10-01T00:00:00.1Z',
    '2022-10-01T00:00:00.123456789Z',
    '2024-02-29T23:59:59Z',
    '2023-02-29T00:00:00Z',
    '2022-04-31T00:00:00Z',
    '2022-13-01T00:00:00Z',
    '2022-00-01T00:00:00Z',
    '2022-10-00T00:00:00Z',
    '2022-10-01T24:00:00Z',
    '2022-10-01T23:60:00Z',
    '2022-10-01T23:59:60Z',
    '2022-10-01T00:00Z',
    '2022-10-01T00:00:00',
    '2022-10-01T00:00:00+02:00',
    '2022-10-01 00:00:00Z',
    '2022-10-01T00:00:00.Z',
    '',
    1665000000000,
  ];
  const resources = [
    ...variants(stored),
    ...datetimes.flatMap((value) => [
      { ...stored, createdAt: value },
      { ...stored, updatedAt: value },
    ]),
    { ...stored, id: '' },
    { ...stored, oxyUserId: 7 },
    // A stored row is not re-checked against the write-time rules.
    { ...stored, startDate: '2099-01', endDate: '2021-01' },
  ];
  it.each(resources.map((value) => [JSON.stringify(value), value]))('stored %s', (_, value) => {
    sameAnswer(validateExperience(value), experienceSchema.safeParse(value));
  });

  it.each(
    [
      { items: [], nextCursor: null },
      { items: [stored, { ...stored, id: 'id-2', title: ' trimmed ' }], nextCursor: null },
      {
        items: Array.from({ length: 100 }, (_, index) => ({ ...stored, id: `id-${index}` })),
        nextCursor: null,
      },
      {
        items: Array.from({ length: 101 }, (_, index) => ({ ...stored, id: `id-${index}` })),
        nextCursor: null,
      },
      { items: [{ title: 'untrusted' }], nextCursor: null },
      { items: [], nextCursor: 'next' },
      { items: [] },
      { items: {}, nextCursor: null },
      { items: [], nextCursor: null, total: 0 },
      [],
      null,
    ].map((value) => [JSON.stringify(value).slice(0, 120), value]),
  )('list %s', (_, value) => {
    sameAnswer(validateExperienceList(value), experienceListSchema.safeParse(value));
  });

  it('points at the fields a person has to fix', () => {
    const result = validateExperienceInput({ ...input, title: ' ', endDate: '2021-01' });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.issues.map((issue) => issue.path[0])).toEqual(['title', 'endDate']);
  });
});

describe('the SDK carries no schema library', () => {
  it('imports zod nowhere and does not depend on it at runtime', () => {
    const source = new URL('../src/', import.meta.url);
    const importers = readdirSync(source).filter((file) =>
      /from ['"]zod/.test(readFileSync(new URL(file, source), 'utf8')),
    );
    expect(importers).toEqual([]);
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.dependencies?.zod).toBeUndefined();
  });
});
