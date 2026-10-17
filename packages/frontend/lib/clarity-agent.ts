/**
 * Clarity's assistant, as the app opens it: an ordinary public Alia agent owned
 * by Clarity's project account (Alia ADR 0020 §1) and confined to Clarity by Oxy
 * (Oxy ADR 0044). Its prompt, families, ceiling and feature gates are edited in
 * Alia's agent editor; the only thing pinned here is the id the app opens it by.
 */

/** Clarity's Oxy app slug: the conversations it starts are labelled with it. */
export const CLARITY_APP = 'clarity';

/** Clarity's Alia agent id. */
export const CLARITY_AGENT_ID = '01a0646a-078f-7642-95ef-439952f4f3f9';

/** The `agent` prop of the SDK's conversation surfaces. */
export const CLARITY_AGENT = { id: CLARITY_AGENT_ID } as const;

/**
 * The agents `useAskAgent().ask(key)` opens in the app's one sheet: `alia` (no id —
 * Alia herself) and `clarity`.
 */
export const CLARITY_ASK_AGENTS = { alia: {}, clarity: CLARITY_AGENT } as const;

/** The address of a conversation with Clarity. */
export function conversationPath(conversationId: string): string {
  return `/c/${encodeURIComponent(conversationId)}`;
}
