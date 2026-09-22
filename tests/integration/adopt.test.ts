import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adopt } from '../../src/project/adopt.js';

const CONFIG = { schemaVersion: 1, projectId: '11111111-2222-3333-4444-555555555501', projectName: 'P', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'] };

test('adoção é idempotente e preserva conteúdo do usuário', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc project '));
  const cfg = join(root, 'config.json');
  await writeFile(cfg, JSON.stringify(CONFIG));
  await writeFile(join(root, 'AGENTS.md'), 'user instructions\n');
  const first = await adopt(root, cfg, true);
  const second = await adopt(root, cfg, true);
  assert.equal(first.changed.length, 5); // config, AGENTS, hook, gitignore, shim local
  assert.equal(second.changed.length, 0);
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /user instructions/);
});

// R14: hooks instalados no formato Codex (<repo>/.codex/hooks.json), gitignore com exclusões, backup de preexistente.
test('adoção instala hooks e exclusões com backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-'));
  const cfg = join(root, 'config.json');
  await writeFile(cfg, JSON.stringify(CONFIG));
  await writeFile(join(root, 'AGENTS.md'), 'orig\n');
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  const result = await adopt(root, cfg, true);
  assert.ok(result.changed.some(f => f.replace(/\\/g, '/').endsWith('.codex/hooks.json')));
  const installedHooks = JSON.parse(await readFile(join(root, '.codex', 'hooks.json'), 'utf8')) as any;
  const sessionStart = installedHooks.hooks.SessionStart[0].hooks[0];
  assert.match(sessionStart.commandWindows, /^".+node\.exe" ".+cli\.js" hook SessionStart$/i);
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /node_modules/);
  assert.match(ignore, /runtime\.json/);
  assert.match(await readFile(join(root, 'AGENTS.md.bak'), 'utf8'), /orig/);
  // Segunda adoção não duplica blocos.
  await adopt(root, cfg, true);
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(agents.split('sdlc-codex:begin').length, 2);
});
