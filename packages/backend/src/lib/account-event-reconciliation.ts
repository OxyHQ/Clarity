import { commitAccountEventPage, readAccountEventCursor } from '../db/experience-repository.js';
import { oxyClient } from '../middleware/auth.js';
import { CLARITY_IDENTITY } from './clarity-identity.js';
import { assertClarityWorkloadIdentity } from './clarity-service-auth.js';

/** Bounded catch-up alongside the worker's normal maintenance, independent of Alia. */
export async function reconcileAccountEvents(): Promise<number> {
  const applicationId = CLARITY_IDENTITY.backendApplication.applicationId;
  await assertClarityWorkloadIdentity();
  let cursor = await readAccountEventCursor(applicationId);
  let processed = 0;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await oxyClient.accountEvents.list({
      ...(cursor ? { after: cursor } : {}),
      limit: 100,
    });
    if (page.events.length === 0) break;
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error('Account event feed did not advance');
    // Never trust unsigned metadata beside a token. Verify the whole page
    // before any erasure or checkpoint; an invalid token cannot be skipped.
    const events = await Promise.all(
      page.events.map((item) =>
        oxyClient.accountEvents.verify(item.token, { audience: applicationId }),
      ),
    );
    if (!(await commitAccountEventPage(applicationId, cursor, page.nextCursor, events))) break;
    processed += events.length;
    cursor = page.nextCursor;
    if (page.events.length < 100) break;
  }
  return processed;
}
