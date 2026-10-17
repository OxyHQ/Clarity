/**
 * Clarity API routes the app calls with the signed-in client. Public reads
 * (jobs, news, market) go through `public-request.ts` with their own paths.
 */
export const API_ROUTES = {
  suggestions: {
    welcome: '/suggestions/welcome',
    search: '/suggestions/search',
    use: (id: string) => `/suggestions/${encodeURIComponent(id)}/use`,
  },
} as const;
