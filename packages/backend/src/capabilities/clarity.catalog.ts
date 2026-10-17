/**
 * Clarity's capability catalogue — what a signed-in person can do in Clarity,
 * as that person, for Alia (`api.clarity.surf/_oxy/mcp`) and for any OAuth MCP
 * client (`mcp.clarity.surf/mcp`).
 *
 * Clarity's assistant is an ordinary Alia agent (Alia ADR 0020); these tools
 * are how it reaches Clarity, under the person's own ticket. One tool per
 * person action, each calling the SAME use case the Express route calls, as
 * the effective account. What is deliberately NOT a tool, and why, is
 * `exclusions.ts`.
 *
 * **Bump `version` whenever a tool changes.** Oxy registers a catalogue by
 * (appId, version, digest); `catalog.test.ts` pins the digest so a change
 * without a bump fails here rather than as a registration refusal at boot.
 */

import type { AppCapabilityCatalog } from '@oxy.so/contracts';

import { CLARITY_ACCOUNT_RESOURCE } from './catalog/define.js';
import { EXPERIENCE_TOOLS } from './catalog/experience.js';
import { CLARITY_FEATURES, FEATURE_TOOLS } from './catalog/features.js';
import { FEEDBACK_TOOLS } from './catalog/feedback.js';
import { JOB_TOOLS } from './catalog/jobs.js';
import { MARKET_TOOLS } from './catalog/market.js';
import { NOTIFICATION_TOOLS } from './catalog/notifications.js';
import { PLACE_TOOLS } from './catalog/places.js';
import { PRODUCT_TOOLS } from './catalog/products.js';
import { SEARCH_TOOLS } from './catalog/search.js';

export const CLARITY_CAPABILITY_CATALOG: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: 'clarity',
  version: '1.1.0',
  audience: 'oxy-clarity-api',
  internalBaseUrl: 'https://api.clarity.surf',
  internalTransport: 'mcp',
  accountResourceType: CLARITY_ACCOUNT_RESOURCE,
  externalMcp: { resource: 'https://mcp.clarity.surf' },
  features: [...CLARITY_FEATURES],
  tools: [
    ...SEARCH_TOOLS,
    ...JOB_TOOLS,
    ...PLACE_TOOLS,
    ...MARKET_TOOLS,
    ...PRODUCT_TOOLS,
    ...EXPERIENCE_TOOLS,
    ...NOTIFICATION_TOOLS,
    ...FEEDBACK_TOOLS,
    ...FEATURE_TOOLS,
  ],
  events: [],
};
