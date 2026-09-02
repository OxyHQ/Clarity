import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(packageRoot, '..', '..');

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const absolute = join(root, entry);
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute];
  });
}

function relativeToRepo(file: string): string {
  return relative(repoRoot, file).replaceAll('\\', '/');
}

describe('architecture gates', () => {
  it('contains no MongoDB/Mongoose code, dependency, environment, or deployment binding', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    } as Record<string, string>;
    expect(dependencies).not.toHaveProperty('mongoose');
    expect(dependencies).not.toHaveProperty('mongodb');

    const scanFiles = [
      ...filesUnder(join(packageRoot, 'src')).filter((file) => file.endsWith('.ts')),
      join(packageRoot, '.env.example'),
      join(repoRoot, '.do', 'app.yaml'),
      join(repoRoot, 'sst.config.ts'),
    ].filter((file) => !file.endsWith('architecture-gates.test.ts'));
    const source = scanFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/\b(?:mongoose|mongodb|MONGODB_URI)\b/i);
    expect(source).not.toMatch(/mongodb\+srv:\/\//i);
  });

  it('contains no inference provider adapter, key store, key env, or endpoint', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const directDependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    } as Record<string, string>;
    const forbiddenDirectPackages = Object.keys(directDependencies).filter((name) =>
      name === 'ai' || /^@ai-sdk\/(?!react$)/.test(name)
    );
    expect(forbiddenDirectPackages).toEqual([]);

    const frontendPackageJson = JSON.parse(readFileSync(join(repoRoot, 'packages', 'frontend', 'package.json'), 'utf8'));
    const frontendDependencies = {
      ...(frontendPackageJson.dependencies ?? {}),
      ...(frontendPackageJson.devDependencies ?? {}),
    } as Record<string, string>;
    expect(frontendDependencies).not.toHaveProperty('ai');
    expect(frontendDependencies).not.toHaveProperty('openai');
    expect(Object.keys(frontendDependencies).filter((name) => name.startsWith('@ai-sdk/'))).toEqual([]);

    const scanFiles = [
      ...filesUnder(join(packageRoot, 'src')).filter((file) => file.endsWith('.ts')),
      join(packageRoot, '.env.example'),
      join(repoRoot, '.do', 'app.yaml'),
      join(repoRoot, 'sst.config.ts'),
    ].filter((file) => !file.endsWith('architecture-gates.test.ts'));
    const source = scanFiles.map((file) => `${relativeToRepo(file)}\n${readFileSync(file, 'utf8')}`).join('\n');

    const inferenceOwnerNames = [
      'OPENAI', 'ANTHROPIC', 'GOOGLE', 'GROQ', 'MISTRAL', 'DEEPSEEK',
      'TOGETHER', 'CEREBRAS', 'OPENROUTER', 'REPLICATE', 'COHERE',
      'PERPLEXITY', 'SAMBANOVA', 'HYPERBOLIC', 'NOVITA', 'FIREWORKS', 'XAI',
    ];
    const keyEnvPattern = new RegExp(
      `\\b(?:${inferenceOwnerNames.join('|')})_(?:API_)?KEYS?\\b`,
    );
    expect(source).not.toMatch(keyEnvPattern);
    expect(source).not.toMatch(/\b(?:ProviderKey|INFERENCE_PROVIDER_SECRET_STORE)\b/);
    expect(source).not.toMatch(/internal\/providers|provider-key|gateway-client|provider-warmup/);
    expect(source).not.toMatch(/https:\/\/(?:api\.)?(?:openai|anthropic|groq|together|cerebras|mistral|deepseek|fireworks|perplexity|sambanova|hyperbolic|novita)\b/i);

    // Product/platform credentials and future listing/geocoding credentials
    // are separate from inference-provider custody. Do not broaden this gate
    // into a ban on Stripe, VAPID, maps, property feeds, or storage auth.
    expect(source).toContain('STRIPE_SECRET_KEY');
    expect(source).toContain('VAPID_PRIVATE_KEY');
  });

  it('keeps Alia-owned product surfaces allowlisted and disables pre-cutover seeding', () => {
    const index = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    expect(index).toContain("app.use('/memory', memoryRouter)");
    expect(index).toContain("app.use('/audit', auditRouter)");
    expect(index).toContain("app.use('/triggers', triggersRouter)");
    expect(index).toContain("app.use('/bots', botsRouter)");
    expect(index).toContain('app.use(requireRuntimeReady)');
    expect(index).not.toMatch(/seedSuggestions|seed-suggestions/);
    expect(index).not.toContain("app.use('/webhooks'");

    for (const route of ['memory.ts', 'audit.ts', 'triggers.ts', 'bots.ts']) {
      const source = readFileSync(join(packageRoot, 'src', 'routes', route), 'utf8');
      expect(source).toContain('proxyAliaJson');
      expect(source).not.toMatch(/req\.(?:originalUrl|url)/);
    }
  });

  it('keeps HTTP and Socket.IO closed until the exact cutover attestation is ready', () => {
    const index = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    const socket = readFileSync(join(packageRoot, 'src', 'socket.ts'), 'utf8');
    expect(index.indexOf("app.use('/health', healthRouter)")).toBeLessThan(
      index.indexOf('app.use(requireRuntimeReady)'),
    );
    expect(index.indexOf('app.use(requireRuntimeReady)')).toBeLessThan(
      index.indexOf("app.use('/auth', authRouter)"),
    );
    expect(socket).toContain('getRuntimeReadiness');
    expect(socket).not.toMatch(/subscribe-(?:agent|workflow|canvas)|agent-approval|agent-activity/);
  });

  it('keeps every generated migration explicitly phased and bind-free', () => {
    const sqlFiles = filesUnder(join(packageRoot, 'drizzle')).filter((file) => file.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(0);
    for (const file of sqlFiles) {
      const sql = readFileSync(file, 'utf8');
      expect(sql.match(/-- oxy:deploy-phase=(?:pre|post)/g)).toHaveLength(1);
      expect(sql).not.toMatch(/\$\d+/);
    }
  });
});
