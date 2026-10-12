/**
 * `vi.stubGlobal('fetch', …)` / `vi.unstubAllGlobals()` by hand. The unit suite
 * runs under vitest AND under `bun test` (the production runtime; see the
 * `test:bun` script), and bun:test's `vi` has neither.
 */
const realFetch = globalThis.fetch;

export function stubFetch(stub: typeof fetch): void {
  globalThis.fetch = stub;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}
