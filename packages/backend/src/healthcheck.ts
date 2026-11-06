/**
 * Exit status of the crawl worker's ECS health check (`lib/liveness.ts`):
 * 0 while the crawl loop is beating, 1 once it has been silent too long.
 */
import { LIVENESS_MAX_AGE_MS, livenessAgeMs } from './lib/liveness.js';

const age = livenessAgeMs();
if (age === undefined || age > LIVENESS_MAX_AGE_MS) {
  console.error(
    age === undefined
      ? 'crawl worker has not recorded a heartbeat'
      : `crawl worker silent for ${Math.round(age / 1000)} s (limit ${LIVENESS_MAX_AGE_MS / 1000} s)`,
  );
  process.exit(1);
}
