// The Zod 4 contract as released in @clarity.surf/sdk 0.5.0, frozen as the
// reference src/experience.ts must keep answering exactly like. Do not edit to
// make a test pass: a changed contract changes both, deliberately.
import { z } from 'zod';

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

const month = z.string().regex(/^(19|20)\d{2}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

/** Every field submitted here is published on the user's public profile. */
const experienceFields = z.strictObject({
  title: z.string().trim().min(1).max(200),
  employerOxyAccountId: z.string().trim().min(1).max(128),
  employmentType: z.enum(EXPERIENCE_EMPLOYMENT_TYPES).nullable().optional(),
  location: optionalText(300),
  startDate: month,
  endDate: month.nullable(),
  description: optionalText(5000),
});

export const experienceInputSchema = experienceFields.superRefine((entry, ctx) => {
  if (entry.endDate !== null && entry.endDate < entry.startDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'End date must not precede start date',
    });
  }
  if (entry.startDate > new Date().toISOString().slice(0, 7)) {
    ctx.addIssue({
      code: 'custom',
      path: ['startDate'],
      message: 'Start date must not be in the future',
    });
  }
});

export const experienceSchema = experienceFields.extend({
  id: z.string().min(1),
  oxyUserId: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const EXPERIENCE_MAX_ENTRIES = 100;
export const experienceListSchema = z.strictObject({
  items: z.array(experienceSchema).max(EXPERIENCE_MAX_ENTRIES),
  nextCursor: z.null(),
});
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
export const experienceErrorSchema = z.object({
  error: z.object({
    code: z.enum(EXPERIENCE_ERROR_CODES),
    message: z.string(),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  }),
});
export type ExperienceInput = z.infer<typeof experienceInputSchema>;
export type Experience = z.infer<typeof experienceSchema>;
export type ExperienceList = z.infer<typeof experienceListSchema>;
export type ExperienceErrorCode = z.infer<typeof experienceErrorSchema>['error']['code'];
