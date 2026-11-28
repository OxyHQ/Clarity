/**
 * The semantic-search off switch: `CLARITY_SEMANTIC_SEARCH=off`.
 *
 * Unset (or anything but `off`), search is unchanged: hybrid and semantic
 * searches embed the query and read the nearest chunks (nearest-chunks.ts).
 *
 * `off` is the operator's lever for a database that cannot serve the semantic
 * arm, for example while the HNSW index over the chunks' binary codes does not
 * exist yet: without it `order by code <~> …` scans every embedded chunk, on a
 * cluster other products share. Off:
 *
 * - No search embeds its query (no Kaana call) or reads a chunk code or
 *   vector: `nearestChunks` is never reached.
 * - `POST /v1/search` and `POST /v1/jobs/search` rank lexically and answer
 *   `degraded: { from: 'hybrid', to: 'lexical', reason: 'semantic_off' }`;
 *   `mode: 'semantic'` answers `503 semantic_unavailable`.
 * - Indexing is untouched: chunks are still embedded and their codes and
 *   vectors written (that is `CLARITY_EMBEDDINGS_ENABLED`), so turning it back
 *   on needs no catch-up.
 *
 * It is read on every search, so a test (or a future runtime toggle) needs no
 * restart; a deploy sets it through the task definition's environment.
 */
import { createLogger } from '../lib/logger.js';

const log = createLogger('search');

let reportedOff = false;

/** Whether searches may run the semantic arm. On unless `CLARITY_SEMANTIC_SEARCH` is `off`. */
export function semanticSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLARITY_SEMANTIC_SEARCH?.trim().toLowerCase() !== 'off') return true;
  if (!reportedOff) {
    reportedOff = true;
    log.warn(
      'Semantic search is off (CLARITY_SEMANTIC_SEARCH=off): searches rank lexically and read no chunk codes or vectors',
    );
  }
  return false;
}
