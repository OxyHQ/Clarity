import type { Supervision } from '@oxy.so/contracts';

/** UI availability only. Oxy remains the authority for every API request. */
export function claritySurfaceAccess(input: {
  isAuthenticated: boolean;
  isAuthResolved: boolean;
  activeSessionId?: string | null;
  accountId?: string;
  kind?: string;
  state: { self: Supervision | null } | undefined;
}): 'ordinary' | 'pending' | 'limited' {
  if (!input.isAuthResolved) return 'pending';
  if (!input.isAuthenticated && !input.accountId && !input.activeSessionId) return 'ordinary';
  if (!input.isAuthenticated || !input.accountId || !input.kind) return 'pending';
  if (input.kind !== 'personal') return 'ordinary';
  if (!input.state) return 'pending';
  return input.state.self && input.state.self.status !== 'ended' ? 'limited' : 'ordinary';
}
