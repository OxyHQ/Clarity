import {
  createExperience,
  deleteExperience,
  listExperience,
  updateExperience,
} from '../../db/experience-repository.js';
import {
  canonicalEmployerId,
  experienceWriteError,
  parseExperienceInput,
  requirePersonalAccount,
} from '../../lib/experience.js';
import {
  type ClarityToolHandler,
  type ClarityToolHandlers,
  notFound,
  requiredString,
  ToolError,
} from './context.js';

/** The route's personal-account rule, then the route's refusals, for every experience tool. */
function experienceTool(handler: ClarityToolHandler): ClarityToolHandler {
  return async (input, context) => {
    try {
      await requirePersonalAccount(context.accountId);
      return await handler(input, context);
    } catch (error) {
      const refusal = experienceWriteError(error);
      if (refusal) throw new ToolError(refusal.status, refusal.code, refusal.message);
      throw error;
    }
  };
}

export const EXPERIENCE_HANDLERS: ClarityToolHandlers = {
  listMyExperience: experienceTool(async (_input, { accountId }) => ({
    items: await listExperience(accountId),
    nextCursor: null,
  })),
  addExperience: experienceTool(async (input, { accountId }) => {
    const entry = parseExperienceInput(input);
    const employerOxyAccountId = await canonicalEmployerId(entry.employerOxyAccountId);
    return { ...(await createExperience(accountId, { ...entry, employerOxyAccountId })) };
  }),
  updateExperience: experienceTool(async (input, { accountId }) => {
    const { experienceId, ...fields } = input;
    const id = requiredString({ experienceId }, 'experienceId');
    const entry = parseExperienceInput(fields);
    const employerOxyAccountId = await canonicalEmployerId(entry.employerOxyAccountId);
    const updated = await updateExperience(accountId, id, { ...entry, employerOxyAccountId });
    if (!updated) throw notFound('not_found', 'Experience not found');
    return { ...updated };
  }),
  deleteExperience: experienceTool(async (input, { accountId }) => {
    if (!(await deleteExperience(accountId, requiredString(input, 'experienceId')))) {
      throw notFound('not_found', 'Experience not found');
    }
    return { deleted: true };
  }),
};
