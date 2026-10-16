import { getUserEntitlements } from '../../lib/plan-access.js';
import { FEATURE_CHECK_TOOLS } from '../catalog/features.js';
import type { ClarityToolHandlers } from './context.js';

/**
 * Alia's feature-gate contract (Alia PR #819): a check tool is called with no
 * input and answers `{ available, remaining? }`. Clarity's plan features are
 * not metered, so there is never a `remaining`. A plan feature counts only when
 * it is enabled outright (`true`); a numeric limit is not a grant of the feature.
 */
export const FEATURE_HANDLERS: ClarityToolHandlers = Object.fromEntries(
  Object.entries(FEATURE_CHECK_TOOLS).map(([tool, planFeature]) => [
    tool,
    async (_input, { accountId }) => ({
      available: (await getUserEntitlements(accountId)).features[planFeature] === true,
    }),
  ]),
);
