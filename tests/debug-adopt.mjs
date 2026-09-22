import { adopt } from '../dist/src/project/adopt.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG = { schemaVersion: 1, projectId: 'p', projectName: 'P', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'] };

const root = await mkdtemp(join(tmpdir(), 'sdlc-'));
const cfg = join(root, 'config.json');
await writeFile(cfg, JSON.stringify(CONFIG));
await writeFile(join(root, 'AGENTS.md'), 'orig\n');
await writeFile(join(root, '.gitignore'), 'node_modules\n');
const result = await adopt(root, cfg, true);
console.log('changed:', result.changed);
console.log('endsWith .codex/hooks.json:', result.changed.some(f => f.endsWith('.codex/hooks.json')));