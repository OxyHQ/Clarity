import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

await esbuild.build({
  entryPoints: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
    'db/migrate': 'src/db/migrate.ts',
    'db/attest-cutover': 'src/db/attest-cutover.ts',
    'db/attest-fresh-install': 'src/db/attest-fresh-install.ts',
    // One-shot operator task: `bun packages/backend/dist/db/import-places.js --target-database=clarity`.
    'db/import-places': 'src/scripts/import-geonames-places.ts',
    'db/recover-duplicate-resolves': 'src/scripts/recover-duplicate-resolves.ts',
    // One-shot operator task: fills the job term bands the two-phase lexical
    // ranking reads (search/jobs/term-bands-backfill.ts).
    'db/backfill-job-term-bands': 'src/scripts/backfill-job-term-bands.ts',
    // One-shot operator task: copies the listings' vectors into their inline
    // table before the switch (search/jobs/search-vectors-copy.ts).
    'db/copy-job-search-vectors': 'src/scripts/copy-job-search-vectors.ts',
    // One-shot operator task (docs/search-storage.md): clears the page text and
    // JSON-LD documents store twice.
    'db/compact-document-text': 'src/scripts/compact-document-text.ts',
    // Oxy Files one-shots (docs/oxy-files.md). They run only inside an ECS task:
    // Clarity authenticates to Oxy by attesting its task role, nowhere else.
    'files/migrate-images-to-oxy': 'src/scripts/migrate-images-to-oxy.ts',
    'files/reconcile-references': 'src/scripts/reconcile-oxy-file-references.ts',
    'files/image-storage-status': 'src/scripts/image-storage-status.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  // Keep node_modules external except @oxy.so/* (their ESM builds have broken imports)
  plugins: [
    {
      name: 'externalize-except-oxyhq',
      setup(build) {
        // The closed vocabularies (currencies, countries, job enums) are owned by
        // the public SDK and compiled into the API from source, so the API and
        // every SDK consumer validate against the same arrays without the
        // runtime image needing a built SDK.
        build.onResolve({ filter: /^@clarity\.surf\/sdk\/vocabularies$/ }, () => ({
          path: fileURLToPath(new URL('../sdk/src/vocabularies.ts', import.meta.url)),
        }));
        build.onResolve({ filter: /^@clarity\.surf\/sdk\/experience$/ }, () => ({
          path: fileURLToPath(new URL('../sdk/src/experience.ts', import.meta.url)),
        }));
        // Let @oxy.so/* packages be bundled (their ESM has missing .js extensions)
        build.onResolve({ filter: /^@oxyhq\// }, () => undefined);
        // Externalize all other bare imports (node_modules)
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith('@oxy.so/')) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

console.log('✅ Build complete');
