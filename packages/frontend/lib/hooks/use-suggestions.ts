import { useMutation, useQuery } from '@tanstack/react-query';

import { useTranslation } from '@/hooks/useTranslation';

import { useApiClient } from '../api/use-api-client';
import { API_ROUTES } from '../api/routes';
import { type Suggestion, suggestionLanguage } from '../suggestions';
import { queryKeys } from './query-keys';

/** The app's language for the pool, or nothing (the server's default). */
function useSuggestionLanguage(): string | undefined {
  const { locale } = useTranslation();
  return suggestionLanguage(locale);
}

/** The welcome suggestions over Clarity's empty chat, from its own pool. */
export function useWelcomeSuggestions() {
  const client = useApiClient();
  const language = useSuggestionLanguage();
  return useQuery<Suggestion[]>({
    queryKey: queryKeys.suggestions.welcome(language),
    queryFn: async () => {
      const data = await client.post<{ suggestions: Suggestion[] }>(
        API_ROUTES.suggestions.welcome,
        { count: 4, ...(language ? { language } : {}) },
      );
      return data.suggestions;
    },
    staleTime: 1000 * 60 * 15,
    placeholderData: (previous: Suggestion[] | undefined) => previous,
    retry: 1,
  });
}

/** What the pool has for the text being typed (the composer debounces it). */
export function useSearchSuggestions(query: string) {
  const client = useApiClient();
  const language = useSuggestionLanguage();
  return useQuery<Suggestion[]>({
    queryKey: queryKeys.suggestions.search(query, language),
    queryFn: async () => {
      const data = await client.post<{ suggestions: Suggestion[] }>(API_ROUTES.suggestions.search, {
        query,
        limit: 6,
        ...(language ? { language } : {}),
      });
      return data.suggestions;
    },
    enabled: query.trim().length >= 2,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    retry: 0,
  });
}

/** Count a picked suggestion (fire and forget). */
export function useRecordSuggestionUsage() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (suggestionId: string) => client.post(API_ROUTES.suggestions.use(suggestionId), {}),
  });
}
