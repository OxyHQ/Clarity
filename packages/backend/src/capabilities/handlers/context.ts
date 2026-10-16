/**
 * What a Clarity tool handler receives, and how it reads its input.
 *
 * A handler is `(input, context) => result`. `context.accountId` is THE
 * effective account — the verified capability ticket's `effectiveAccountId` on
 * `/_oxy/mcp`, the OAuth connection's active account on `/mcp` — and it is the
 * only identity a handler may pass on. Input never names an account, and there
 * is no Express session on these lanes.
 *
 * The transport has already checked the input against the tool's JSON Schema;
 * handlers parse it again with the SAME zod schema the route uses, so a tool
 * accepts exactly what the route accepts. A refusal is a `ToolError`, which the
 * wrapper (`clarity.handlers.ts`) turns into an MCP error result.
 */
import type { CatalogTool } from '@oxy.so/contracts';
import type { z } from 'zod';

export interface ClarityToolContext {
  /** The effective Clarity account (an Oxy user id). The ONLY authority. */
  readonly accountId: string;
  readonly tool: CatalogTool;
}

export type ToolInput = Readonly<Record<string, unknown>>;
export type ToolResult = Record<string, unknown>;
export type ClarityToolHandler = (
  input: ToolInput,
  context: ClarityToolContext,
) => Promise<ToolResult>;
export type ClarityToolHandlers = Readonly<Record<string, ClarityToolHandler>>;

/** A refusal the caller can act on: `code` and `status` are what the route would answer. */
export class ToolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ToolError(
    400,
    'invalid_request',
    issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'Request validation failed',
  );
}

export function requiredString(input: ToolInput, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolError(400, 'invalid_request', `${key} must be a non-empty string`);
  }
  return value;
}

export function notFound(code: string, message: string): ToolError {
  return new ToolError(404, code, message);
}
