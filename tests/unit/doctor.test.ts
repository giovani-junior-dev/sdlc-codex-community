import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { StateStore } from '../../src/state/store.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { ProcessResult } from '../../src/adapters/process.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, value: { stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) } };
}

const OK: ProcessResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
const PROJECT_ID = '11111111-2222-3333-4444-555555555599';

interface DoctorWorld {
  root: string;
  stateRoot: string;
  store: StateStore;
  probes: Map<string, ProcessResult>;
}

/** Runner falso por (exe, prefixo de args): default = sucesso silencioso. */
function runnerFor(world: DoctorWorld): FakeProcessRunner {
  return new FakeProcessRunner((exe, args) => {
    for (const [key, result] of world.probes) {
      const [kExe, ...kRest] = key.split(' ');
      if (exe === kExe && kRest.every((a, i) => args[i] === a)) return result;
    }
    return OK;
  });
}

async function mkWorld(): Promise<DoctorWorld> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-doctor-'));
  const stateRoot = join(root, '.sdlc-codex');
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, 'config.json'), JSON.stringify({
    schemaVersion: 1, projectId: PROJECT_ID, projectName: 'Doc', prBase: 'main',
    checks: {}, models: {}, protectedPaths: ['.git'],
  }));
  // Projeto adotado: hooks.json com entrada gerenciada (doctor distingue ausente).
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sdlc-codex hook SessionStart' }] }] },
  }));
  const store = new StateStore(stateRoot, { projectId: PROJECT_ID });
  await store.init(PROJECT_ID);
  const world: DoctorWorld = { root, stateRoot, store, probes: new Map() };
  world.probes.set('codex --version', { ...OK, stdout: 'codex-cli 0.155.1\n' });
  world.probes.set('codex features list', { ...OK, stdout: 'hooks stable true\n' });
  world.probes.set('codex queue --help', { ...OK, stdout: 'usage: queue\n' });
  world.probes.set('herdr --version', { ...OK, stdout: 'herdr 0.7.5\n' });
  return world;
}

async function runDoctor(world: DoctorWorld): Promise<{ code: number; status: string; checks: Record<string, any> }> {
  const x = io();
  const code = await runCli(['doctor', '--project', world.root, '--json'], x.value, { runner: runnerFor(world) });
  const parsed = JSON.parse(x.out[0]) as { status: string; checks: Record<string, any> };
  return { code, status: parsed.status, checks: parsed.checks };
}

test('R4-17: doctor saudável => exit 0 e ZERO mutações no estado', async () => {
  const w = await mkWorld();
  const before = await w.store.read();
  const r = await runDoctor(w);
  assert.equal(r.code, 0, JSON.stringify(r.checks));
  assert.equal(r.status, 'healthy');
  const after = await w.store.read();
  assert.equal(after.revision, before.revision, 'doctor nunca grava no estado');
  const files = await readdir(w.stateRoot);
  assert.ok(!files.some(f => f.endsWith('.bak')), 'doctor não cria backup (não migra, não repara)');
});

test('R4-17: indisponibilidades simuladas => unavailable/unknown, exit 1, sem mutação', async () => {
  const w = await mkWorld();
  w.probes.set('codex --version', { ...OK, exitCode: 1, stderr: 'not found' });
  w.probes.set('codex queue --help', { ...OK, exitCode: 1 });
  w.probes.set('herdr --version', { ...OK, exitCode: 1, stderr: 'not found' });
  await w.store.mutate(s => ({
    state: {
      ...s,
      sessions: [{
        role: 'dev', threadId: 't-1', generationId: 'g-1', projectId: PROJECT_ID, cwd: w.root,
        paneId: 'pane-1', status: 'ready', lastEventAt: new Date().toISOString(),
      }],
    },
    result: undefined,
  }));
  const before = await w.store.read();
  const r = await runDoctor(w);
  assert.equal(r.code, 1);
  assert.equal(r.checks.codex.status, 'unavailable');
  assert.equal(r.checks.queue.status, 'unavailable');
  assert.equal(r.checks.codexHooks.status, 'unknown', 'codex indisponível => hooks unknown, nunca healthy');
  assert.equal(r.checks.herdr.status, 'unavailable');
  assert.equal(r.checks.inventory.status, 'unknown', 'herdr indisponível com sessões ativas => unknown (divergência não comprovável)');
  const after = await w.store.read();
  assert.equal(after.revision, before.revision, 'zero mutações mesmo com avisos');
});

test('R4-17: daemon/avisos não diagnosticam o transporte como morto', async () => {
  const w = await mkWorld();
  // 'features list' falha (aviso), mas o transporte queue responde: queue healthy.
  w.probes.set('codex features list', { ...OK, exitCode: 1, stderr: 'unknown command' });
  const r = await runDoctor(w);
  assert.equal(r.checks.queue.status, 'healthy', 'queue subprocesso disponível não é diagnosticado como morto por causa de avisos');
  assert.equal(r.checks.codexHooks.status, 'unknown');
  assert.equal(r.code, 1, 'unknown no item de hooks dá exit 1 (diagnóstico não fatal)');
});

test('R4-17: config inválida e estado corrompo são warning/unknown com zero escrita', async () => {
  const w = await mkWorld();
  await writeFile(join(w.stateRoot, 'config.json'), '{ json inválido');
  const r = await runDoctor(w);
  assert.equal(r.code, 1);
  assert.equal(r.checks.config.status, 'warning');

  const w2 = await mkWorld();
  await writeFile(join(w2.stateRoot, 'runtime.json'), '{ não é json');
  const before = await readFile(join(w2.stateRoot, 'runtime.json'), 'utf8');
  const r2 = await runDoctor(w2);
  assert.equal(r2.checks.runtime.status, 'warning');
  assert.equal(r2.code, 1);
  assert.equal(await readFile(join(w2.stateRoot, 'runtime.json'), 'utf8'), before, 'doctor não reescreve estado corrompido');
});

test('R4-17: runtime schemaVersion 1 é detectado sem migrar nem criar backup', async () => {
  const w = await mkWorld();
  const state = await w.store.read();
  await writeFile(join(w.stateRoot, 'runtime.json'), JSON.stringify({ ...state, schemaVersion: 1 }));
  const r = await runDoctor(w);
  assert.equal(r.checks.runtime.status, 'warning');
  assert.match(r.checks.runtime.error, /schemaVersion 1/);
  const files = await readdir(w.stateRoot);
  assert.ok(!files.some(f => f.includes('.bak')), 'migração/backup exigiria escrita — doctor recusa');
  // O arquivo permanece v1 (não foi tocado).
  const raw = JSON.parse(await readFile(join(w.stateRoot, 'runtime.json'), 'utf8')) as { schemaVersion: number };
  assert.equal(raw.schemaVersion, 1);
});

// R5-01/R5-02 (substitui o modelo da rodada 4, em que owner.json de um PID morto era a AUTORIDADE e o
// doctor o chamava de "órfão"): a autoridade é a primitiva do SO (named pipe liberado com a morte do
// processo); `state.lock/owner.json` é só informação/artefato INERTE de crash. Sem detentor, o doctor
// reporta o artefato como `warning` SOMENTE LEITURA — nunca o trata como lock vivo e nunca o remove.
test('R4-17: artefato inerte de lock (crash) é warning somente leitura — doctor NUNCA remove', async () => {
  const w = await mkWorld();
  const { mkdir, writeFile: wf } = await import('node:fs/promises');
  await mkdir(join(w.stateRoot, 'state.lock'));
  await wf(join(w.stateRoot, 'state.lock', 'owner.json'), JSON.stringify({
    pid: 999999, processStartMs: 1, acquiredAt: new Date().toISOString(), token: 'stale',
  }));
  const r = await runDoctor(w);
  assert.equal(r.checks.locks.status, 'warning');
  assert.equal(r.checks.locks.held, 'no', 'nenhum detentor da autoridade do SO: o owner.json de PID morto não é lock');
  assert.equal(r.checks.locks.present, false);
  assert.deepEqual(r.checks.locks.leftovers, ['state.lock'], 'artefato reportado como inerte');
  assert.equal(r.checks.locks.owner?.pid, 999999, 'informação do último detentor exposta (diagnóstico)');
  assert.match(r.checks.locks.detail ?? '', /INERTES/);
  assert.match(r.checks.locks.detail ?? '', /doctor NUNCA remove/);
  const files = await readdir(w.stateRoot);
  assert.ok(files.includes('state.lock'), 'artefato preservado — remoção é explícita via recover');
  assert.equal(r.code, 1);
});

test('R4-17: entregas uncertain e runs bloqueados são warning; uso inválido é exit 2', async () => {
  const w = await mkWorld();
  await w.store.mutate(s => ({
    state: {
      ...s,
      messages: [{
        messageId: 'm-1', projectId: PROJECT_ID, from: 'dev', to: 'planner', targetThreadId: 't', targetGenerationId: 'g',
        type: 'notify', body: 'corpo', createdAt: new Date().toISOString(),
      }],
      deliveries: [{ deliveryId: 'd-1', messageId: 'm-1', status: 'uncertain', updatedAt: new Date().toISOString() }],
      runs: [{
        runId: 'r-1', slug: 's-1', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'build', revision: 0,
        attempts: { build: 0, review: 0, e2e: 0, pr: 0, 'pr-review': 0, document: 0 }, gapFailures: {},
        status: 'blocked', blockedReason: 'limite de correção', history: [],
      }],
    },
    result: undefined,
  }));
  const r = await runDoctor(w);
  assert.equal(r.checks.uncertainDeliveries.status, 'warning');
  assert.equal(r.checks.runs.status, 'warning');
  assert.equal(r.checks.runs.blocked.length, 1);
  assert.equal(r.code, 1);

  const x = io();
  const code = await runCli(['doctor', 'extra', '--project', w.root], x.value, { runner: runnerFor(w) });
  assert.equal(code, 2, 'argumento posicional é uso inválido');
});
