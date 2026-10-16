/**
 * The catalogue's handlers, as both MCP lanes call them.
 *
 * Each tool's handler (`handlers/<domain>.ts`) calls the use case its Express
 * route calls — never HTTP. This module adds what every tool shares:
 *
 *  1. **The effective account**, from the verified principal and nowhere else:
 *     a capability ticket's `resource.effectiveAccountId` on `/_oxy/mcp`, the
 *     OAuth connection's `activeAccountId` on `/mcp`.
 *  2. **Idempotency.** An effectful tool called with an `Idempotency-Key` runs
 *     through `effect-receipts.ts`, so a retry replays the stored result.
 *  3. **The wire shape.** The result passes through a JSON round trip, as
 *     `res.json` does, so a tool returns exactly what the route returns. A
 *     refusal (`ToolError`) becomes an MCP error result with its code and
 *     status; anything else is logged and answers a generic internal error,
 *     never its message.
 */

import type { CatalogTool, InvocationPrincipal } from '@oxy.so/contracts';
import type { InvocationContext, InvocationHandlers } from '@oxy.so/mcp';

import { log } from '../lib/logger.js';
import { CLARITY_CAPABILITY_CATALOG } from './clarity.catalog.js';
import { runWithEffectReceipt } from './effect-receipts.js';
import { CLARITY_TOOL_HANDLERS } from './handlers/all.js';
import {
  type ClarityToolHandler,
  type ClarityToolHandlers,
  ToolError,
} from './handlers/context.js';

type ToolOutcome = Awaited<ReturnType<InvocationHandlers[string]>>;

/** The ONE place a lane's principal becomes the account a tool acts as. */
export function effectiveAccountOf(principal: InvocationPrincipal): string {
  return principal.kind === 'capability'
    ? principal.claims.resource.effectiveAccountId
    : principal.activeAccountId;
}

function idempotencyKeyOf(context: InvocationContext): string | undefined {
  const header = context.request.requestInfo?.headers?.['idempotency-key'];
  const value = Array.isArray(header) ? (header.length === 1 ? header[0] : undefined) : header;
  const key = typeof value === 'string' ? value.trim() : '';
  return key.length > 0 && key.length <= 200 ? key : undefined;
}

function errorOutcome(code: string, message: string, status: number): ToolOutcome {
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message, status } },
  };
}

function toolErrorOutcome(tool: CatalogTool, error: unknown): ToolOutcome {
  if (error instanceof ToolError) return errorOutcome(error.code, error.message, error.status);
  log.general.error({ err: error, tool: tool.name }, 'Capability tool failed');
  return errorOutcome('internal_error', 'The tool failed unexpectedly.', 500);
}

export function wrapClarityToolHandler(
  tool: CatalogTool,
  handler: ClarityToolHandler,
): InvocationHandlers[string] {
  return async (input, context) => {
    const accountId = effectiveAccountOf(context.principal);
    const idempotencyKey = tool.effect === 'read' ? undefined : idempotencyKeyOf(context);
    try {
      if (tool.idempotency === 'required' && idempotencyKey === undefined) {
        throw new ToolError(
          400,
          'idempotency_key_required',
          'This tool requires an Idempotency-Key',
        );
      }
      const run = async () =>
        JSON.parse(JSON.stringify(await handler(input, { accountId, tool }))) as Record<
          string,
          unknown
        >;
      const structuredContent =
        idempotencyKey === undefined
          ? await run()
          : await runWithEffectReceipt({ accountId, tool: tool.name, idempotencyKey, input }, run);
      return { structuredContent };
    } catch (error) {
      return toolErrorOutcome(tool, error);
    }
  };
}

/** Wrap every catalogue tool, refusing a tool without a handler or a stray handler. */
export function buildClarityInvocationHandlers(
  tools: readonly CatalogTool[] = CLARITY_CAPABILITY_CATALOG.tools,
  handlers: ClarityToolHandlers = CLARITY_TOOL_HANDLERS,
): InvocationHandlers {
  const names = new Set(tools.map((tool) => tool.name));
  const stray = Object.keys(handlers).filter((name) => !names.has(name));
  if (stray.length > 0) throw new Error(`Handlers without a catalogue tool: ${stray.join(', ')}`);
  return Object.fromEntries(
    tools.map((tool) => {
      const handler = handlers[tool.name];
      if (!handler) throw new Error(`Catalogue tool without a handler: ${tool.name}`);
      return [tool.name, wrapClarityToolHandler(tool, handler)];
    }),
  );
}

export const CLARITY_INVOCATION_HANDLERS: InvocationHandlers = buildClarityInvocationHandlers();
