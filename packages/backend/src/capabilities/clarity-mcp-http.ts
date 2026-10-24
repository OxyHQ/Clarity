/**
 * `mcp.clarity.surf/mcp` — Clarity's public MCP, for any OAuth client (Claude,
 * ChatGPT, …), served by the same process as the API.
 *
 * The shared transport owns the protocol: it answers 421 to a request sent to
 * any other host (so `api.clarity.surf/mcp` is refused rather than served), 401
 * with `WWW-Authenticate: Bearer … resource_metadata="…"` to a request without
 * a live token, introspects every token with Oxy, and serves the
 * protected-resource metadata at `/.well-known/oauth-protected-resource`.
 *
 * Clarity owns the rest: the tools are the catalogue's `mcp`-exposed ones, the
 * handlers are the same ones `/_oxy/mcp` runs, and the account a tool acts as
 * is the connection's ACTIVE account — never one named in the input. The
 * feature-gate tools are internal-only and absent here.
 */

import { createCatalogMcpHttpServiceWithInvocationPrincipal } from '@oxy.so/mcp';

import { canonicalBaseUrl, clarityOxyServer } from '../lib/clarity-service-auth.js';
import { log } from '../lib/logger.js';
import { CLARITY_CAPABILITY_CATALOG } from './clarity.catalog.js';
import { CLARITY_INVOCATION_HANDLERS } from './clarity.handlers.js';
import { CLARITY_MCP_MAX_BODY_BYTES } from './clarity-internal-mcp.js';

const DEFAULT_ALLOWED_ORIGINS = ['https://chatgpt.com', 'https://claude.ai'] as const;

export function parseClarityMcpAllowedOrigins(
  configured = process.env.CLARITY_MCP_ALLOWED_ORIGINS,
): string[] {
  return [
    ...new Set([
      ...DEFAULT_ALLOWED_ORIGINS,
      ...(configured ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ]),
  ];
}

export interface ClarityMcpHttpServiceOptions {
  readonly authorizationServer?: string;
  readonly transport?: { fetch: typeof fetch };
}

export function createClarityMcpHttpService(options: ClarityMcpHttpServiceOptions = {}) {
  const authorizationServer = options.authorizationServer ?? canonicalBaseUrl();
  return createCatalogMcpHttpServiceWithInvocationPrincipal({
    catalog: CLARITY_CAPABILITY_CATALOG,
    handlers: CLARITY_INVOCATION_HANDLERS,
    authorizationServer,
    transport:
      options.transport ??
      clarityOxyServer().createServiceClient({ baseURL: authorizationServer, audience: 'oxy-api' }),
    allowedOrigins: parseClarityMcpAllowedOrigins(),
    maxBodyBytes: CLARITY_MCP_MAX_BODY_BYTES,
    authorize: async (_input, context) =>
      context.principal.kind === 'oauth'
        ? { allowed: true, effectiveAccountId: context.principal.activeAccountId }
        : { allowed: false, reason: 'oauth_required' },
    logger: {
      error(message, error) {
        log.general.error(
          { error: error instanceof Error ? error.message : String(error) },
          message,
        );
      },
    },
    serverName: 'clarity-mcp',
  });
}
