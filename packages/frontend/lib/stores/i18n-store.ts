import { create } from 'zustand';
import { getLocales } from 'expo-localization';
import i18n from '@/lib/i18n';

function getDeviceLocale(): string {
  const locales = getLocales();
  if (!locales || locales.length === 0) return 'en-US';
  return locales[0]?.languageTag || locales[0]?.languageCode || 'en-US';
}

interface I18nState {
  locale: string;
  setLocale: (locale: string) => void;
}

/**
 * In-memory only. Oxy resolves and owns the account/device locale and drives
 * it in through `OxyProvider`'s `onChange`; a persisted copy here previously
 * raced that resolution — async AsyncStorage rehydration could overwrite
 * `i18n.locale` with a stale value after Oxy had already applied the current
 * one, since Oxy's `onChange` only fires again when ITS resolved locale
 * changes.
 */
export const useI18nStore = create<I18nState>()((set) => ({
  locale: getDeviceLocale(),
  setLocale: (locale: string) => {
    i18n.locale = locale;
    set({ locale });
  },
}));
