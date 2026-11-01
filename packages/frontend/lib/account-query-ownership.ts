import type { AccountQueriesConfig } from '@oxy.so/services/ui';

/** Private reads are discarded on an account change and never written to disk. */
export const accountQueryOwnership = {
  roots: [],
  memoryOnlyRoots: ['notifications', 'subscription', 'subscription-poll'],
} satisfies AccountQueriesConfig;
