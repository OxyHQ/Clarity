/**
 * The person's published work history — the checks the `/api/experience`
 * routes and the catalogue's experience tools share, so a tool refuses exactly
 * what the route refuses: a non-personal account, an employer that is not an
 * available Oxy organization, an invalid entry, a full profile, an erased one.
 */
import { getErrorStatus } from '@oxy.so/core';
import {
  type ExperienceErrorCode,
  type ExperienceInput,
  validateExperienceInput,
} from '@clarity.surf/sdk/experience';

import { ExperienceAccountErasedError, ExperienceLimitError } from '../db/experience-repository.js';
import { oxyClient } from '../middleware/auth.js';

export class ExperienceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ExperienceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Experience belongs to personal accounts; `kind` is the session's when it carries one. */
export async function requirePersonalAccount(userId: string, kind?: string): Promise<void> {
  const accountKind = kind ?? (await oxyClient.users.get(userId, { cache: false })).kind;
  if (accountKind !== 'personal') {
    throw new ExperienceError(403, 'forbidden', 'Experience belongs to personal accounts');
  }
}

/** A submitted entry, or the refusal a malformed (400) or invalid (422) one gets. */
export function parseExperienceInput(value: unknown): ExperienceInput {
  const result = validateExperienceInput(value);
  if (result.success) return result.data;
  const malformed = result.issues.some(
    (issue) => issue.code === 'invalid_type' || issue.code === 'unrecognized_keys',
  );
  throw new ExperienceError(
    malformed ? 400 : 422,
    malformed ? 'bad_request' : 'validation_failed',
    'Check the experience fields',
  );
}

/** Oxy resolves merged identities; Clarity never copies the employer's mutable profile. */
export async function canonicalEmployerId(accountId: string): Promise<string> {
  try {
    const organization = await oxyClient.organizations.get(accountId);
    if (organization.status !== 'active' && organization.status !== 'inactive') {
      throw new ExperienceError(422, 'invalid_employer', 'Choose an available organization');
    }
    return organization.accountId;
  } catch (err) {
    if (err instanceof ExperienceError) throw err;
    if ([403, 404, 410].includes(getErrorStatus(err) ?? 0)) {
      throw new ExperienceError(422, 'invalid_employer', 'Choose an available organization');
    }
    throw err;
  }
}

/** The refusal a repository write error means, or `undefined` for an unexpected failure. */
export function experienceWriteError(err: unknown): ExperienceError | undefined {
  if (err instanceof ExperienceError) return err;
  if (err instanceof ExperienceLimitError) {
    return new ExperienceError(
      422,
      'experience_limit_reached',
      'A profile can have at most 100 experience entries',
    );
  }
  if (err instanceof ExperienceAccountErasedError) {
    return new ExperienceError(403, 'forbidden', 'This account has been erased');
  }
  return undefined;
}
