import * as esbuild from 'esbuild';
import { cp } from 'fs/promises';
import { fileURLToPath } from 'node:url';

await esbuild.build({
  entryPoints: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
    'db/migrate': 'src/db/migrate.ts',
    'db/attest-cutover': 'src/db/attest-cutover.ts',
    'db/attest-fresh-install': 'src/db/attest-fresh-install.ts',
    // One-shot operator task: `node packages/backend/dist/db/import-places.js --target-database=clarity`.
    'db/import-places': 'src/scripts/import-geonames-places.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  // Keep node_modules external except @oxy.so/* (their ESM builds have broken imports)
  plugins: [{
    name: 'externalize-except-oxyhq',
    setup(build) {
      // The closed vocabularies (currencies, countries, job enums) are owned by
      // the public SDK and compiled into the API from source, so the API and
      // every SDK consumer validate against the same arrays without the
      // runtime image needing a built SDK.
      build.onResolve({ filter: /^@clarity\.surf\/sdk\/vocabularies$/ }, () => ({
        path: fileURLToPath(new URL('../sdk/src/vocabularies.ts', import.meta.url)),
      }));
      // Let @oxy.so/* packages be bundled (their ESM has missing .js extensions)
      build.onResolve({ filter: /^@oxyhq\// }, () => undefined);
      // Externalize all other bare imports (node_modules)
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.startsWith('@oxy.so/')) return undefined;
        return { path: args.path, external: true };
      });
    },
  }],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// Copy prompts directory to dist
try {
  await cp('prompts', 'dist/prompts', { recursive: true });
  console.log('✅ Copied prompts to dist/');
} catch (error) {
  console.error('⚠️ Failed to copy prompts:', error);
}

console.log('✅ Build complete');
