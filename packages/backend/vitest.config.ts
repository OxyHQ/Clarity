import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Same source the esbuild bundle and tsconfig `paths` use — see build.ts.
    alias: {
      '@clarity.surf/sdk/vocabularies': fileURLToPath(new URL('../sdk/src/vocabularies.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
    },
    // Allow enough time for repository and stream boundary tests
    testTimeout: 10000,
  },
});
