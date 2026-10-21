import { useCallback } from 'react';
import i18n from '@/lib/i18n';
import { useI18nStore } from '@/lib/stores/i18n-store';

/**
 * Custom hook for using translations in components.
 * Uses Zustand store so locale changes propagate to ALL components.
 *
 * `t` keeps its identity until the language changes, so a hook that lists `t`
 * as a dependency re-runs on a language switch, not on every render.
 */
export function useTranslation() {
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);

  // biome-ignore lint/correctness/useExhaustiveDependencies: i18n.t reads the global i18n.locale, which setLocale keeps equal to `locale`; t must change identity with it
  const t = useCallback(
    (key: string, params?: Record<string, unknown>) => {
      return i18n.t(key, params);
    },
    [locale],
  );

  return { t, locale, changeLocale: setLocale };
}
