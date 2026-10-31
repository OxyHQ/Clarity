import { nextUnvisitedCursor } from '@oxy.so/utils/paging';

/** Stop when the directory returns an empty or previously visited cursor. */
export function getNextOrganizationPage(
  page: { nextCursor: string | null },
  _pages: unknown[],
  _lastPageParam: string | undefined,
  pageParams: (string | undefined)[],
): string | undefined {
  return nextUnvisitedCursor(page.nextCursor, pageParams);
}
