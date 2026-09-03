import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildClarityAgentBootstrap } from '../lib/clarity-agent-manifest.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const prompt = readFileSync(resolve(packageRoot, 'prompts', 'base.md'), 'utf8');
process.stdout.write(`${JSON.stringify(buildClarityAgentBootstrap(prompt), null, 2)}\n`);
