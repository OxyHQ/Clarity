/**
 * A failed start of a built backend entrypoint must END THE PROCESS NON-ZERO.
 *
 * Executes the BUILT artefacts the way the production image runs them, under
 * `bun` (the image's runtime and command), from the repository root with
 * `NODE_ENV=production`:
 *   - `bun packages/backend/dist/index.js`       the image's CMD (clarity-api)
 *   - `bun packages/backend/dist/worker.js`      clarity-worker's command (oxy-infra)
 *   - `bun packages/backend/dist/db/migrate.js`  the deploy's one-shot, whose exit
 *     code `.github/scripts/deploy-ecs-service.sh` reads
 * never `src/`, which is a different file from the bundle the image ships.
 *
 * Why it exists: the API's process-level `uncaughtException` handler defers its
 * exit to an unref'd 5 s timer. An unref'd timer does not keep the event loop
 * alive and registering the handler stops the runtime exiting by itself, so if
 * nothing else holds the loop open a throw at boot drains it and the process
 * exits 0 — on Node and on Bun alike (measured) — a crashed boot every
 * orchestrator reads as success. Today something holds the loop open and the
 * timer fires; this keeps that true.
 *
 * Every failure scenario asserts BOTH the exit code and a log line proving the
 * process reached the failure being tested: a module that cannot even load also
 * exits non-zero and would otherwise satisfy this check vacuously. The positive
 * controls boot the server and shut it down with SIGTERM, and dry-run the
 * migrator, so "non-zero" cannot be explained by "this artefact never runs".
 * The worker has no positive control here: against a migrated database it
 * polls real job feeds. The image smoke (.github/scripts/smoke-backend-image.sh)
 * covers the image end to end.
 *
 * Usage: `bun run build:backend && bun run check:backend-entrypoints`.
 * Requires `TEST_DATABASE_URL`: a disposable, already-migrated `clarity_ci`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SERVER = 'packages/backend/dist/index.js';
const WORKER = 'packages/backend/dist/worker.js';
const MIGRATOR = 'packages/backend/dist/db/migrate.js';
// The image's runtime. Override only to compare runtimes, e.g. RUNTIME_BINARY=node.
const RUNTIME = process.env.RUNTIME_BINARY || 'bun';

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
}

interface Run {
  done: Promise<Outcome>;
  output: () => string;
  kill: (signal: NodeJS.Signals) => void;
}

function start(argv: string[], env: Record<string, string>, timeoutMs: number): Run {
  // Inherit nothing that could decide the scenario: PATH and HOME only, then
  // what the scenario sets. A developer's DATABASE_URL or PORT must not leak in.
  const child = spawn(RUNTIME, argv, {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const done = new Promise<Outcome>((resolve, reject) => {
    child.on('error', reject);
    // 'close', not 'exit': 'exit' can precede the last piped chunk.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
  return { done, output: () => output, kill: (signal) => child.kill(signal) };
}

function listenOnFreePort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve({ port: address.port, server });
      else reject(new Error('no port'));
    });
  });
}

async function freePort(): Promise<number> {
  const { port, server } = await listenOnFreePort();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const failures: string[] = [];

function check(scenario: string, condition: boolean, message: string, outcome?: Outcome): void {
  if (condition) return;
  failures.push(`${scenario}: ${message}`);
  if (outcome) {
    console.error(`--- ${scenario}: output (last 40 lines) ---`);
    console.error(outcome.output.split('\n').slice(-40).join('\n'));
  }
}

/** A failure: non-zero, not by timeout, after reaching every `reached` line. */
async function expectFailure(
  scenario: string,
  argv: string[],
  env: Record<string, string>,
  reached: string[],
): Promise<void> {
  const outcome = await start(argv, env, 30_000).done;
  check(scenario, !outcome.timedOut, 'still running after 30 s instead of exiting', outcome);
  check(
    scenario,
    outcome.code !== 0,
    `exited with code ${outcome.code} (signal ${outcome.signal}); a failure must be non-zero`,
    outcome,
  );
  for (const line of reached) {
    check(scenario, outcome.output.includes(line), `never logged ${JSON.stringify(line)}`, outcome);
  }
  console.log(`${scenario}: exit ${outcome.code}${outcome.timedOut ? ' (timed out)' : ''}`);
}

async function waitForLive(port: number, run: Run, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    if (run.output().includes('shutting down')) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    console.error('::error::TEST_DATABASE_URL is required (the positive control boots for real).');
    process.exit(1);
  }
  for (const entry of [SERVER, WORKER, MIGRATOR]) {
    if (!existsSync(join(ROOT, entry))) {
      console.error(`::error::${entry} does not exist; run \`bun run build:backend\` first.`);
      process.exit(1);
    }
  }

  // 1. A synchronous throw at boot AFTER the process handlers are registered:
  //    connectPostgres() rejects a malformed URL. This is the path the unref'd
  //    exit timer serves; asserting the handler's own line keeps the scenario
  //    measuring it. If boot is restructured so this no longer reaches the
  //    handler, this fails and a scenario that does must replace it.
  await expectFailure(
    'server: malformed DATABASE_URL',
    [SERVER],
    { DATABASE_URL: '::not-a-url', PORT: String(await freePort()) },
    ['[Process] Uncaught exception'],
  );

  // 2. No database at all. EMPTY rather than unset, so Bun's .env loading
  //    cannot fill it from a developer's .env in the working directory.
  await expectFailure('server: missing DATABASE_URL', [SERVER], { DATABASE_URL: '', PORT: '0' }, [
    'DATABASE_URL is required',
  ]);

  // 3. The port is taken.
  const held = await listenOnFreePort();
  await expectFailure(
    'server: port in use',
    [SERVER],
    { DATABASE_URL: databaseUrl, PORT: String(held.port) },
    ['Port already in use'],
  );
  await new Promise((resolve) => held.server.close(resolve));

  // 4. Positive control: the same artefact boots, answers, and a SIGTERM
  //    shutdown still reports success.
  const port = await freePort();
  const run = start([SERVER], { DATABASE_URL: databaseUrl, PORT: String(port) }, 60_000);
  const live = await waitForLive(port, run, 30_000);
  check('server: boots and shuts down', live, `never answered /health/live on port ${port}`);
  run.kill('SIGTERM');
  const outcome = await run.done;
  check('server: boots and shuts down', !outcome.timedOut, 'did not exit after SIGTERM', outcome);
  check(
    'server: boots and shuts down',
    outcome.code === 0,
    `a graceful shutdown exited with code ${outcome.code} (signal ${outcome.signal})`,
    outcome,
  );
  check(
    'server: boots and shuts down',
    outcome.output.includes('Graceful shutdown complete'),
    'never logged "Graceful shutdown complete"',
    outcome,
  );
  console.log(`server: boots and shuts down: live=${live}, exit ${outcome.code}`);

  // 5. The worker refuses to start without a database, and says why.
  await expectFailure('worker: missing DATABASE_URL', [WORKER], { DATABASE_URL: '' }, [
    'DATABASE_URL is required',
  ]);

  // 6. The migrator refuses a run with no --phase, and says why.
  const targetDatabase = new URL(databaseUrl).pathname.slice(1);
  await expectFailure(
    'migrator: missing --phase',
    [MIGRATOR, `--target-database=${targetDatabase}`],
    { DATABASE_URL: databaseUrl },
    ['--phase is required'],
  );

  // 7. ...and a run aimed at the wrong database.
  await expectFailure(
    'migrator: wrong target database',
    [MIGRATOR, '--target-database=not-this-one', '--phase=pre', '--dry-run'],
    { DATABASE_URL: databaseUrl },
    ['Refusing to migrate'],
  );

  // 8. Positive control: a dry run over the migrated database reaches its
  //    report and exits 0, writing nothing.
  const dryRun = await start(
    [MIGRATOR, `--target-database=${targetDatabase}`, '--phase=pre', '--dry-run'],
    { DATABASE_URL: databaseUrl },
    60_000,
  ).done;
  check('migrator: dry run', dryRun.code === 0, `exited with code ${dryRun.code}`, dryRun);
  check(
    'migrator: dry run',
    dryRun.output.includes('phase=pre'),
    'never reached its "phase=pre" report',
    dryRun,
  );
  console.log(`migrator: dry run: exit ${dryRun.code}`);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${failure}`);
    process.exit(1);
  }
  console.log(
    `Every built backend entrypoint exits non-zero on every failure tested under ${RUNTIME}, and 0 when it succeeds.`,
  );
}

await main();
