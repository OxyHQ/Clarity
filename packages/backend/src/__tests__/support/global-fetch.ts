/**
 * `vi.stubGlobal('fetch', …)` / `vi.unstubAllGlobals()` by hand. The unit suite
 * runs under vitest AND under `bun test` (the production runtime; see the
 * `test:bun` script), and bun:test's `vi` has neither.
 */
const realFetch = globalThis.fetch;

import type { FetchFunction } from '../../lib/fetch-function.js';

export function stubFetch(stub: FetchFunction): void {
  // The one place a bare call stands in for the global: no code under test
  // reaches for `fetch.preconnect`.
  globalThis.fetch = stub as typeof fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}
