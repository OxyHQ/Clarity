import * as esbuild from 'esbuild';
import { cp } from 'fs/promises';

await esbuild.build({
  entryPoints: { index: 'src/index.ts', worker: 'src/worker.ts', 'db/migrate': 'src/db/migrate.ts' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  // Keep node_modules external except @oxy.so/* (their ESM builds have broken imports)
  plugins: [{
    name: 'externalize-except-oxyhq',
    setup(build) {
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
