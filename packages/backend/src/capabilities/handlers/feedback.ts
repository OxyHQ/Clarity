import { z } from 'zod';

import { FEEDBACK_TYPES, findFeedback, listFeedback, submitFeedback } from '../../lib/feedback.js';
import { type ClarityToolHandlers, notFound, parseInput, requiredString } from './context.js';

const submitSchema = z.object({
  type: z.enum(FEEDBACK_TYPES),
  message: z.string().trim().min(1).max(5_000),
  rating: z.number().int().min(1).max(5).optional(),
});

export const FEEDBACK_HANDLERS: ClarityToolHandlers = {
  submitFeedback: async (input, { accountId }) => ({
    success: true,
    feedback: await submitFeedback(accountId, {
      ...parseInput(submitSchema, input),
      // Recorded so the team can tell agent-sent feedback from the form's.
      metadata: { via: 'capability' },
    }),
  }),
  listMyFeedback: async (_input, { accountId }) => ({ feedback: await listFeedback(accountId) }),
  getFeedback: async (input, { accountId }) => {
    const feedback = await findFeedback(accountId, requiredString(input, 'feedbackId'));
    if (!feedback) throw notFound('feedback_not_found', 'Feedback not found');
    return { ...feedback };
  },
};
