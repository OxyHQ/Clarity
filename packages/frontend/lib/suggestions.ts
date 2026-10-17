/**
 * Clarity's suggestions (its own product data, `POST /suggestions/*`), offered by
 * the search page. Pure: nothing here loads React Native.
 */

/** One suggestion as `/suggestions/welcome` and `/suggestions/search` answer it. */
export interface Suggestion {
  suggestionId: string;
  title: string;
  text: string;
  description?: string;
  isTemplate: boolean;
  type: 'welcome' | 'autocomplete';
  language: string;
}

const SUGGESTION_LANGUAGE = /^[a-z]{2}-[A-Z]{2}$/;

/**
 * The language the suggestion pool is asked for: the app's locale as `xx-YY`
 * (`es-ES`), the form the pool is stored in. A bare language (`es`) or another
 * shape asks for nothing, and the server answers its default.
 */
export function suggestionLanguage(locale: string): string | undefined {
  const tag = locale.replace('_', '-');
  return SUGGESTION_LANGUAGE.test(tag) ? tag : undefined;
}
