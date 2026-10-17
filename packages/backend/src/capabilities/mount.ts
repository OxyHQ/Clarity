/**
 * Mount both MCP lanes on the Express app, BEFORE every body parser.
 *
 * MCP owns its raw request body, its exact resource host and its auth
 * challenge, so nothing shared may run first: a JSON parser would consume the
 * body, CORS would reinterpret the request, and runtime readiness and the
 * session middleware gate on things these lanes do not have. Their authority
 * is the capability ticket or the OAuth token, verified by the transport, not
 * an Oxy session.
 *
 * `index.ts` starts the registration once the process is serving
 * (`lanes.internal.bound()`), so a failure is in the log the moment the task
 * starts, not when Alia first calls.
 */

import type { Express } from 'express';

import { oxyCapabilityAuthority } from './capability-authority.js';
import { CLARITY_CAPABILITY_CATALOG } from './clarity.catalog.js';
import { createClarityInternalMcpReceiver } from './clarity-internal-mcp.js';
import { createClarityMcpHttpService } from './clarity-mcp-http.js';

export interface CapabilityLanes {
  internal: ReturnType<typeof createClarityInternalMcpReceiver>;
  external: ReturnType<typeof createClarityMcpHttpService>;
}

export function mountCapabilityLanes(app: Express, lanes: CapabilityLanes): void {
  app.all(lanes.internal.path, (request, response) => {
    void lanes.internal.handle(request, response);
  });
  app.all(lanes.external.protectedResourceMetadataPath, (request, response) => {
    lanes.external.handleProtectedResourceMetadata(request, response);
  });
  app.all(lanes.external.mcpPath, (request, response) => {
    void lanes.external.handleMcp(request, response);
  });
}

/** The production lanes, bound to Clarity's Oxy authority. */
export function createCapabilityLanes(): CapabilityLanes {
  const authority = oxyCapabilityAuthority(CLARITY_CAPABILITY_CATALOG);
  const internal = createClarityInternalMcpReceiver({
    register: authority.register,
    verifyTicket: authority.verifyTicket,
    audit: authority.audit,
  });
  return { internal, external: createClarityMcpHttpService() };
}
