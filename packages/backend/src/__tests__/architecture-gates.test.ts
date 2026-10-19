import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLARITY_CAPABILITY_CATALOG } from '../capabilities/clarity.catalog.js';
import { CLARITY_IDENTITY } from '../lib/clarity-identity.js';

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

/** Every TypeScript file of the backend, the files that configure its runtime, and the deploy. */
function backendRuntimeSource(): string {
  const files = [
    ...filesUnder(join(packageRoot, 'src')).filter(
      (file) => file.endsWith('.ts') && !file.includes('__tests__'),
    ),
    join(packageRoot, '.env.example'),
    join(packageRoot, 'build.ts'),
    join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'),
    join(repoRoot, '.github', 'scripts', 'smoke-backend-image.sh'),
  ].filter((file) => !file.endsWith('architecture-gates.test.ts'));
  return files
    .map((file) => `${relativeToRepo(file)}\n${withoutRemovalList(readFileSync(file, 'utf8'))}`)
    .join('\n');
}

/**
 * The deploy's removal list names configuration that must be GONE, so it is
 * the one place a retired name belongs; the gates below read everything else.
 */
function withoutRemovalList(source: string): string {
  return source.replace(/^\s*TASK_CONFIGURATION_REMOVALS_JSON: .*$/gm, '');
}

describe('architecture gates', () => {
  it('pins the product, public app and backend identity and the exact backend scope set', () => {
    expect(CLARITY_IDENTITY).toMatchObject({
      projectAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
      publicApplication: {
        applicationId: '01a0646a-2382-74a3-a795-788924d55722',
        credentialId: '01a0646e-2508-7048-8c08-b1f7b3af634f',
        clientId: 'oxy_dk_75cdd9996d19362e15ddedcc5ab0f4fb310de8d7b5e8523a',
      },
      backendApplication: {
        applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
      },
    });
    expect(CLARITY_IDENTITY.workloadIdentity).toEqual({
      provider: 'aws-iam',
      roleArn: 'arn:aws:iam::237343248947:role/oxy-clarity-task',
      attestationId: 'wl_1553bb11eb957512b3cdc956',
    });
    expect(CLARITY_IDENTITY.publicApplication.scopes).toEqual(['user:read']);
    // Embeddings on kaana.ai, and the capability catalogue's three Oxy lanes.
    expect(CLARITY_IDENTITY.backendApplication.scopes).toEqual([
      'user:read',
      'inference:invoke',
      'catalogs:write',
      'capabilities:read',
      'capability-audit:write',
    ]);

    const layout = readFileSync(
      join(repoRoot, 'packages', 'frontend', 'app', '_layout.tsx'),
      'utf8',
    );
    expect(layout).toContain(`clientId="${CLARITY_IDENTITY.publicApplication.clientId}"`);
    const deployment = readFileSync(
      join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'),
      'utf8',
    );
    const deployScript = readFileSync(
      join(repoRoot, '.github', 'scripts', 'deploy-ecs-service.sh'),
      'utf8',
    );
    expect(deployment).toContain('AWS_REGION: us-west-2');
    expect(deployment).toContain('workflows: [CI]');
    expect(deployment).toContain('cancel-in-progress: false');
    expect(deployment).toContain('arn:aws:iam::237343248947:role/oxy-clarity-github-deploy');
    expect(deployment).toContain('SERVICE: clarity-api');
    expect(deployment).toContain('CONTAINER_NAME: clarity-api');
    expect(deployment).toContain('COMPANION_SERVICE: clarity-worker');
    expect(deployment).toContain('https://api.clarity.surf');
    expect(deployment).not.toMatch(/OXY_SERVICE_API_SECRET\s*:/);
    expect(deployment).not.toMatch(/toJSON\(secrets\)/);
    expect(deployment).toMatch(/IMAGE_URI: .*@\$\{\{ steps\.build\.outputs\.digest \}\}/);
    expect(deployScript).toContain('Provision it in oxy-infra first');
    expect(deployScript).toContain('Rolling $service back');
    expect(deployScript).not.toContain('--force-new-deployment');
    // Each revision is derived from the running one, so configuration the code
    // stopped reading is stripped here, from both services, or it rides along
    // on every release.
    expect(deployScript).toContain('TASK_CONFIGURATION_REMOVALS_JSON');
    expect(deployScript).toContain('would still carry removed configuration');
    const removals = deployment.match(/TASK_CONFIGURATION_REMOVALS_JSON: '(\[[^']*\])'/);
    expect(JSON.parse(removals?.[1] ?? '[]')).toEqual(
      expect.arrayContaining([
        'ALIA_API_URL',
        'CLARITY_ALIA_AGENT_ID',
        'OXY_SERVICE_API_KEY',
        'OXY_SERVICE_API_SECRET',
        'CLARITY_INTROSPECTION_CACHE_HMAC_KEY',
      ]),
    );
  });

  it('never calls Alia: the assistant is an ordinary Alia agent the frontend opens (Alia ADR 0020)', () => {
    const source = backendRuntimeSource();
    // No Alia origin, no pinned agent, no relay of a person as a header, no
    // product-paid chat, no proxy into Alia's own product surfaces.
    expect(source).not.toMatch(/api\.alia\.onl|ALIA_API_URL|CLARITY_ALIA_AGENT_ID/);
    expect(source).not.toMatch(/X-Oxy-User-Id|X-Oxy-Requester-Assertion|RequesterAssertion/i);
    expect(source).not.toMatch(/proxyAlia|fetchAlia|completeAsClarityAgent|alia-agent-client/);
    expect(source).not.toMatch(/clarity-agent-manifest|agentId|agent_id|aliaAgent/);
    expect(existsSync(join(packageRoot, 'prompts'))).toBe(false);

    const index = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    for (const retired of [
      '/conversations',
      '/clarity/search',
      '/credits',
      '/analytics',
      '/memory',
      '/audit',
      '/triggers',
      '/bots',
      '/models',
      '/internal',
    ]) {
      expect(index).not.toContain(`app.use('${retired}'`);
    }
    const v1 = readFileSync(join(packageRoot, 'src', 'routes', 'v1.ts'), 'utf8');
    expect(v1).not.toMatch(/chat\/completions|\/models|resolve-model|report-usage/);
    const schema = readFileSync(join(packageRoot, 'src', 'db', 'schema', 'index.ts'), 'utf8');
    expect(schema).not.toMatch(/clarity_conversations|clarity_messages|model_ids/);
  });

  it('draws its own search page over Alia’s conversation runtime, with no chat backend of its own (Alia ADR 0018/0020)', () => {
    const frontendRoot = join(repoRoot, 'packages', 'frontend');
    const frontendPackage = JSON.parse(readFileSync(join(frontendRoot, 'package.json'), 'utf8'));
    // 19.1.0 is the first SDK that sends the app assertion, without which Alia
    // cannot tell the assistant is opened inside Clarity (Alia ADR 0021); 21.0.0
    // labels the conversations Clarity starts; 21.2.0 lets Clarity's pure `lib/`
    // tell its catalogue's results apart (`@alia.onl/sdk/tools`); 21.3.0 is the
    // first that runs on Expo SDK 58 / React Native 0.88.
    expect(frontendPackage.dependencies['@alia.onl/sdk']).toBe('^21.3.0');
    const agent = readFileSync(join(frontendRoot, 'lib', 'clarity-agent.ts'), 'utf8');
    expect(agent).toContain("CLARITY_AGENT_ID = '01a0646a-078f-7642-95ef-439952f4f3f9'");
    // Clarity's interface is Clarity's; the conversation under it — the stream, the
    // messages, the history — is Alia's runtime, opened with Clarity's agent.
    const conversation = readFileSync(
      join(frontendRoot, 'hooks', 'useChatConversation.ts'),
      'utf8',
    );
    expect(conversation).toContain('useConversationThread(');
    expect(conversation).toContain('agentId: CLARITY_AGENT_ID');

    const frontend = ['app', 'components', 'hooks', 'lib']
      .flatMap((dir) => filesUnder(join(frontendRoot, dir)))
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes('__tests__'))
      .map((file) => `${relativeToRepo(file)}\n${readFileSync(file, 'utf8')}`)
      .join('\n');
    // No stream of its own, no Clarity model id, no route the backend deleted.
    expect(frontend).not.toMatch(/text\/event-stream|clarity\.(?:reasoning|tool_result|title)\b/);
    expect(frontend).not.toMatch(/clarity-(?:fast|v1|pro|thinking|pro-max)\b/);
    expect(frontend).not.toMatch(
      /['"`]\/(?:clarity\/search|conversations|credits|analytics|memory|audit|triggers|bots)\b/,
    );
    expect(frontend).not.toMatch(
      /\/v1\/chat\/completions|\/suggestions\/generate|\/auth\/authorize/,
    );
  });

  it('keeps no compatibility answer for a removed route', () => {
    for (const file of filesUnder(join(packageRoot, 'src', 'routes'))) {
      if (file.includes('__tests__')) continue;
      expect(readFileSync(file, 'utf8'), relativeToRepo(file)).not.toMatch(/status\(410\)/);
    }
  });

  it('serves its catalogue on its own hosts, ahead of every shared middleware', () => {
    expect(CLARITY_CAPABILITY_CATALOG).toMatchObject({
      appId: 'clarity',
      internalBaseUrl: 'https://api.clarity.surf',
      internalTransport: 'mcp',
      externalMcp: { resource: 'https://mcp.clarity.surf' },
    });
    const index = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    const mounted = index.indexOf('mountCapabilityLanes(app, capabilityLanes)');
    expect(mounted).toBeGreaterThan(0);
    for (const later of [
      "app.use(\n  '/v1',\n  cors(",
      'app.use(express.json(',
      'app.use(requireRuntimeReady)',
    ]) {
      expect(index.indexOf(later), later).toBeGreaterThan(mounted);
    }
    expect(index).toContain('void capabilityLanes.internal.bound()');
  });

  it('reads runtime secrets from SSM only: no workflow writes SSM or reads an app secret', () => {
    // SSM (`/oxy/clarity/*`, SecureString) is the single source of runtime
    // secrets; a value is set or rotated with `aws ssm put-parameter --overwrite`
    // by its owner (oxy-infra runbook 46). Until 2026-10-10 the backend deploy
    // copied GitHub repo secrets into SSM on every run, which made GitHub the
    // source of truth for production credentials. Every workflow is read, not
    // only the deploy, and comments are stripped so the explanation in the
    // workflow cannot trip the gate.
    const ciOnlySecrets = [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
    ];
    const workflowsRoot = join(repoRoot, '.github', 'workflows');
    const workflows = readdirSync(workflowsRoot)
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .map((file) => ({
        file,
        executable: readFileSync(join(workflowsRoot, file), 'utf8')
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('#'))
          .join('\n'),
      }));
    expect(workflows.map(({ file }) => file)).toContain('deploy-aws.yml');

    const secretsReadBy = (executable: string): string[] =>
      [...executable.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    const named = workflows.flatMap(({ executable }) => secretsReadBy(executable));
    expect(
      named.length,
      'no secret is read anywhere, so the matcher measures nothing',
    ).toBeGreaterThan(0);
    for (const name of new Set(named)) {
      expect(ciOnlySecrets, `a workflow reads app secret ${name} from GitHub`).toContain(name);
    }
    for (const { file, executable } of workflows) {
      expect(executable, `${file} writes SSM`).not.toMatch(/ssm\s+put-parameter/);
      expect(executable, file).not.toMatch(/\$\{\{[^}]*toJSON\s*\(\s*secrets\s*\)/);
    }
    const backend = workflows.find(({ file }) => file === 'deploy-aws.yml');
    expect(secretsReadBy(backend?.executable ?? '')).toEqual([]);
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
    const frontendDeployment = readFileSync(
      join(repoRoot, '.github', 'workflows', 'deploy.yml'),
      'utf8',
    )
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
    const backendDeployment = readFileSync(
      join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'),
      'utf8',
    );
    expect(backendDeployment).not.toMatch(/CLOUDFLARE_|wrangler/);
    expect(readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')).not.toContain('pages.dev');
  });

  it('contains no inference provider adapter, key store, key env, or endpoint', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const directDependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
    } as Record<string, string>;
    const forbiddenDirectPackages = Object.keys(directDependencies).filter(
      (name) => name === 'ai' || /^@ai-sdk\/(?!react$)/.test(name),
    );
    expect(forbiddenDirectPackages).toEqual([]);

    const frontendPackageJson = JSON.parse(
      readFileSync(join(repoRoot, 'packages', 'frontend', 'package.json'), 'utf8'),
    );
    const frontendDependencies = {
      ...(frontendPackageJson.dependencies ?? {}),
      ...(frontendPackageJson.devDependencies ?? {}),
    } as Record<string, string>;
    expect(frontendDependencies).not.toHaveProperty('ai');
    expect(frontendDependencies).not.toHaveProperty('openai');
    expect(Object.keys(frontendDependencies).filter((name) => name.startsWith('@ai-sdk/'))).toEqual(
      [],
    );

    const scanFiles = [
      ...filesUnder(join(packageRoot, 'src')).filter((file) => file.endsWith('.ts')),
      join(packageRoot, '.env.example'),
      join(repoRoot, '.github', 'workflows', 'deploy-aws.yml'),
    ].filter((file) => !file.endsWith('architecture-gates.test.ts'));
    const source = scanFiles
      .map((file) => `${relativeToRepo(file)}\n${readFileSync(file, 'utf8')}`)
      .join('\n');

    const inferenceOwnerNames = [
      'OPENAI',
      'ANTHROPIC',
      'GOOGLE',
      'GROQ',
      'MISTRAL',
      'DEEPSEEK',
      'TOGETHER',
      'CEREBRAS',
      'OPENROUTER',
      'REPLICATE',
      'COHERE',
      'PERPLEXITY',
      'SAMBANOVA',
      'HYPERBOLIC',
      'NOVITA',
      'FIREWORKS',
      'XAI',
      'AI21',
      'NEBIUS',
      'NSCALE',
      'CHUTES',
      'OVH',
      'ALIBABA',
      'CLOUDFLARE',
      'SILICONFLOW',
    ];
    const keyEnvPattern = new RegExp(`\\b(?:${inferenceOwnerNames.join('|')})_(?:API_)?KEYS?\\b`);
    expect(source).not.toMatch(keyEnvPattern);
    expect(source).not.toMatch(/\b(?:ProviderKey|INFERENCE_PROVIDER_SECRET_STORE)\b/);
    expect(source).not.toMatch(/internal\/providers|provider-key|gateway-client|provider-warmup/);
    expect(source).not.toMatch(
      /https:\/\/(?:api\.)?(?:openai|anthropic|groq|together|cerebras|mistral|deepseek|fireworks|perplexity|sambanova|hyperbolic|novita|ai21|nebius|nscale|chutes|ovh|alibaba|siliconflow)\b/i,
    );

    // Product/platform credentials and future listing/geocoding credentials
    // are separate from inference-provider custody. Do not broaden this gate
    // into a ban on Stripe, VAPID, maps, property feeds, or storage auth.
    expect(source).toContain('STRIPE_SECRET_KEY');
    expect(source).toContain('VAPID_PRIVATE_KEY');
  });

  it('mounts the signed account-erasure event ahead of readiness and seeds nothing', () => {
    const index = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    expect(index).toContain('app.use(requireRuntimeReady)');
    expect(index).not.toMatch(/seedSuggestions|seed-suggestions/);
    // Oxy's narrowly mounted signed account-erasure event is an identity
    // lifecycle boundary; there is no general webhook surface.
    expect(index).not.toContain("app.use('/webhooks'");
    expect(index).toContain("app.use('/webhooks/oxy/account-events', oxyAccountEventsRouter)");
    expect(
      index.indexOf("app.use('/webhooks/oxy/account-events', oxyAccountEventsRouter)"),
    ).toBeLessThan(index.indexOf('app.use(requireRuntimeReady)'));
    const accountEvents = readFileSync(
      join(packageRoot, 'src', 'routes', 'oxy-account-events.ts'),
      'utf8',
    );
    expect(accountEvents).toContain('oxyClient.accountEvents.verify');
    expect(accountEvents).toContain('audience: CLARITY_IDENTITY.backendApplication.applicationId');
    expect(accountEvents).toContain('eraseDeletedAccountExperience(event.userId, event.eventId)');
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
    expect(schema).not.toMatch(/agentId|agentInfo|aliaAgentIdSha256/);
  });

  it('reaches Oxy Files through one adapter, whose scopes never join the backend token tuple', () => {
    const sources = filesUnder(join(packageRoot, 'src')).filter(
      (file) => file.endsWith('.ts') && !file.includes('__tests__'),
    );
    const clientUsers = sources
      .filter((file) => readFileSync(file, 'utf8').includes('getClarityFilesClient('))
      .map(relativeToRepo)
      .sort();
    expect(clientUsers).toEqual([
      'packages/backend/src/files/oxy-files.ts',
      'packages/backend/src/lib/clarity-service-auth.ts',
    ]);
    // The backend token is minted as exactly its declared tuple, and no file
    // scope is declared in it or requested beside it.
    const auth = readFileSync(join(packageRoot, 'src', 'lib', 'clarity-service-auth.ts'), 'utf8');
    expect(auth).not.toMatch(/files:/);
    const identity = readFileSync(join(packageRoot, 'src', 'lib', 'clarity-identity.ts'), 'utf8');
    expect(identity).not.toMatch(/files:/);
    const triggers = readFileSync(
      join(packageRoot, 'drizzle', '0032_oxy_file_reference_triggers.sql'),
      'utf8',
    );
    for (const table of [
      'clarity_image_references',
      'clarity_search_documents',
      'clarity_job_postings',
    ])
      expect(triggers).toContain(`ON ${table}`);
  });

  it('keeps every generated migration explicitly phased and bind-free', () => {
    const sqlFiles = filesUnder(join(packageRoot, 'drizzle')).filter((file) =>
      file.endsWith('.sql'),
    );
    expect(sqlFiles.length).toBeGreaterThan(0);
    for (const file of sqlFiles) {
      const sql = readFileSync(file, 'utf8');
      expect(sql.match(/-- oxy:deploy-phase=(?:pre|post)/g)).toHaveLength(1);
      expect(sql).not.toMatch(/\$\d+/);
    }
  });
});
