import type { CatalogTool } from '@oxy.so/contracts';

import { FEEDBACK_TYPES } from '../../lib/feedback.js';
import {
  actTool,
  enumInput,
  idInput,
  integerInput,
  objectInput,
  readTool,
  textInput,
} from './define.js';

/** Feedback the person sends the Clarity team, and what they sent before. */
export const FEEDBACK_TOOLS: readonly CatalogTool[] = [
  actTool({
    name: 'submitFeedback',
    description:
      'Send the Clarity team the person’s feedback: a bug, a feature request, an improvement or anything else, with an optional 1–5 rating. Send what the person said, in their words.',
    capability: 'feedback.submit',
    capabilityPackage: 'communicate',
    input: objectInput(
      {
        type: enumInput(FEEDBACK_TYPES),
        message: textInput(5_000),
        rating: integerInput(1, 5),
      },
      ['type', 'message'],
    ),
  }),
  readTool({
    name: 'listMyFeedback',
    description:
      'The person’s last 50 feedback messages to Clarity, newest first, with their status.',
    capability: 'feedback.read',
    input: objectInput({}),
  }),
  readTool({
    name: 'getFeedback',
    description: 'Read one of the person’s feedback messages. Anyone else’s answers not-found.',
    capability: 'feedback.read',
    input: objectInput({ feedbackId: idInput }, ['feedbackId']),
  }),
];
