import { defineConfig } from 'vitest/config';

/**
 * Tests for the frontend's PURE modules — the ones that decide what a screen
 * shows without rendering anything.
 *
 * Deliberately narrow. Nothing here loads React Native, NativeWind, Expo or a
 * renderer, so `lib/` is the whole surface: a harness that has to boot the
 * native module graph to assert on a formatted price is the kind that ends up
 * green while measuring nothing. Screens stay testable by keeping their
 * decisions in `lib/` and rendering the result.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['lib/**/__tests__/**/*.test.ts'],
  },
});
