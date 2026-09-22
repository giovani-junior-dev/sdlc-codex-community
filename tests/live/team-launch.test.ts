import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runtime } from '../../src/contracts.js';
import { FEATURE_TEAM_ROLES, runLivePilot, validateUpResult } from './harness.js';

const enabled = process.env.SDLC_LIVE === '1' && process.env.SDLC_LIVE_FIVE === '1';

test('abre os cinco papéis reais com identidades distintas e readiness no Herdr', {
  skip: enabled ? false : 'defina SDLC_LIVE=1, SDLC_LIVE_FIVE=1 e SDLC_LIVE_TARGET',
}, async () => {
  const result = await runLivePilot({
    live: process.env.SDLC_LIVE,
    target: process.env.SDLC_LIVE_TARGET,
    expectedTmpPrefix: tmpdir(),
  }, {}, {
    trustProject: true,
    bypassHookTrust: true,
    windowsSandbox: 'unelevated',
  });

  const target = process.env.SDLC_LIVE_TARGET!;
  const runtime = JSON.parse(await readFile(join(target, '.sdlc-codex', 'runtime.json'), 'utf8')) as Runtime;
  const ready = runtime.sessions.filter(session => session.status === 'ready');
  const current = FEATURE_TEAM_ROLES.map(role => ready.find(session => session.role === role));
  assert.ok(current.every(Boolean), 'cada papel possui uma geração ready persistida');
  assert.equal(new Set(current.map(session => session!.threadId)).size, FEATURE_TEAM_ROLES.length,
    'cada papel possui UUID de thread distinto');
  assert.equal(new Set(current.map(session => session!.generationId)).size, FEATURE_TEAM_ROLES.length,
    'cada papel possui generationId distinto');

  const upEntry = result.evidence.entries.find(entry => entry.step === 'up');
  assert.equal(upEntry?.exitCode, 0);
  const teamEntry = result.evidence.entries.find(entry => entry.step === 'up-team');
  assert.match(teamEntry?.summary ?? '', /planner:ready/);
  assert.match(teamEntry?.summary ?? '', /document:ready/);

  validateUpResult({
    slug: 'pilot', workflow: 'feature', partial: false,
    team: current.map(session => ({
      role: session!.role,
      generationId: session!.generationId,
      paneId: session!.paneId,
      ready: true,
    })),
  });
});
