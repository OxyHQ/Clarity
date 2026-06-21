// ---------------------------------------------------------------------------
// Public Clarity model DTO — the user/developer-facing model shape returned by
// GET /v1/models and consumed by the frontend model selector.
//
// MODEL ABSTRACTION RULE (CRITICAL): this DTO exposes ONLY Clarity-branded
// model identities (clarity-fast, clarity-v1, clarity-pro, ...). It must NEVER
// carry internal provider names, provider model IDs, or provider routing /
// mapping details. Those live exclusively in the backend's internal layer.
// ---------------------------------------------------------------------------

/** Functional category a Clarity model belongs to. */
export type ModelCategory =
  | 'general'
  | 'coding'
  | 'vision'
  | 'audio'
  | 'multimodal'
  | 'voice';

/** Capabilities advertised for a Clarity model. */
export interface ClarityModelCapabilities {
  tools: boolean;
  vision: boolean;
  max_tokens?: number;
}

/** Pricing information for a Clarity model. */
export interface ClarityModelPricing {
  /** Cost multiplier relative to the base credit cost (1.0 = base). */
  credit_multiplier: number;
}

/**
 * Public Clarity model DTO (OpenAI-compatible `model` object shape).
 * `owned_by` is always `"clarity"` — provider ownership is never surfaced.
 */
export interface ClarityModelDTO {
  id: string;
  object: 'model';
  created: number;
  owned_by: 'clarity';
  name: string;
  description?: string;
  category: ModelCategory;
  emoji?: string;
  is_default: boolean;
  is_available: boolean;
  is_legacy: boolean;
  /** Required plan name to use this model, or null if available on every plan. */
  required_plan: string | null;
  capabilities: ClarityModelCapabilities;
  pricing: ClarityModelPricing;
}

/** Response body for GET /v1/models. */
export interface ClarityModelsResponse {
  object: 'list';
  data: ClarityModelDTO[];
}
