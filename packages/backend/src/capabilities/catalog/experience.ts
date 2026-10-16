import type { CatalogTool } from '@oxy.so/contracts';
import {
  EXPERIENCE_EMPLOYMENT_TYPES,
  EXPERIENCE_LIMITS,
  EXPERIENCE_MAX_ENTRIES,
} from '@clarity.surf/sdk/experience';

import { actTool, enumInput, idInput, objectInput, readTool, textInput } from './define.js';

const month = {
  type: 'string',
  pattern: '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$',
  description: 'YYYY-MM, not in the future.',
} as const;

const entryFields = {
  title: textInput(EXPERIENCE_LIMITS.title),
  employerOxyAccountId: {
    ...textInput(EXPERIENCE_LIMITS.employerOxyAccountId),
    description: 'The Oxy account id of the employer organization.',
  },
  employmentType: { anyOf: [enumInput(EXPERIENCE_EMPLOYMENT_TYPES), { type: 'null' }] },
  location: {
    anyOf: [{ type: 'string', maxLength: EXPERIENCE_LIMITS.location }, { type: 'null' }],
  },
  startDate: month,
  endDate: {
    anyOf: [month, { type: 'null' }],
    description: 'YYYY-MM, not before startDate; null for a current role.',
  },
  description: {
    anyOf: [{ type: 'string', maxLength: EXPERIENCE_LIMITS.description }, { type: 'null' }],
  },
} as const;
const entryRequired = ['title', 'employerOxyAccountId', 'startDate', 'endDate'] as const;

/**
 * The person's own work history, which they publish on their public Clarity
 * and Mention profile. Personal accounts only. Kept apart from Jobs, search
 * and ranking: nothing here is visible to employers as a candidate list.
 */
export const EXPERIENCE_TOOLS: readonly CatalogTool[] = [
  readTool({
    name: 'listMyExperience',
    description: 'List the person’s own published work history, newest role first.',
    capability: 'experience.read',
    input: objectInput({}),
  }),
  actTool({
    name: 'addExperience',
    description: `Add a role to the person’s work history. Every field is PUBLISHED on their public profile. At most ${EXPERIENCE_MAX_ENTRIES} entries; personal accounts only; the employer must be an existing Oxy organization.`,
    capability: 'experience.manage',
    capabilityPackage: 'publish',
    input: objectInput(entryFields, entryRequired),
  }),
  actTool({
    name: 'updateExperience',
    description:
      'Replace one of the person’s work history entries with the fields given (published on their public profile). Anyone else’s answers not-found.',
    capability: 'experience.manage',
    capabilityPackage: 'publish',
    input: objectInput({ experienceId: idInput, ...entryFields }, [
      'experienceId',
      ...entryRequired,
    ]),
  }),
  actTool({
    name: 'deleteExperience',
    description:
      'Remove one entry from the person’s work history and their public profile. Anyone else’s answers not-found.',
    capability: 'experience.manage',
    capabilityPackage: 'publish',
    input: objectInput({ experienceId: idInput }, ['experienceId']),
  }),
];
