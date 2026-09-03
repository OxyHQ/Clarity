/**
 * Clarity's product-facing model catalogue.
 *
 * These identifiers are presentation and billing-policy IDs. They deliberately
 * contain no provider, deployment, credential, or upstream model mapping. The
 * only routing vocabulary Clarity sends is an Alia product profile; Alia owns
 * the subsequent Oxy -> Kaana inference decision.
 */
import { CLARITY_AGENT_MANIFEST } from './clarity-agent-manifest.js';

export type ModelCategory = 'general' | 'coding';
export type AliaReasoningEffort = 'instant' | 'medium' | 'high' | 'max';

export interface ClarityModel {
  id: string;
  name: string;
  tier: string;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  category: ModelCategory;
  emoji?: string;
  chatVisible?: boolean;
  /** Alia-owned product profile, never a concrete model or deployment. */
  aliaProfileId: `profile:${string}`;
  /** Explicit reasoning parameter; it is not inferred from sort order/name. */
  reasoningEffort?: AliaReasoningEffort;
}

export interface ClarityModelWithAvailability extends ClarityModel {
  isAvailable: boolean;
  isLegacy: boolean;
}

const CLARITY_MODELS: Readonly<Record<string, ClarityModel>> = Object.freeze({
  'clarity-fast': {
    id: 'clarity-fast',
    name: 'Clarity Fast',
    tier: 'fast',
    description: 'Fast responses for simple tasks',
    creditMultiplier: 0.5,
    maxTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    category: 'general',
    emoji: '\u26a1',
    chatVisible: true,
    aliaProfileId: 'profile:lite',
    reasoningEffort: 'instant',
  },
  'clarity-v1': {
    id: 'clarity-v1',
    name: 'Clarity V1',
    tier: 'v1',
    description: 'Balanced performance for everyday tasks',
    creditMultiplier: 1,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '\ud83c\udfaf',
    chatVisible: true,
    aliaProfileId: 'profile:v1',
  },
  'clarity-pro': {
    id: 'clarity-pro',
    name: 'Clarity Pro',
    tier: 'pro',
    description: 'Advanced reasoning for complex tasks',
    creditMultiplier: 3,
    maxTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '\u2b50',
    chatVisible: true,
    aliaProfileId: 'profile:v1-pro',
    reasoningEffort: 'high',
  },
  'clarity-thinking': {
    id: 'clarity-thinking',
    name: 'Clarity Thinking',
    tier: 'thinking',
    description: 'Extended thinking for complex problems',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '\ud83e\udde0',
    chatVisible: true,
    aliaProfileId: 'profile:v1-pro-max',
    reasoningEffort: 'medium',
  },
  'clarity-pro-max': {
    id: 'clarity-pro-max',
    name: 'Clarity Pro Max',
    tier: 'pro-max',
    description: 'Highest reasoning effort for demanding tasks',
    creditMultiplier: 5,
    maxTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    category: 'general',
    emoji: '\ud83d\ude80',
    chatVisible: true,
    aliaProfileId: 'profile:v1-pro-max',
    reasoningEffort: 'max',
  },
});

export function getDefaultClarityModel(): string {
  return 'clarity-fast';
}

export function getClarityModel(modelId: string): ClarityModel | null {
  return CLARITY_MODELS[modelId] ?? null;
}

export function isClarityModel(modelId: string): boolean {
  return getClarityModel(modelId) !== null;
}

export function getAllClarityModels(): ClarityModel[] {
  return Object.values(CLARITY_MODELS);
}

export function getClarityModelsByCategory(category: ModelCategory): ClarityModel[] {
  return getAllClarityModels().filter((model) => model.category === category);
}

export function getDefaultModelForCategory(category: ModelCategory): ClarityModel | null {
  if (category === 'general') return getClarityModel('clarity-v1');
  return null;
}

/**
 * Availability is the product-agent seam, not a local provider health probe.
 * Missing provisioning fails closed and makes every product model unavailable.
 */
export function getAvailableModels(
  env: NodeJS.ProcessEnv = process.env,
): ClarityModelWithAvailability[] {
  const isAvailable = env.CLARITY_ALIA_AGENT_ID === CLARITY_AGENT_MANIFEST.agentId;
  return getAllClarityModels().map((model) => ({
    ...model,
    isAvailable,
    isLegacy: false,
  }));
}
