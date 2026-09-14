import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import en from './locales/en.json';
import es from './locales/es.json';

// Using BCP 47 locale codes (en-US, es-ES) with fallback to language codes (en, es)
const translations = {
  'en': en,
  'en-US': en,
  'en-GB': en,
  'en-CA': en,
  'es': es,
  'es-ES': es,
  'es-MX': es,
  'es-AR': es,
} as const;

/**
 * The exact locale codes this app ships a translation catalog for — the keys
 * `i18n` below resolves to a dictionary for. This is the single source of
 * truth `app/_layout.tsx` feeds `OxyProvider`'s `language.supportedLocales`,
 * so the two can never drift apart the way they used to
 * (`components/language-selector.tsx` once hard-coded its own, narrower
 * subset of this list).
 */
export const SUPPORTED_LOCALES: readonly string[] = Object.keys(translations);

export const DEFAULT_LOCALE = 'en-US';

// Create i18n instance with translations
const i18n = new I18n(translations);

/**
 * Get the device's current locale
 * Returns full locale code (e.g., "en-US") or falls back to language code (e.g., "en")
 */
function getDeviceLocale(): string {
  const locales = getLocales();
  if (!locales || locales.length === 0) {
    return 'en-US';
  }

  // Try to use full locale code (e.g., "en-US")
  const fullLocale = locales[0]?.languageTag;
  if (fullLocale) {
    return fullLocale;
  }

  // Fallback to language code (e.g., "en")
  return locales[0]?.languageCode ?? 'en-US';
}

// Set the locale from device settings
i18n.locale = getDeviceLocale();

// Enable fallback to base language if specific regional variant is missing
// e.g., if es-MX is not found, it will try 'es', then 'en'
i18n.enableFallback = true;
i18n.missingBehavior = 'guess';

// Default locale
i18n.defaultLocale = DEFAULT_LOCALE;

export default i18n;
