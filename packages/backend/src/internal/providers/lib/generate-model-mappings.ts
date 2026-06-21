/**
 * Model Mappings Generator
 *
 * This utility generates complete model mappings with capabilities and pricing
 * IMPORTANT: Only use REAL, currently available model IDs
 *
 * DigitalOcean Gradient is the PRIMARY provider (priority 1-3) for all tiers.
 * Other providers serve as fallbacks for reliability.
 */

import type { ModelMapping, ClarityTier } from './clarity-models';
import { getModelCapabilities, getModelPricing } from './model-capabilities-data';

// Helper to create a model mapping with all required fields
export function createMapping(
  provider: string,
  modelId: string,
  priority: number,
  qualityScore: number
): ModelMapping {
  const pricing = getModelPricing(modelId);
  const capabilities = getModelCapabilities(modelId);

  return {
    provider,
    modelId,
    priority,
    qualityScore,
    pricingTier: pricing.tier,
    costPer1MInput: pricing.costPer1MInput,
    costPer1MOutput: pricing.costPer1MOutput,
    averageLatencyMs: pricing.averageLatencyMs,
    capabilities,
  };
}

// Generate all tier mappings - ONLY REAL MODEL IDS
// DigitalOcean is PRIMARY for all tiers; other providers are fallbacks
export const GENERATED_TIER_MAPPINGS: Partial<Record<ClarityTier, ModelMapping[]>> = {
  // ============== FAST TIER (clarity-fast) ==============
  // Lightweight, fast responses for simple tasks
  'fast': [
    createMapping('digitalocean', 'openai-gpt-5.4-nano', 1, 78),
    createMapping('digitalocean', 'openai-gpt-5-nano', 2, 75),
    createMapping('digitalocean', 'openai-gpt-4o-mini', 3, 72),
    createMapping('digitalocean', 'anthropic-claude-haiku-4.5', 4, 74),
    createMapping('google', 'gemini-2.5-flash', 5, 75),
    createMapping('groq', 'llama-3.3-70b-versatile', 6, 65),
    createMapping('deepseek', 'deepseek-chat', 7, 72),
    createMapping('openai', 'gpt-4o-mini', 8, 68),
    createMapping('xai', 'grok-4-fast', 9, 70),
    createMapping('cerebras', 'llama-3.3-70b', 10, 62),
    createMapping('sambanova', 'Meta-Llama-3.3-70B-Instruct', 11, 62),
    createMapping('fireworks', 'accounts/fireworks/models/deepseek-v3', 12, 63),
    createMapping('novita', 'meta-llama/llama-3.3-70b-instruct', 13, 60),
    createMapping('mistral', 'mistral-small-3.1-2503', 14, 58),
  ],
  // ============== LITE TIER (internal — lightest workloads) ==============
  'lite': [
    createMapping('digitalocean', 'openai-gpt-5.4-nano', 1, 78),
    createMapping('digitalocean', 'openai-gpt-5-nano', 2, 75),
    createMapping('digitalocean', 'openai-gpt-oss-20b', 3, 55),
    createMapping('google', 'gemini-2.5-flash', 4, 75),
    createMapping('groq', 'llama-3.3-70b-versatile', 5, 65),
    createMapping('deepseek', 'deepseek-chat', 6, 72),
    createMapping('openai', 'gpt-4o-mini', 7, 68),
    createMapping('xai', 'grok-4-fast', 8, 70),
    createMapping('novita', 'meta-llama/llama-3.3-70b-instruct', 9, 60),
    createMapping('hyperbolic', 'deepseek-ai/DeepSeek-V3', 10, 64),
    createMapping('sambanova', 'Meta-Llama-3.3-70B-Instruct', 11, 62),
    createMapping('fireworks', 'accounts/fireworks/models/deepseek-v3', 12, 63),
    createMapping('cerebras', 'llama-3.3-70b', 13, 62),
    createMapping('mistral', 'mistral-small-3.1-2503', 14, 58),
  ],
  // ============== V1 TIER (clarity-v1) ==============
  // Balanced performance for everyday tasks
  'v1': [
    createMapping('digitalocean', 'openai-gpt-5.4-mini', 1, 90),
    createMapping('digitalocean', 'openai-gpt-5-mini', 2, 88),
    createMapping('digitalocean', 'anthropic-claude-4.6-sonnet', 3, 92),
    createMapping('digitalocean', 'openai-gpt-4.1', 4, 87),
    createMapping('google', 'gemini-2.5-flash', 5, 88),
    createMapping('google', 'gemini-3-flash-preview', 6, 85),
    createMapping('deepseek', 'deepseek-chat', 7, 83),
    createMapping('xai', 'grok-4-fast', 8, 82),
    createMapping('groq', 'llama-3.3-70b-versatile', 9, 80),
    createMapping('openai', 'gpt-4o-mini', 10, 82),
    createMapping('fireworks', 'accounts/fireworks/models/deepseek-v3', 11, 79),
    createMapping('sambanova', 'Meta-Llama-3.3-70B-Instruct', 12, 76),
    createMapping('cerebras', 'llama-3.3-70b', 13, 74),
    createMapping('mistral', 'mistral-small-3.1-2503', 14, 70),
  ],
  // ============== PRO TIER (clarity-pro) ==============
  // Advanced reasoning for complex tasks
  'pro': [
    createMapping('digitalocean', 'anthropic-claude-4.6-sonnet', 1, 96),
    createMapping('digitalocean', 'openai-gpt-5.4', 2, 95),
    createMapping('digitalocean', 'openai-gpt-5.2', 3, 93),
    createMapping('digitalocean', 'openai-gpt-5', 4, 92),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 5, 96),
    createMapping('google', 'gemini-2.5-pro', 6, 95),
    createMapping('deepseek', 'deepseek-chat', 7, 92),
    createMapping('xai', 'grok-4-fast', 8, 90),
    createMapping('openai', 'gpt-4o', 9, 91),
    createMapping('cohere', 'command-a-03-2025', 10, 86),
    createMapping('fireworks', 'accounts/fireworks/models/deepseek-v3', 11, 87),
    createMapping('replicate', 'meta/meta-llama-3.1-405b-instruct', 12, 88),
  ],
  // ============== THINKING TIER (clarity-thinking) ==============
  // Extended thinking for complex reasoning problems
  'thinking': [
    createMapping('digitalocean', 'openai-o3', 1, 97),
    createMapping('digitalocean', 'openai-gpt-5.4-pro', 2, 98),
    createMapping('digitalocean', 'openai-gpt-5.2-pro', 3, 96),
    createMapping('digitalocean', 'anthropic-claude-opus-4.6', 4, 97),
    createMapping('digitalocean', 'openai-o1', 5, 95),
    createMapping('google', 'gemini-2.5-pro', 6, 96),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 7, 95),
    createMapping('deepseek', 'deepseek-reasoner', 8, 94),
    createMapping('openai', 'o1', 9, 93),
    createMapping('xai', 'grok-3', 10, 92),
  ],
  // ============== PRO-MAX TIER (clarity-pro-max) ==============
  // Best available models for demanding tasks
  'pro-max': [
    createMapping('digitalocean', 'anthropic-claude-opus-4.6', 1, 98),
    createMapping('digitalocean', 'openai-gpt-5.4-pro', 2, 99),
    createMapping('digitalocean', 'openai-gpt-5.2-pro', 3, 97),
    createMapping('digitalocean', 'openai-o3', 4, 97),
    createMapping('digitalocean', 'anthropic-claude-4.1-opus', 5, 98),
    createMapping('anthropic', 'claude-opus-4-20241120', 6, 98),
    createMapping('google', 'gemini-2.5-pro', 7, 96),
    createMapping('openai', 'o1', 8, 95),
    createMapping('xai', 'grok-4', 9, 94),
    createMapping('deepseek', 'deepseek-reasoner', 10, 94),
  ],
  // ============== V1-CODEA TIER (coding assistant) ==============
  'v1-codea': [
    createMapping('digitalocean', 'openai-gpt-5.3-codex', 1, 96),
    createMapping('digitalocean', 'openai-gpt-5.1-codex-max', 2, 95),
    createMapping('digitalocean', 'anthropic-claude-4.6-sonnet', 3, 94),
    createMapping('deepseek', 'deepseek-chat', 4, 94),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 5, 95),
    createMapping('google', 'gemini-3-flash-preview', 6, 93),
    createMapping('xai', 'grok-4-fast', 7, 91),
    createMapping('groq', 'llama-3.3-70b-versatile', 8, 90),
    createMapping('google', 'gemini-2.5-pro', 9, 92),
    createMapping('openai', 'gpt-4o', 10, 91),
    createMapping('fireworks', 'accounts/fireworks/models/deepseek-v3', 11, 87),
    createMapping('cerebras', 'llama-3.3-70b', 12, 82),
    createMapping('mistral', 'mistral-small-3.1-2503', 13, 78),
  ],
  // ============== V1-COWORK TIER (collaborative work) ==============
  'v1-cowork': [
    createMapping('digitalocean', 'openai-gpt-5', 1, 93),
    createMapping('digitalocean', 'anthropic-claude-4.6-sonnet', 2, 95),
    createMapping('deepseek', 'deepseek-chat', 3, 93),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 4, 95),
    createMapping('google', 'gemini-2.5-pro', 5, 92),
    createMapping('openai', 'gpt-4o', 6, 90),
    createMapping('xai', 'grok-4-fast', 7, 88),
    createMapping('groq', 'llama-3.3-70b-versatile', 8, 87),
    createMapping('cohere', 'command-a-03-2025', 9, 83),
    createMapping('cerebras', 'llama-3.3-70b', 10, 80),
    createMapping('mistral', 'mistral-small-3.1-2503', 11, 76),
  ],
  // ============== V1-BROWSER TIER (web browsing) ==============
  'v1-browser': [
    createMapping('digitalocean', 'openai-gpt-5-mini', 1, 90),
    createMapping('digitalocean', 'anthropic-claude-4.6-sonnet', 2, 95),
    createMapping('google', 'gemini-3-flash-preview', 3, 97),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 4, 96),
    createMapping('google', 'gemini-2.5-pro', 5, 94),
    createMapping('perplexity', 'sonar-pro', 6, 93),
    createMapping('deepseek', 'deepseek-chat', 7, 92),
    createMapping('xai', 'grok-4-fast', 8, 89),
    createMapping('groq', 'llama-3.3-70b-versatile', 9, 89),
    createMapping('openai', 'gpt-4o', 10, 90),
    createMapping('cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 11, 86),
    createMapping('cerebras', 'llama-3.3-70b', 12, 82),
    createMapping('mistral', 'mistral-small-3.1-2503', 13, 78),
  ],
  // ============== V1-VISION TIER (image understanding) ==============
  'v1-vision': [
    createMapping('digitalocean', 'openai-gpt-4o', 1, 92),
    createMapping('digitalocean', 'openai-gpt-5-mini', 2, 90),
    createMapping('digitalocean', 'anthropic-claude-4.6-sonnet', 3, 95),
    createMapping('google', 'gemini-3-flash-preview', 4, 97),
    createMapping('google', 'gemini-2.5-pro', 5, 96),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 6, 95),
    createMapping('openai', 'gpt-4o', 7, 92),
    createMapping('xai', 'grok-4', 8, 90),
    createMapping('cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 9, 88),
    createMapping('cohere', 'command-a-vision-07-2025', 10, 87),
  ],
  // ============== V1-AUDIO TIER (speech-to-text) ==============
  'v1-audio': [
    createMapping('groq', 'whisper-large-v3-turbo', 1, 95),
    createMapping('groq', 'whisper-large-v3', 2, 93),
    createMapping('openai', 'whisper-1', 3, 92),
  ],
  // ============== V1-TTS TIER (text-to-speech) ==============
  'v1-tts': [
    createMapping('openai', 'tts-1', 1, 90),
    createMapping('openai', 'tts-1-hd', 2, 95),
    createMapping('openrouter', 'openai/tts-1', 3, 88),
    createMapping('digitalocean', 'fal-ai/elevenlabs/tts/multilingual-v2', 4, 87),
  ],
  // ============== V1-IMAGE TIER (image generation) ==============
  'v1-image': [
    createMapping('openai', 'dall-e-3', 1, 92),
    createMapping('digitalocean', 'openai-gpt-image-1', 2, 90),
    createMapping('digitalocean', 'fal-ai/flux/schnell', 3, 85),
    createMapping('digitalocean', 'fal-ai/fast-sdxl', 4, 80),
  ],
  // ============== V1-MULTIMODAL TIER (multi-modal understanding) ==============
  'v1-multimodal': [
    createMapping('digitalocean', 'openai-gpt-5.4', 1, 99),
    createMapping('digitalocean', 'anthropic-claude-opus-4.6', 2, 97),
    createMapping('google', 'gemini-3-pro-preview', 3, 99),
    createMapping('google', 'gemini-2.5-pro', 4, 98),
    createMapping('anthropic', 'claude-opus-4-20241120', 5, 97),
    createMapping('google', 'gemini-3-flash-preview', 6, 96),
    createMapping('openai', 'gpt-4o', 7, 95),
    createMapping('cloudflare', '@cf/meta/llama-3.2-11b-vision-instruct', 8, 90),
  ],
  // ============== V1-PRO TIER (internal — advanced reasoning) ==============
  'v1-pro': [
    createMapping('digitalocean', 'anthropic-claude-4.6-sonnet', 1, 96),
    createMapping('digitalocean', 'openai-gpt-5.2', 2, 93),
    createMapping('digitalocean', 'openai-o3', 3, 95),
    createMapping('anthropic', 'claude-sonnet-4-20250514', 4, 96),
    createMapping('google', 'gemini-2.5-pro', 5, 95),
    createMapping('deepseek', 'deepseek-reasoner', 6, 94),
    createMapping('xai', 'grok-3', 7, 93),
    createMapping('openai', 'o1', 8, 92),
    createMapping('cohere', 'command-a-reasoning-08-2025', 9, 91),
    createMapping('perplexity', 'sonar-reasoning-pro', 10, 89),
  ],
  // ============== V1-PRO-MAX TIER (internal — best available) ==============
  'v1-pro-max': [
    createMapping('digitalocean', 'anthropic-claude-opus-4.6', 1, 98),
    createMapping('digitalocean', 'openai-gpt-5.2-pro', 2, 97),
    createMapping('digitalocean', 'openai-o3', 3, 96),
    createMapping('digitalocean', 'anthropic-claude-4.1-opus', 4, 98),
    createMapping('anthropic', 'claude-opus-4-20241120', 5, 98),
    createMapping('google', 'gemini-2.5-pro', 6, 96),
    createMapping('openai', 'o1', 7, 95),
    createMapping('xai', 'grok-4', 8, 94),
    createMapping('deepseek', 'deepseek-reasoner', 9, 94),
    createMapping('cohere', 'command-a-reasoning-08-2025', 10, 91),
  ],
  // ============== VOICE TIERS ==============
  'v1-voice': [
    {
      provider: 'xai',
      modelId: 'grok-realtime',
      priority: 1,
      qualityScore: 85,
      pricingTier: 'paid' as const,
      costPerMinute: 0.05,
      capabilities: {
        voice: true,
        audio: true,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 32768,
        maxOutputTokens: 8192,
      },
    },
    {
      provider: 'openai',
      modelId: 'gpt-4o-realtime-preview',
      priority: 2,
      qualityScore: 90,
      pricingTier: 'paid' as const,
      costPerMinute: 0.06,
      capabilities: {
        voice: true,
        audio: true,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
      },
    },
  ],
  'v1-voice-pro': [
    {
      provider: 'openai',
      modelId: 'gpt-4o-realtime-preview',
      priority: 1,
      qualityScore: 90,
      pricingTier: 'paid' as const,
      costPerMinute: 0.06,
      capabilities: {
        voice: true,
        audio: true,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
      },
    },
    {
      provider: 'xai',
      modelId: 'grok-realtime',
      priority: 2,
      qualityScore: 85,
      pricingTier: 'paid' as const,
      costPerMinute: 0.05,
      capabilities: {
        voice: true,
        audio: true,
        video: false,
        vision: false,
        tools: true,
        codeExecution: false,
        webSearch: false,
        computerUse: false,
        streaming: true,
        systemPrompts: true,
        functionCalling: true,
        promptCaching: false,
        maxContextTokens: 32768,
        maxOutputTokens: 8192,
      },
    },
  ],
};
