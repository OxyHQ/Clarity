import type { ClarityToolHandlers } from './context.js';
import { EXPERIENCE_HANDLERS } from './experience.js';
import { FEATURE_HANDLERS } from './features.js';
import { FEEDBACK_HANDLERS } from './feedback.js';
import { JOB_HANDLERS } from './jobs.js';
import { MARKET_HANDLERS } from './market.js';
import { NOTIFICATION_HANDLERS } from './notifications.js';
import { PLACE_HANDLERS } from './places.js';
import { PRODUCT_HANDLERS } from './products.js';
import { SEARCH_HANDLERS } from './search.js';

export const CLARITY_TOOL_HANDLERS: ClarityToolHandlers = {
  ...SEARCH_HANDLERS,
  ...JOB_HANDLERS,
  ...PLACE_HANDLERS,
  ...MARKET_HANDLERS,
  ...PRODUCT_HANDLERS,
  ...EXPERIENCE_HANDLERS,
  ...NOTIFICATION_HANDLERS,
  ...FEEDBACK_HANDLERS,
  ...FEATURE_HANDLERS,
};
