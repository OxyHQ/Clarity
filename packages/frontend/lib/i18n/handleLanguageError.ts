/**
 * `OxyProvider`'s `language` config reports a failed `onChange` here rather
 * than throwing into render — a rejected locale change (a missing catalog
 * entry, say) must not take the whole app tree down over a chrome-language
 * mismatch. Its own module, not inline in `app/_layout.tsx`: that file pulls
 * in the whole native provider stack (expo-font, expo-splash-screen, Bloom's
 * theme provider, …), which a test for this one pure function has no
 * business dragging in — `vitest.config.ts` only collects tests under
 * `lib/**\/__tests__/`, deliberately kept free of anything that loads React
 * Native, so this handler has to live here to be testable at all.
 */
export function handleLanguageError(error: unknown, locale: string): void {
  console.error('[i18n] Failed to follow the Oxy-resolved language', error, { locale });
}
