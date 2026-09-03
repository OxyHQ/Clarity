import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildClarityAgentBootstrap, CLARITY_AGENT_MANIFEST } from '../lib/clarity-agent-manifest.js';

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
  it('pins the product, public app, backend payer identity, prompt and least-privilege grants', () => {
    expect(CLARITY_AGENT_MANIFEST).toMatchObject({
      projectAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
      botAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
      agentId: '01a0646a-078f-7642-95ef-439952f4f3f9',
      bindingApplicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
      publicApplication: {
        applicationId: '01a0646a-2382-74a3-a795-788924d55722',
        credentialId: '01a0646e-2508-7048-8c08-b1f7b3af634f',
        clientId: 'oxy_dk_75cdd9996d19362e15ddedcc5ab0f4fb310de8d7b5e8523a',
      },
      backendApplication: {
        applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
        credentialId: '01a0648b-8d74-7240-adba-80707fdfdf9c',
        clientId: 'oxy_dk_8c84c74a2656b8f5147d4d0b65fcd0e88c192ce64f465f78',
      },
    });
    expect(CLARITY_AGENT_MANIFEST.publicApplication.scopes).toEqual(['user:read']);
    expect(CLARITY_AGENT_MANIFEST.backendApplication.scopes).toEqual(['user:read', 'inference:invoke']);
    expect(CLARITY_AGENT_MANIFEST.capabilityGrants).toEqual(['web', 'artifacts', 'memory']);
    expect(CLARITY_AGENT_MANIFEST.capabilityGrants).not.toEqual(expect.arrayContaining([
      'browser', 'shell', 'files', 'messaging', 'automation', 'delegation', 'mcp', 'integration', 'agent',
    ]));
    const prompt = readFileSync(join(packageRoot, 'prompts', 'base.md'), 'utf8');
    expect(buildClarityAgentBootstrap(prompt).systemPrompt.content).toBe(prompt);

    const boundary = readFileSync(join(packageRoot, 'src', 'lib', 'alia-agent-client.ts'), 'utf8');
    expect(boundary).not.toContain('req.accessToken');
    expect(boundary).toContain("'X-Oxy-User-Id': userId");

    const botRoutes = readFileSync(join(packageRoot, 'src', 'routes', 'bots.ts'), 'utf8');
    expect(botRoutes).toMatch(/check-token\/:token', authenticateToken,/);

    const conversationRoutes = readFileSync(join(packageRoot, 'src', 'routes', 'conversations.ts'), 'utf8');
    expect(conversationRoutes).not.toContain('agentId');

    const frontend = readFileSync(join(repoRoot, 'packages', 'frontend', 'hooks', 'useStreamingChat.ts'), 'utf8');
    const requestBody = frontend.slice(
      frontend.indexOf('body: JSON.stringify({'),
      frontend.indexOf('signal: abortControllerRef.current.signal'),
    );
    expect(requestBody).not.toMatch(/agentId|agentMode|skillIds?|mcpServerId|fallbackPolicy|reasoningEffort|thinkingMode|webSearch|role:\s*['"]system/);

    const modelSelector = readFileSync(join(repoRoot, 'packages', 'frontend', 'components', 'model-selector.tsx'), 'utf8');
    expect(modelSelector).toContain("CLARITY_THINKING_MODEL_ID = 'clarity-thinking'");
    expect(modelSelector).not.toMatch(/id\.includes\(['"]thinking|thinkingModels\[[^\]]+\]/);

    const layout = readFileSync(join(repoRoot, 'packages', 'frontend', 'app', '_layout.tsx'), 'utf8');
    expect(layout).toContain(`clientId="${CLARITY_AGENT_MANIFEST.publicApplication.clientId}"`);
    const appPlatform = readFileSync(join(repoRoot, '.do', 'app.yaml'), 'utf8');
    const sst = readFileSync(join(repoRoot, 'sst.config.ts'), 'utf8');
    const deployments = `${appPlatform}\n${sst}`;
    expect(deployments).toContain(CLARITY_AGENT_MANIFEST.agentId);
    expect(deployments).toContain(CLARITY_AGENT_MANIFEST.backendApplication.clientId);
    expect(appPlatform).toContain('- key: OXY_SERVICE_API_SECRET\n        type: SECRET');
    expect(sst).toContain('{ key: "OXY_SERVICE_API_SECRET", type: "SECRET" }');
    expect(deployments).not.toMatch(/OXY_SERVICE_API_SECRET["']?,?\s*value:/);
  });

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
      'AI21', 'NEBIUS', 'NSCALE', 'CHUTES', 'OVH', 'ALIBABA', 'CLOUDFLARE',
      'SILICONFLOW',
    ];
    const keyEnvPattern = new RegExp(
      `\\b(?:${inferenceOwnerNames.join('|')})_(?:API_)?KEYS?\\b`,
    );
    expect(source).not.toMatch(keyEnvPattern);
    expect(source).not.toMatch(/\b(?:ProviderKey|INFERENCE_PROVIDER_SECRET_STORE)\b/);
    expect(source).not.toMatch(/internal\/providers|provider-key|gateway-client|provider-warmup/);
    expect(source).not.toMatch(/https:\/\/(?:api\.)?(?:openai|anthropic|groq|together|cerebras|mistral|deepseek|fireworks|perplexity|sambanova|hyperbolic|novita|ai21|nebius|nscale|chutes|ovh|alibaba|siliconflow)\b/i);

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
    const schema = readFileSync(join(packageRoot, 'src', 'db', 'schema', 'index.ts'), 'utf8');
    expect(index.indexOf("app.use('/health', healthRouter)")).toBeLessThan(
      index.indexOf('app.use(requireRuntimeReady)'),
    );
    expect(index.indexOf('app.use(requireRuntimeReady)')).toBeLessThan(
      index.indexOf("app.use('/auth', authRouter)"),
    );
    expect(socket).toContain('getRuntimeReadiness');
    expect(socket).not.toMatch(/subscribe-(?:agent|workflow|canvas)|agent-approval|agent-activity/);
    expect(schema).not.toMatch(/agentId:\s*text\('agent_id'\)|agentInfo:\s*jsonb\('agent_info'\)/);
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
