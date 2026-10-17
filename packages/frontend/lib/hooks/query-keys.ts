export const queryKeys = {
  billing: {
    plans: (product?: string) => ['subscription-plans', product] as const,
    subscriptions: ['subscription'] as const,
    subscription: (product?: string) => ['subscription', product] as const,
    subscriptionPoll: (product?: string) => ['subscription-poll', product] as const,
  },
  jobs: {
    search: (request: unknown) => ['jobs', 'search', request] as const,
    detail: (id: string) => ['jobs', 'detail', id] as const,
  },
  products: {
    search: (query: string, market: string | undefined) =>
      ['products', 'search', query, market] as const,
    detail: (id: string) => ['products', 'detail', id] as const,
  },
  news: {
    list: (limit: number, languages: readonly string[]) =>
      ['news', 'list', limit, ...languages] as const,
  },
  market: {
    quotes: (assets: readonly string[]) => ['market', 'quotes', ...assets] as const,
  },
  suggestions: {
    welcome: (language: string | undefined) => ['suggestions', 'welcome', language] as const,
    search: (query: string, language: string | undefined) =>
      ['suggestions', 'search', query, language] as const,
  },
} as const;
