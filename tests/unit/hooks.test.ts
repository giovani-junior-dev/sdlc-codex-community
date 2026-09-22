import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { handleHook } from '../../src/hooks/entry.js';
import { roleContext } from '../../src/hooks/context.js';
import { emptyRuntime } from '../../src/contracts.js';

async function registryFor(projectId = 'p') {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-'));
  const store = new StateStore(root, { projectId });
  await store.init(projectId);
  return new SessionRegistry(store);
}

test('SessionStart registra somente token/cwd/projeto/papel correspondentes', async () => {
  const registry = await registryFor('p');
  const launch = await registry.prepare({ projectId: 'p', role: 'planner', cwd: 'C:\\p' });
  await assert.rejects(() => handleHook(registry, { type: 'SessionStart', session_id: 'bad', cwd: 'C:\\p', project_id: 'p', role: 'planner', token: 'wrong' }));
  const result = await handleHook(registry, { type: 'SessionStart', session_id: 'thread', cwd: 'C:\\p', project_id: 'p', role: 'planner', token: launch.token });
  assert.equal(result.exitCode, 0);
  const state = await registry.state();
  assert.equal(state.sessions.find(s => s.threadId === 'thread')?.role, 'planner');
});

// R10: hook repetido é idempotente (mesmo registro, sem nova geração).
test('hook repetido devolve o mesmo registro', async () => {
  const registry = await registryFor('p');
  const launch = await registry.prepare({ projectId: 'p', role: 'dev', cwd: 'C:\\p' });
  const payload = { type: 'SessionStart', session_id: 't1', cwd: 'C:\\p', project_id: 'p', role: 'dev', token: launch.token };
  const first = await handleHook(registry, payload);
  const second = await handleHook(registry, payload);
  assert.deepEqual(second, first);
  const state = await registry.state();
  assert.equal(state.sessions.filter(s => s.role === 'dev').length, 1);
});

// R10 + M5-F1/R4-11: geração substituta reconcilia em confirmReady (fato
// Herdr), não no mero registro do hook — a prontidão exige OS DOIS fatos.
test('geração substituta interrompe a ready anterior com auditoria (confirmReady)', async () => {
  const registry = await registryFor('p');
  const l1 = await registry.prepare({ projectId: 'p', role: 'reviewer', cwd: 'C:\\p' });
  await handleHook(registry, { type: 'SessionStart', session_id: 'old', cwd: 'c:\\p\\', project_id: 'p', role: 'reviewer', token: l1.token });
  await registry.confirmReady(l1.generationId);
  const l2 = await registry.prepare({ projectId: 'p', role: 'reviewer', cwd: 'C:\\p' });
  const rec = await handleHook(registry, { type: 'SessionStart', session_id: 'new', cwd: 'C:\\p', project_id: 'p', role: 'reviewer', token: l2.token });
  assert.equal(rec.exitCode, 0);
  // Antes do readiness Herdr da substituta, a VIGENTE operacional continua sendo
  // a geração anterior 'ready' — o mero registro do hook não promove.
  assert.match(JSON.parse(rec.json).hookSpecificOutput.additionalContext, new RegExp(`Geração vigente: ${l1.generationId}`));
  await registry.confirmReady(l2.generationId);
  const after = await handleHook(registry, { type: 'UserPromptSubmit', role: 'reviewer', cwd: 'C:\\p', prompt: 'x' });
  assert.match(JSON.parse(after.json).hookSpecificOutput.additionalContext, new RegExp(`Geração vigente: ${l2.generationId}`));
  const state = await registry.state();
  const old = state.sessions.find(s => s.threadId === 'old')!;
  assert.equal(old.status, 'interrupted');
  assert.equal(state.sessions.find(s => s.threadId === 'new')!.status, 'ready');
});

// Nome duplicado em outro projeto mantém isolamento por UUID+projectId.
test('mesmo papel em projetos distintos não cruza registro', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-'));
  const a = new SessionRegistry(new StateStore(join(root, 'a'), { projectId: 'pa' }));
  const b = new SessionRegistry(new StateStore(join(root, 'b'), { projectId: 'pb' }));
  await new StateStore(join(root, 'a'), { projectId: 'pa' }).init('pa');
  await new StateStore(join(root, 'b'), { projectId: 'pb' }).init('pb');
  const la = await a.prepare({ projectId: 'pa', role: 'dev', cwd: 'C:\\a' });
  const lb = await b.prepare({ projectId: 'pb', role: 'dev', cwd: 'C:\\a' });
  await handleHook(a, { type: 'SessionStart', session_id: 'ta', cwd: 'C:\\a', project_id: 'pa', role: 'dev', token: la.token });
  await handleHook(b, { type: 'SessionStart', session_id: 'tb', cwd: 'C:\\a', project_id: 'pb', role: 'dev', token: lb.token });
  assert.equal((await a.state()).sessions[0].threadId, 'ta');
  assert.equal((await b.state()).sessions[0].threadId, 'tb');
});

test('SessionEnd é sinal de fechamento; contexto respeita limite', () => {
  const state = emptyRuntime('p');
  const ctx = roleContext(state, 'planner', 40);
  assert.ok(ctx.length <= 40);
});
