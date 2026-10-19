import { createEcosystemTraffic } from '@oxy.so/core/server';
import {
  getClarityServiceToken,
  hasExactClarityServiceConfiguration,
} from './clarity-service-auth.js';
import { createLogger } from './logger.js';

const log = createLogger('platform-activity');

/** How long publishing may fail before it is reported as an outage. */
const OUTAGE_AFTER_MS = 60_000;

/**
 * The publisher retries a failed publish within seconds, and a single failure
 * (a token re-mint, a slow response) usually succeeds on that retry. Report
 * only failures that last, with the error that caused them; the core default
 * logged every blip as "unavailable" and discarded the error.
 */
function outageReporter() {
  let failure: { error: unknown; since: number; timer: ReturnType<typeof setTimeout> } | undefined;
  return {
    onError(error: unknown) {
      log.debug({ err: error }, 'Ecosystem activity publish failed; retrying');
      if (failure) return;
      const timer = setTimeout(
        () => log.warn({ err: error }, 'Ecosystem activity publisher unavailable; backing off'),
        OUTAGE_AFTER_MS,
      );
      timer.unref?.();
      failure = { error, since: Date.now(), timer };
    },
    onRecover() {
      if (!failure) return;
      clearTimeout(failure.timer);
      const failedForMs = Date.now() - failure.since;
      if (failedForMs >= OUTAGE_AFTER_MS)
        log.info({ failedForMs }, 'Ecosystem activity publisher recovered');
      failure = undefined;
    },
  };
}

/** Start once per deployed process; local sessions have no infrastructure location. */
export function startPlatformActivity(ready: () => boolean, service = 'clarity') {
  if (process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED !== 'true') return undefined;
  if (!hasExactClarityServiceConfiguration())
    throw new Error('Ecosystem activity requires the canonical Clarity service configuration');
  const traffic = createEcosystemTraffic({
    service,
    ready,
    credential: getClarityServiceToken,
    ...outageReporter(),
  });
  traffic.installFetch();
  return traffic;
}
