import { createEcosystemTraffic } from '@oxy.so/core/server';
import { getClarityServiceToken, hasExactClarityServiceConfiguration } from './clarity-service-auth.js';

/** Start once per deployed process; local sessions have no infrastructure location. */
export function startPlatformActivity(ready: () => boolean, service = 'clarity') {
  if (process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED !== 'true') return undefined;
  if (!hasExactClarityServiceConfiguration()) throw new Error('Ecosystem activity requires the canonical Clarity service configuration');
  const traffic = createEcosystemTraffic({
    service,
    ready,
    credential: getClarityServiceToken,
  });
  traffic.installFetch();
  return traffic;
}
