import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
    const deployment = readFileSync(join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'), 'utf8');
    const deployScript = readFileSync(join(repoRoot, '.github', 'scripts', 'deploy-ecs-service.sh'), 'utf8');
    expect(deployment).toContain('AWS_REGION: us-west-2');
    expect(deployment).toContain("workflows: [CI]");
    expect(deployment).toContain("cancel-in-progress: false");
    expect(deployment).toContain('arn:aws:iam::237343248947:role/oxy-clarity-github-deploy');
    expect(deployment).toContain('SERVICE: clarity-api');
    expect(deployment).toContain('CONTAINER_NAME: clarity-api');
    expect(deployment).toContain('SERVICE: clarity-worker');
    expect(deployment).toContain('https://api.clarity.surf');
    expect(deployment).not.toMatch(/OXY_SERVICE_API_SECRET\s*:/);
    expect(deployment).not.toMatch(/toJSON\(secrets\)/);
    expect(deployment).toMatch(/IMAGE_URI: .*@\$\{\{ steps\.build\.outputs\.digest \}\}/);
    expect(deployScript).toContain('Provision it in oxy-infra first');
    expect(deployScript).toContain('Rolling $SERVICE back');
    expect(deployScript).not.toContain('--force-new-deployment');
  });

  it('has one AWS backend deployment path and no stale App Platform or SST declarations', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    expect(existsSync(join(repoRoot, '.do', 'app.yaml'))).toBe(false);
    expect(existsSync(join(repoRoot, 'sst.config.ts'))).toBe(false);
    expect(packageJson.devDependencies).not.toHaveProperty('sst');
    expect(existsSync(join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'))).toBe(true);
  });

  it('serves the frontend from a Worker with no Pages default hostname', () => {
    // A Pages project ALWAYS serves `<project>.pages.dev` and Cloudflare offers
    // no way to switch it off, so the frontend had a second, byte-identical copy
    // at `clarity.pages.dev` that PRODUCTION_ORIGINS below does not admit: it
    // rendered the shell and failed every API call. `workers_dev = false` is
    // what makes `clarity.surf` the only name that reaches the deployment, so
    // this gate holds the Worker shape rather than the Pages shape.
    const frontendRoot = join(repoRoot, 'packages', 'frontend');
    const wrangler = readFileSync(join(frontendRoot, 'wrangler.toml'), 'utf8');
    expect(wrangler).toMatch(/^name = "clarity"$/m);
    expect(wrangler).toMatch(/^main = "worker\/index\.js"$/m);
    expect(wrangler).toMatch(/^workers_dev = false$/m);
    expect(wrangler).toMatch(/^directory = "\.\/dist"$/m);
    expect(wrangler).toMatch(/^binding = "ASSETS"$/m);
    expect(wrangler).toMatch(/^not_found_handling = "single-page-application"$/m);
    expect(wrangler).toMatch(/^pattern = "clarity\.surf"$/m);
    expect(wrangler).toMatch(/^custom_domain = true$/m);

    // The script has to be the Worker `main`. Under `public/` it is inert AND
    // uploaded as a public asset, and `_redirects` is a Pages-only file.
    expect(existsSync(join(frontendRoot, 'worker', 'index.js'))).toBe(true);
    expect(existsSync(join(frontendRoot, 'public', '_worker.js'))).toBe(false);
    expect(existsSync(join(frontendRoot, 'public', '_redirects'))).toBe(false);

    // Comments stripped first: the workflow explains at length why it does not
    // use `cloudflare/wrangler-action`, and a gate that reads prose would fail
    // on the explanation instead of on a reintroduction.
    const frontendDeployment = readFileSync(join(repoRoot, '.github', 'workflows', 'deploy.yml'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(frontendDeployment).toContain('cd packages/frontend && bunx wrangler@4 deploy');
    expect(frontendDeployment).not.toMatch(/pages deploy|pages\/projects|production_branch/);

    // The deploy runs OUR wrangler, pinned. `cloudflare/wrangler-action` installs
    // its own into the working tree mid-deploy, which is how run 34063685022
    // failed here on 2026-09-06 (`Fail extracting tarball for "wrangler"`) and
    // how Homiio lost production on 2026-08-09. It also picks its package
    // manager from a lockfile beside `workingDirectory`, and this monorepo's
    // lockfile is at the root, so npm gets `workspace:*` and cannot resolve it.
    // Unpinned, `bunx wrangler` would re-resolve the latest major on every
    // deploy and change the deploy path with no diff.
    expect(frontendDeployment).not.toContain('wrangler-action');
    expect(frontendDeployment).not.toMatch(/bunx wrangler(?!@4\b)/);

    // The Worker deploy is the frontend's alone. The backend is ECS, and a
    // Cloudflare credential must never turn up on that path.
    const backendDeployment = readFileSync(join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'), 'utf8');
    expect(backendDeployment).not.toMatch(/CLOUDFLARE_|wrangler/);
    expect(readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')).not.toContain('pages.dev');
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
      join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'),
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
      join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'),
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
