/**
 * How a Clarity catalogue tool is declared.
 *
 * Every tool acts on ONE resource: the effective account's root
 * (`clarity_account`, resource id = the account id). Which document, job,
 * notification or experience entry a call touches is an INPUT, and whether the
 * account may touch it is decided by the same repository query the Express
 * route runs, so a non-owner gets not-found from a tool exactly as from the route.
 *
 * The helpers fix the parts of a `CatalogTool` that follow from what the tool
 * is, so a declaration states only its name, contract and capability:
 *
 *  - `readTool`: package `read`, no effect, both lanes.
 *  - `actTool`: a non-financial write. Idempotency `supported` (a key, when the
 *    caller sends one, replays the stored receipt), both lanes.
 *  - `featureCheckTool`: the check half of a catalogue `features[]` gate (Alia
 *    ADR 0020 §6), internal only, as the contract requires.
 *
 * Every invocation path is `POST /_oxy/capabilities/<name>`. Clarity's internal
 * transport is MCP (`internalTransport: 'mcp'`), so nothing routes on these
 * paths; the contract requires one per tool, and one distinct static path per
 * tool can never overlap another.
 */

import type { CatalogTool } from '@oxy.so/contracts';

export const CLARITY_ACCOUNT_RESOURCE = 'clarity_account';
export const CLARITY_TOOL_VERSION = '1.0.0';

type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  /** The ONE capability (and OAuth scope) the tool requires. */
  capability: string;
  input: JsonSchema;
}

/** Packages a write may declare (all inside "Ver y actuar"). */
export type ActPackage = 'create' | 'publish' | 'communicate' | 'administer';

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const;

function base(spec: ToolSpec) {
  return {
    name: spec.name,
    version: CLARITY_TOOL_VERSION,
    description: spec.description,
    inputSchema: spec.input,
    outputSchema: OBJECT_OUTPUT,
    requiredCapabilities: [spec.capability],
    resourceTypes: [CLARITY_ACCOUNT_RESOURCE],
    limitKeys: [],
    invocation: { method: 'POST' as const, path: `/_oxy/capabilities/${spec.name}` },
  };
}

export function readTool(spec: ToolSpec): CatalogTool {
  return {
    ...base(spec),
    capabilityPackage: 'read',
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
  };
}

export function actTool(spec: ToolSpec & { capabilityPackage: ActPackage }): CatalogTool {
  return {
    ...base(spec),
    capabilityPackage: spec.capabilityPackage,
    effect: 'write',
    idempotency: 'supported',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
  };
}

export function featureCheckTool(spec: ToolSpec): CatalogTool {
  return { ...readTool(spec), exposure: ['internal'] };
}

// ── Input schema building blocks ────────────────────────────────────────────

export const idInput = { type: 'string', minLength: 1, maxLength: 255 } as const;
export const urlInput = { type: 'string', format: 'uri', minLength: 1, maxLength: 2_048 } as const;
export const textInput = (maxLength: number) =>
  ({ type: 'string', minLength: 1, maxLength }) as const;
export const optionalTextInput = (maxLength: number) => ({ type: 'string', maxLength }) as const;
export const integerInput = (minimum: number, maximum: number) =>
  ({ type: 'integer', minimum, maximum }) as const;
export const enumInput = (values: readonly string[]) =>
  ({ type: 'string', enum: [...values] }) as const;
export const isoDateTimeInput = {
  type: 'string',
  format: 'date-time',
  description: 'ISO 8601 date-time.',
} as const;

export function objectInput(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}
