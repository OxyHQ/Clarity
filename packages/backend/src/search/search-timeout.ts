/** Bounds every search ranking shares (document and job search). */
/**
 * The longest a ranking may run. A caller that gives up does not stop a query
 * already in Postgres, so without this an abandoned search keeps reading the
 * index and slows the searches behind it.
 *
 * Sized from production (2026-10-17): with the shared instance's disk busy, a
 * cold hybrid ranking reads ~10k blocks at ~1.3 ms each and takes 7–10 s; warm
 * it takes milliseconds. With the query embedding (2.5 s) that answers inside
 * the SDK's 15 s whenever the index fills the page; web discovery (5 s) runs
 * only when it does not.
 */
export const SEARCH_STATEMENT_TIMEOUT_MS = 10_000;
const QUERY_CANCELED = '57014';

export function isStatementTimeout(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === QUERY_CANCELED) return true;
  }
  return false;
}
