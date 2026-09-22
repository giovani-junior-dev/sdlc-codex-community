import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../src/state/store.js';
import { MessageService } from '../../src/messages/service.js';
import { CodexTransport } from '../../src/adapters/codex.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';

function ok(thread: string, native: string) {
  return new CodexTransport(new FakeProcessRunner(() => ({
    exitCode: 0, stdout: JSON.stringify({ status: 'accepted', threadId: thread, nativeMessageId: native }), stderr: '', timedOut: false, acceptedBeforeTimeout: false,
  })));
}

async function seeded() {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-c-'));
  const store = new StateStore(root, { projectId: 'p' });
  await store.init('p');
  await store.mutate(s => ({
    state: {
      ...s,
      sessions: [{ role: 'dev', threadId: 't', generationId: 'g', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: new Date().toISOString() }],
      messages: [{ messageId: 'm', projectId: 'p', from: 'planner', to: 'dev', targetThreadId: 't', targetGenerationId: 'g', type: 'task', body: 'work', createdAt: new Date().toISOString() }],
      deliveries: [{ deliveryId: 'd', messageId: 'm', status: 'pending', updatedAt: new Date().toISOString() }],
    },
    result: undefined,
  }));
  return store;
}

test('recover reenvia pendência limitada com o mesmo message ID, sem mudar estágio', async () => {
  const store = await seeded();
  let calls = 0;
  const runner = new FakeProcessRunner(() => { calls++; return { exitCode: 0, stdout: JSON.stringify({ status: 'accepted', threadId: 't', nativeMessageId: `n${calls}` }), stderr: '', timedOut: false, acceptedBeforeTimeout: false }; });
  const result = await new MessageService(store, new CodexTransport(runner)).recover(1);
  assert.deepEqual(result, [{ messageId: 'm', status: 'enqueued' }]);
  assert.equal((await store.read()).messages[0].messageId, 'm');
  assert.equal(calls, 1);
});

test('recover remapeia para geração nova com auditoria; geração antiga bloqueada', async () => {
  const store = await seeded();
  await store.mutate(s => ({
    state: { ...s, sessions: [{ role: 'dev', threadId: 't2', generationId: 'g2', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: new Date().toISOString() }] },
    result: undefined,
  }));
  const result = await new MessageService(store, ok('t2', 'n')).recover();
  assert.deepEqual(result, [{ messageId: 'm', status: 'enqueued' }]);
  const state = await store.read();
  assert.equal(state.messages[0].targetThreadId, 't2');
  assert.ok(state.events.some(e => e.kind === 'delivery-remapped'));
});

test('recover respeita pausa humana: sessão interrompida não é despertada', async () => {
  const store = await seeded();
  await store.mutate(s => ({
    state: { ...s, sessions: s.sessions.map(x => ({ ...x, status: 'interrupted' as const })) },
    result: undefined,
  }));
  const result = await new MessageService(store, ok('t', 'n')).recover();
  assert.deepEqual(result, [{ messageId: 'm', status: 'paused' }]);
  assert.equal((await store.read()).deliveries[0].status, 'pending');
});

// Revisão cruzada — lacuna de teste: entregas 'enqueued' no recover.
test('recover NÃO reenvia entrega enqueued cujo destino vigente está inalterado', async () => {
  const store = await seeded();
  await store.mutate(s => ({
    state: { ...s, deliveries: [{ deliveryId: 'd', messageId: 'm', status: 'enqueued', nativeMessageId: 'n0', updatedAt: new Date().toISOString() }] },
    result: undefined,
  }));
  let calls = 0;
  const runner = new FakeProcessRunner(() => { calls++; return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false }; });
  const result = await new MessageService(store, new CodexTransport(runner)).recover();
  assert.deepEqual(result, []);
  assert.equal(calls, 0, 'reenvio indiscriminado da fila é proibido (C01)');
  assert.equal((await store.read()).deliveries[0].nativeMessageId, 'n0');
});

test('recover REMAPEIA e reenvia entrega enqueued cujo destinatário foi substituído, preservando IDs', async () => {
  const store = await seeded();
  await store.mutate(s => ({
    state: {
      ...s,
      sessions: [{ role: 'dev', threadId: 't2', generationId: 'g2', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: new Date().toISOString() }],
      deliveries: [{ deliveryId: 'd', messageId: 'm', status: 'enqueued', nativeMessageId: 'n0', updatedAt: new Date().toISOString() }],
    },
    result: undefined,
  }));
  const result = await new MessageService(store, ok('t2', 'n1')).recover();
  assert.deepEqual(result, [{ messageId: 'm', status: 'enqueued' }]);
  const state = await store.read();
  assert.equal(state.messages[0].messageId, 'm', 'message ID preservado');
  assert.equal(state.messages[0].targetThreadId, 't2');
  assert.ok(state.events.some(e => e.kind === 'delivery-remapped'));
});

test('recover retoma entrega failed com auditoria; receive em failed explica o recover', async () => {
  const store = await seeded();
  await store.mutate(s => ({
    state: { ...s, deliveries: [{ deliveryId: 'd', messageId: 'm', status: 'failed', updatedAt: new Date().toISOString() }] },
    result: undefined,
  }));
  const service = new MessageService(store, ok('t', 'n1'));
  // receive em 'failed' nunca é 'stale': orienta o recover (revisão cruzada M2).
  await assert.rejects(() => service.receive('m', { role: 'dev', threadId: 't', generationId: 'g' }), /recover/);
  const result = await service.recover();
  assert.deepEqual(result, [{ messageId: 'm', status: 'enqueued' }]);
  const state = await store.read();
  assert.equal(state.deliveries[0].status, 'enqueued');
  assert.ok(state.events.some(e => e.kind === 'delivery-recovered'));
});

test('claim interrompido só retoma após liberação explícita', async () => {
  const store = await seeded();
  const service = new MessageService(store, ok('t', 'n'));
  const r1 = await service.receive('m', { role: 'dev', threadId: 't', generationId: 'g' });
  assert.equal(r1.action, 'execute');
  assert.equal((await service.receive('m', { role: 'dev', threadId: 't', generationId: 'g' })).action, 'duplicate');
  await service.releaseClaim('m');
  assert.equal((await service.receive('m', { role: 'dev', threadId: 't', generationId: 'g' })).action, 'resume');
});

// ---------- C11 — recover com liberação de claim e geração vigente ----------

test('C11: recover --claim libera claim interrompido com auditoria e devolve resume+checkpoint', async () => {
  const store = await seeded();
  const service = new MessageService(store, ok('t', 'n'));
  const r1 = await service.receive('m', { role: 'dev', threadId: 't', generationId: 'g', checkpoint: 'passo-3' });
  assert.equal(r1.action, 'execute');
  // crash simulado aqui; operador chama recover com liberação explícita
  const released = await service.recover(100, { releaseClaimFor: 'm', role: 'dev', threadId: 't', generationId: 'g' });
  assert.equal(released.length, 1);
  assert.equal(released[0].messageId, 'm');
  assert.equal(released[0].action, 'resume');
  assert.equal(released[0].checkpoint, 'passo-3');
  const state = await store.read();
  assert.ok(state.events.some(e => e.kind === 'claim-released'));
  // retomada não repete efeitos: receive devolve resume com o mesmo delivery/checkpoint
  const resumed = await service.receive('m', { role: 'dev', threadId: 't', generationId: 'g' });
  assert.equal(resumed.action, 'resume');
  assert.equal(resumed.delivery.deliveryId, 'd');
  assert.equal(resumed.delivery.checkpoint, 'passo-3');
});

test('C11: recover --claim valida identidade do ator; geração antiga é recusada', async () => {
  const store = await seeded();
  const service = new MessageService(store, ok('t', 'n'));
  await service.receive('m', { role: 'dev', threadId: 't', generationId: 'g' });
  await assert.rejects(
    () => service.recover(100, { releaseClaimFor: 'm', role: 'reviewer', threadId: 't', generationId: 'g' }),
    /não é destinatário/);
  await assert.rejects(
    () => service.recover(100, { releaseClaimFor: 'm', role: 'dev', threadId: 't', generationId: 'antiga' }),
    /não corresponde nem ao destino registrado nem à geração vigente/);
  // claim de geração antiga recusada mesmo com papel certo após substituição
  await store.mutate(s => ({
    state: { ...s, sessions: [{ role: 'dev', threadId: 't2', generationId: 'g2', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: new Date().toISOString() }] },
    result: undefined,
  }));
  await service.remapGeneration('m', 't2', 'g2');
  await assert.rejects(
    () => service.recover(100, { releaseClaimFor: 'm', role: 'dev', threadId: 't', generationId: 'g' }),
    /não corresponde nem ao destino registrado nem à geração vigente/);
  // identidade vigente correta libera normalmente
  const okRelease = await service.recover(100, { releaseClaimFor: 'm', role: 'dev', threadId: 't2', generationId: 'g2' });
  assert.equal(okRelease[0].action, 'resume');
});

test('C11: recover seleciona a geração vigente (ready), nunca a primeira sessão histórica', async () => {
  const store = await seeded();
  // sessão antiga aparece primeiro no registro, mas está encerrada; vigente é a segunda
  await store.mutate(s => ({
    state: {
      ...s,
      sessions: [
        { role: 'dev', threadId: 't-velha', generationId: 'g-velha', projectId: 'p', cwd: 'c', status: 'closed' as const, lastEventAt: new Date().toISOString() },
        { role: 'dev', threadId: 't2', generationId: 'g2', projectId: 'p', cwd: 'c', status: 'ready' as const, lastEventAt: new Date().toISOString() },
      ],
    },
    result: undefined,
  }));
  const result = await new MessageService(store, ok('t2', 'n')).recover();
  assert.deepEqual(result, [{ messageId: 'm', status: 'enqueued' }]);
  const state = await store.read();
  assert.equal(state.messages[0].targetThreadId, 't2');
  assert.ok(state.events.some(e => e.kind === 'delivery-remapped'));
});

test('C11: recover com claim inexistente ou sem reivindicação ativa é recusado', async () => {
  const store = await seeded();
  const service = new MessageService(store, ok('t', 'n'));
  await assert.rejects(
    () => service.recover(100, { releaseClaimFor: 'inexistente', role: 'dev', threadId: 't', generationId: 'g' }),
    /mensagem desconhecida/);
  // entrega ainda pending (sem receive) não tem claim a liberar
  await assert.rejects(
    () => service.recover(100, { releaseClaimFor: 'm', role: 'dev', threadId: 't', generationId: 'g' }),
    /somente reivindicação ativa/);
});

// ---------- C12 — tasks de terminais nunca executam ----------

test('C12: task de execução done/blocked/exhausted/thrash nunca retorna execute', async () => {
  for (const terminal of ['done', 'blocked', 'exhausted', 'thrash'] as const) {
    const store = await seeded();
    await store.mutate(s => ({
      state: {
        ...s,
        runs: [{ runId: 'r', slug: 's', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'build', revision: 0, attempts: { build: 0, review: 0, e2e: 0, pr: 0, 'pr-review': 0, document: 0 }, gapFailures: {}, status: terminal, history: [] }],
        messages: [{ messageId: 'm', projectId: 'p', runId: 'r', from: 'planner', to: 'dev', targetThreadId: 't', targetGenerationId: 'g', type: 'task', stage: 'build', revision: 0, body: 'work', createdAt: new Date().toISOString() }],
      },
      result: undefined,
    }));
    const service = new MessageService(store, ok('t', 'n'));
    const result = await service.receive('m', { role: 'dev', threadId: 't', generationId: 'g' });
    assert.equal(result.action, 'stale', `terminal ${terminal} não executa`);
    assert.match(result.instruction, new RegExp(terminal));
  }
});

test('C12: task de etapa/revisão antiga é stale mesmo com execução running', async () => {
  const store = await seeded();
  await store.mutate(s => ({
    state: {
      ...s,
      runs: [{ runId: 'r', slug: 's', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'review', revision: 3, attempts: { build: 0, review: 0, e2e: 0, pr: 0, 'pr-review': 0, document: 0 }, gapFailures: {}, status: 'running', history: [] }],
      messages: [{ messageId: 'm', projectId: 'p', runId: 'r', from: 'planner', to: 'dev', targetThreadId: 't', targetGenerationId: 'g', type: 'task', stage: 'build', revision: 2, body: 'work antigo', createdAt: new Date().toISOString() }],
    },
    result: undefined,
  }));
  const service = new MessageService(store, ok('t', 'n'));
  const result = await service.receive('m', { role: 'dev', threadId: 't', generationId: 'g' });
  assert.equal(result.action, 'stale');
});
