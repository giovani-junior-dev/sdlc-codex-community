import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { CodexTransport } from '../../src/adapters/codex.js';
import { NodeProcessRunner } from '../../src/adapters/process.js';
import type { Runtime } from '../../src/contracts.js';
import { validateLiveEnv } from './harness.js';

const enabled = process.env.SDLC_LIVE === '1';

test('registro SessionStart e fila bidirecional com duas sessões reais', {
  skip: enabled ? false : 'defina SDLC_LIVE=1 e SDLC_LIVE_TARGET',
}, async () => {
  const validation = await validateLiveEnv({
    live: process.env.SDLC_LIVE,
    target: process.env.SDLC_LIVE_TARGET,
    expectedTmpPrefix: tmpdir(),
  });
  const target = validation.target;
  const configPath = join(target, 'project-config.json');
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value) };

  assert.equal(await runCli(['adopt', '--config', configPath, '--project', target, '--apply', '--json'], io), 0, err.join('\n'));
  out.length = 0;
  err.length = 0;
  const upCode = await runCli(['up', 'live-two', '--workflow', 'review-only', '--roles', 'planner,reviewer', '--trust-project', '--bypass-hook-trust', '--project', target, '--json'], io);
  assert.equal(upCode, 0, err.join('\n'));
  const up = JSON.parse(out.join('\n')) as { partial: boolean; team: Array<{ role: string; ready: boolean; generationId: string }> };
  assert.equal(up.partial, false, JSON.stringify(up));
  assert.deepEqual(up.team.map(x => x.role), ['planner', 'reviewer']);
  assert.ok(up.team.every(x => x.ready && x.generationId));

  const runtime = JSON.parse(await readFile(join(target, '.sdlc-codex', 'runtime.json'), 'utf8')) as Runtime;
  const planner = runtime.sessions.find(s => s.role === 'planner' && s.status === 'ready');
  const reviewer = runtime.sessions.find(s => s.role === 'reviewer' && s.status === 'ready');
  assert.ok(planner?.threadId, 'SessionStart real registrou UUID do planner');
  assert.ok(reviewer?.threadId, 'SessionStart real registrou UUID do reviewer');

  const transport = new CodexTransport(new NodeProcessRunner());
  const marker = `SDLC_LIVE_TWO_${Date.now()}`;
  const toReviewer = await transport.queue(reviewer.threadId, `${marker}: planner -> reviewer`, 30_000);
  const toPlanner = await transport.queue(planner.threadId, `${marker}: reviewer -> planner`, 30_000);
  assert.equal(toReviewer.status, 'enqueued', toReviewer.reason ?? toReviewer.result.stderr);
  assert.equal(toPlanner.status, 'enqueued', toPlanner.reason ?? toPlanner.result.stderr);
});
