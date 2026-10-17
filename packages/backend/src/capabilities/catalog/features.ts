import type { CatalogFeature, CatalogTool } from '@oxy.so/contracts';

import { featureCheckTool, objectInput } from './define.js';

/**
 * What Clarity's plans unlock in Alia (Alia ADR 0020 §6, owner decision
 * 2026-10-16). The Clarity agent's owner maps Alia's gateable features to these
 * in Alia's agent editor (`deep_research` → `clarity` / `deep_research`,
 * `power_level.pro` → `clarity` / `power_level.pro`, …); Alia then asks the
 * check tool, under the person's ticket, before the turn reserves any credit.
 *
 * Each feature is answered from the person's plan features
 * (`lib/plan-access.ts`), so a plan is configured in Clarity's own catalogue:
 * the plan feature `deep-research`, and `power-level-<level>` for each power
 * level a plan includes. A level no plan lists is locked for everybody; a level
 * Alia does not gate is never asked about. None of these is metered, so none
 * has a consume tool: the inference itself is paid by the person's Alia credits.
 */
export const GATED_POWER_LEVELS = ['high', 'xhigh', 'pro', 'ultra'] as const;
export type GatedPowerLevel = (typeof GATED_POWER_LEVELS)[number];

/** The plan feature id a power level is sold as. */
export const powerLevelPlanFeature = (level: GatedPowerLevel) => `power-level-${level}`;
export const DEEP_RESEARCH_PLAN_FEATURE = 'deep-research';

const checkToolName = (level: GatedPowerLevel) =>
  `checkPowerLevel${level.charAt(0).toUpperCase()}${level.slice(1)}`;

export const FEATURE_CHECK_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  checkDeepResearch: DEEP_RESEARCH_PLAN_FEATURE,
  ...Object.fromEntries(
    GATED_POWER_LEVELS.map((level) => [checkToolName(level), powerLevelPlanFeature(level)]),
  ),
});

export const FEATURE_TOOLS: readonly CatalogTool[] = [
  featureCheckTool({
    name: 'checkDeepResearch',
    description: 'Whether the person’s Clarity plan includes deep research. Answers { available }.',
    capability: 'plan.features.read',
    input: objectInput({}),
  }),
  ...GATED_POWER_LEVELS.map((level) =>
    featureCheckTool({
      name: checkToolName(level),
      description: `Whether the person’s Clarity plan includes the ${level} power level. Answers { available }.`,
      capability: 'plan.features.read',
      input: objectInput({}),
    }),
  ),
];

export const CLARITY_FEATURES: readonly CatalogFeature[] = [
  {
    key: 'deep_research',
    description: 'Deep research in a Clarity conversation. Included in Clarity plans that list it.',
    checkTool: 'checkDeepResearch',
  },
  ...GATED_POWER_LEVELS.map((level) => ({
    key: `power_level.${level}`,
    description: `The ${level} power level in a Clarity conversation. Included in Clarity plans that list it.`,
    checkTool: checkToolName(level),
  })),
];
