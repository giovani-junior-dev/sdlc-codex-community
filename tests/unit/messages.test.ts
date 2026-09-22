import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../src/state/store.js';
import { MessageService } from '../../src/messages/service.js';
import { CodexTransport } from '../../src/adapters/codex.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';

function transportOk(thread: string) {
  return new CodexTransport(new FakeProcessRunner(() => ({
    exitCode: 0, stdout: `Queued message nat-1 for thread ${thread}.`, stderr: '', timedOut: false, acceptedBeforeTimeout: false,
  })));
}

async function seeded(projectId = 'p') {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-c-'));
  const store = new StateStore(root, { projectId });
  await store.init(projectId);
  await store.mutate(s => ({
    state: {
      ...s,
      sessions: [
        { role: 'planner', threadId: 'tp', generationId: 'gp', projectId, cwd: 'c', status: 'ready', lastEventAt: new Date().toISOString() },
        { role: 'dev', threadId: 't', generationId: 'g', projectId, cwd: 'c', status: 'ready', lastEventAt: new Date().toISOString() },
      ],
    },
    result: undefined,
  }));
  return store;
}

test('send persiste antes da fila e receive deduplica', async () => {
  const store = await seeded();
  const service = new MessageService(store, transportOk('t'));
  const sent = await service.send({ from: 'planner', to: 'dev', type: 'question', body: 'linha 1\nlinha 2' });
  assert.equal(sent.delivery.status, 'enqueued');
  const received = await service.receive(sent.message.messageId, { role: 'dev', threadId: 't', generationId: 'g' });
  assert.equal(received.action, 'execute');
  assert.equal((await store.read()).deliveries.find(d => d.messageId === sent.message.messageId)?.claimedBy, 'dev:g');
  const duplicate = await service.receive(sent.message.messageId, { role: 'dev', threadId: 't', generationId: 'g' });
  assert.equal(duplicate.action, 'duplicate');
});

test('receive valida thread vigente: geração antiga é rejeitada', async () => {
  const store = await seeded();
  const service = new MessageService(store, transportOk('t'));
  const sent = await service.send({ from: 'planner', to: 'dev', type: 'question', body: 'oi' });
  await assert.rejects(() => service.receive(sent.message.messageId, { role: 'dev', threadId: 't', generationId: 'antiga' }), /geração/);
  await assert.rejects(() => service.receive(sent.message.messageId, { role: 'reviewer', threadId: 't', generationId: 'g' }), /destinatário/);
});

test('R11 corrida: receive+finish durante espera de queue; send/recover não rebaixa completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-c-'));
  const store = new StateStore(root, { projectId: 'p' });
  await store.init('p');
  await store.mutate(s => ({
    state: { ...s, sessions: [{ role: 'dev', threadId: 't', generationId: 'g', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: new Date().toISOString() }] },
    result: undefined,
  }));
  let releaseQueue!: () => void;
  const gate = new Promise<void>(r => { releaseQueue = r; });
  const slow = new CodexTransport(new FakeProcessRunner(async () => { await gate; return { exitCode: 0, stdout: 'Queued message n for thread t.', stderr: '', timedOut: false, acceptedBeforeTimeout: false }; }));
  const service = new MessageService(store, slow);
  const sending = service.send({ from: 'planner', to: 'dev', type: 'notify', body: 'aviso' });
  let msg!: import('../../src/contracts.js').Message;
  try {
    // Aguarda a primeira mutação criar a entrega pending (polling tolerante a carga).
    let pending;
    for (let i = 0; i < 500; i++) {
      pending = (await store.read()).deliveries.find(d => d.status === 'pending');
      if (pending) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(pending, 'entrega pending antes do receipt');
    msg = (await store.read()).messages.find(m => m.messageId === pending.messageId)!;
    const recv = await service.receive(msg.messageId, { role: 'dev', threadId: 't', generationId: 'g' });
    assert.equal(recv.action, 'execute');
    await service.finishMessage(msg.messageId, { role: 'dev', threadId: 't', generationId: 'g' });
  } finally {
    releaseQueue();
  }
  const sent = await sending;
  // O receipt tardio NÃO rebaixa completed para enqueued (R11).
  assert.equal(sent.delivery.status, 'completed');
  const afterRecover = await service.recover();
  assert.ok(!afterRecover.some(r => r.messageId === msg.messageId && r.status === 'enqueued'));
});

test('finish-message rejeita task e ator obsoleto; conclui notify autorizado', async () => {
  const store = await seeded();
  const service = new MessageService(store, transportOk('t'));
  const sent = await service.send({ from: 'planner', to: 'dev', type: 'notify', body: 'n' });
  await service.receive(sent.message.messageId, { role: 'dev', threadId: 't', generationId: 'g' });
  await assert.rejects(() => service.finishMessage(sent.message.messageId, { role: 'dev', threadId: 't', generationId: 'velha' }), /obsoleto/);
  await service.finishMessage(sent.message.messageId, { role: 'dev', threadId: 't', generationId: 'g' });
  assert.equal((await store.read()).deliveries.find(d => d.messageId === sent.message.messageId)?.status, 'completed');
});

test('pergunta/resposta correlacionada não avança pipeline', async () => {
  const store = await seeded();
  const service = new MessageService(store, transportOk('tp'));
  const q = await service.send({ from: 'dev', to: 'planner', type: 'question', body: 'dúvida' });
  const rq = await service.receive(q.message.messageId, { role: 'planner', threadId: 'tp', generationId: 'gp' });
  assert.equal(rq.action, 'execute');
  const revBefore = (await store.read()).revision;
  await service.finishMessage(q.message.messageId, { role: 'planner', threadId: 'tp', generationId: 'gp' }, 'checkpoint-1');
  const revAfter = (await store.read()).revision;
  assert.equal((await store.read()).runs.length, 0);
  assert.ok(revAfter >= revBefore);
});

// ---------- C11 — resposta validada contra pergunta existente ----------

test('C11: answer exige pergunta correspondente, mesma execução e participantes compatíveis', async () => {
  const store = await seeded();
  const service = new MessageService(store, transportOk('t'));
  await assert.rejects(
    () => service.send({ from: 'planner', to: 'dev', type: 'answer', body: 'sem correlação' }),
    /correlationId/);
  await assert.rejects(
    () => service.send({ from: 'planner', to: 'dev', type: 'answer', body: 'x', correlationId: 'inexistente' }),
    /sem pergunta correspondente/);
  const q = await service.send({ from: 'dev', to: 'planner', type: 'question', body: 'pergunta' });
  // participantes invertidos: quem pergunta não responde à própria pergunta
  await assert.rejects(
    () => service.send({ from: 'dev', to: 'planner', type: 'answer', body: 'x', correlationId: q.message.messageId }),
    /participantes incompatíveis/);
  // resposta válida do destinatário da pergunta
  const a = await service.send({ from: 'planner', to: 'dev', type: 'answer', body: 'resposta', correlationId: q.message.messageId });
  assert.equal(a.message.correlationId, q.message.messageId);
});

test('C11: answer vinculada a pergunta de outra execução é recusada', async () => {
  const store = await seeded();
  await store.mutate(s => ({
    state: {
      ...s,
      runs: [
        { runId: 'run-1', slug: 's1', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'build', revision: 0, attempts: { build: 0, review: 0, e2e: 0, pr: 0, 'pr-review': 0, document: 0 }, gapFailures: {}, status: 'running', history: [] },
      ],
    },
    result: undefined,
  }));
  const service = new MessageService(store, transportOk('tp'));
  const q = await service.send({ from: 'dev', to: 'planner', type: 'question', body: 'pergunta da run-1', runId: 'run-1' });
  // resposta sem runId (ou de outro runId) não casa com a pergunta da run-1
  await assert.rejects(
    () => service.send({ from: 'planner', to: 'dev', type: 'answer', body: 'resposta', correlationId: q.message.messageId }),
    /outra execução/);
});

// ---------- C01 — despacho centralizado ----------

async function seedPending(store: StateStore, items: Array<{ messageId: string; deliveryId: string; to: 'dev' | 'planner'; type: 'task' | 'notify'; status?: string; claimedBy?: string }>) {
  await store.mutate(s => ({
    state: {
      ...s,
      messages: [
        ...s.messages,
        ...items.map(it => ({
          messageId: it.messageId, projectId: 'p', from: 'planner' as const, to: it.to,
          targetThreadId: it.to === 'dev' ? 't' : 'tp', targetGenerationId: it.to === 'dev' ? 'g' : 'gp',
          type: it.type, body: `corpo ${it.messageId}`, createdAt: new Date().toISOString(),
        })),
      ],
      deliveries: [
        ...s.deliveries,
        ...items.map(it => ({
          deliveryId: it.deliveryId, messageId: it.messageId, status: (it.status ?? 'pending') as 'pending',
          // R4-03: received exige claim (claimedBy + claimedAt); completed exige trilha.
          ...(it.claimedBy ? { claimedBy: it.claimedBy, claimedAt: new Date().toISOString() } : {}),
          updatedAt: new Date().toISOString(),
        })),
      ],
    },
    result: undefined,
  }));
}

function okRunner() {
  return new FakeProcessRunner(() => ({ exitCode: 0, stdout: 'Queued message nat-1 for thread t.', stderr: '', timedOut: false, acceptedBeforeTimeout: false }));
}

test('C01: dispatchPending despacha só pending, com envelope correto e IDs preservados', async () => {
  const store = await seeded();
  await seedPending(store, [
    { messageId: 'm-pend', deliveryId: 'd-pend', to: 'dev', type: 'notify' },
    { messageId: 'm-enq', deliveryId: 'd-enq', to: 'dev', type: 'notify', status: 'enqueued' },
    { messageId: 'm-rec', deliveryId: 'd-rec', to: 'dev', type: 'notify', status: 'received', claimedBy: 'g' },
    { messageId: 'm-done', deliveryId: 'd-done', to: 'dev', type: 'notify', status: 'completed', claimedBy: 'g' },
  ]);
  const runner = okRunner();
  const outcomes = await new MessageService(store, new CodexTransport(runner)).dispatchPending();
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes.map(o => o.deliveryId), ['d-pend']);
  assert.equal(outcomes[0].status, 'enqueued');
  assert.equal(outcomes[0].nativeMessageId, 'nat-1');
  // envelope carrega o messageId e o projeto (shape único do cli)
  const envelope = JSON.parse(runner.calls[0].args[runner.calls[0].args.indexOf('--message') + 1]) as { messageId: string; projectId: string; type: string };
  assert.equal(envelope.messageId, 'm-pend');
  assert.equal(envelope.projectId, 'p');
  assert.equal(envelope.type, 'notify');
  const deliveries = (await store.read()).deliveries;
  const d = deliveries.find(x => x.deliveryId === 'd-pend')!;
  assert.equal(d.messageId, 'm-pend'); // IDs preservados
  assert.equal(d.status, 'enqueued');
  assert.equal(d.nativeMessageId, 'nat-1');
  // nada rebaixado ou reenviado
  assert.equal(deliveries.find(x => x.deliveryId === 'd-enq')!.status, 'enqueued');
  assert.equal(deliveries.find(x => x.deliveryId === 'd-rec')!.status, 'received');
  assert.equal(deliveries.find(x => x.deliveryId === 'd-done')!.status, 'completed');
});

test('C01: destinatário sem sessão ready não é despachado (permanece pending com diagnóstico)', async () => {
  const store = await seeded();
  await seedPending(store, [{ messageId: 'm-x', deliveryId: 'd-x', to: 'dev', type: 'notify' }]);
  await store.mutate(s => ({
    state: { ...s, sessions: s.sessions.map(x => x.role === 'dev' ? { ...x, status: 'interrupted' as const } : x) },
    result: undefined,
  }));
  const runner = okRunner();
  const outcomes = await new MessageService(store, new CodexTransport(runner)).dispatchPending();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, 'pending');
  assert.match(outcomes[0].error ?? '', /sem sessão ready/);
  assert.equal(runner.calls.length, 0, 'nenhum transporte acionado');
  assert.equal((await store.read()).deliveries.find(d => d.deliveryId === 'd-x')!.status, 'pending');
});

test('C01: falha de transporte de uma entrega não aborta as demais', async () => {
  const store = await seeded();
  await seedPending(store, [
    { messageId: 'm-falha', deliveryId: 'd-falha', to: 'dev', type: 'notify' },
    { messageId: 'm-ok', deliveryId: 'd-ok', to: 'planner', type: 'notify' },
  ]);
  const runner = new FakeProcessRunner((_, args) => {
    const thread = args[args.indexOf('--thread') + 1];
    if (thread === 't') return { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: 'Queued message nat-9 for thread tp.', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
  const outcomes = await new MessageService(store, new CodexTransport(runner)).dispatchPending();
  assert.equal(outcomes.length, 2);
  const falha = outcomes.find(o => o.deliveryId === 'd-falha')!;
  const ok = outcomes.find(o => o.deliveryId === 'd-ok')!;
  assert.equal(falha.status, 'failed');
  assert.ok(falha.error);
  assert.equal(ok.status, 'enqueued');
  const deliveries = (await store.read()).deliveries;
  assert.equal(deliveries.find(d => d.deliveryId === 'd-falha')!.status, 'failed');
  assert.equal(deliveries.find(d => d.deliveryId === 'd-ok')!.status, 'enqueued');
});

test('C01: receipt tardio de dispatchPending não reabre entrega já concluída', async () => {
  const store = await seeded();
  await seedPending(store, [{ messageId: 'm-late', deliveryId: 'd-late', to: 'dev', type: 'notify' }]);
  let releaseQueue!: () => void;
  const gate = new Promise<void>(r => { releaseQueue = r; });
  const slow = new CodexTransport(new FakeProcessRunner(async () => { await gate; return { exitCode: 0, stdout: 'Queued message nat-late for thread t.', stderr: '', timedOut: false, acceptedBeforeTimeout: false }; }));
  const service = new MessageService(store, slow);
  const dispatching = service.dispatchPending();
  await new Promise(r => setTimeout(r, 30));
  const recv = await service.receive('m-late', { role: 'dev', threadId: 't', generationId: 'g' });
  assert.equal(recv.action, 'execute');
  await service.finishMessage('m-late', { role: 'dev', threadId: 't', generationId: 'g' });
  releaseQueue();
  const outcomes = await dispatching;
  assert.equal(outcomes[0].status, 'completed', 'receipt tardio preserva o primeiro escritor');
  assert.equal((await store.read()).deliveries.find(d => d.deliveryId === 'd-late')!.status, 'completed');
});

test('C01: crash antes do envio — entrega persistida é despachada sem novo messageId', async () => {
  const store = await seeded();
  // Simula crash após a persistência da entrega e antes do transporte.
  await seedPending(store, [{ messageId: 'm-crash', deliveryId: 'd-crash', to: 'dev', type: 'notify' }]);
  const runner = okRunner();
  const service = new MessageService(store, new CodexTransport(runner));
  const outcomes = await service.dispatchPending();
  assert.equal(outcomes[0].status, 'enqueued');
  const envelope = JSON.parse(runner.calls[0].args[runner.calls[0].args.indexOf('--message') + 1]) as { messageId: string };
  assert.equal(envelope.messageId, 'm-crash', 'reenvio deduplica pelo message ID');
  // segundo despacho não reenvia o que já foi enfileirado
  const again = await service.dispatchPending();
  assert.equal(again.length, 0);
  assert.equal(runner.calls.length, 1);
});

test('C01: falha ao persistir receipt — send não lança exceção após persistir a entrega', async () => {
  const store = await seeded();
  const failing = new CodexTransport(new FakeProcessRunner(() => ({ exitCode: 1, stdout: '', stderr: 'queue indisponível', timedOut: false, acceptedBeforeTimeout: false })));
  const service = new MessageService(store, failing);
  const sent = await service.send({ from: 'planner', to: 'dev', type: 'notify', body: 'aviso' });
  assert.equal(sent.queue, 'failed');
  assert.equal(sent.delivery.status, 'failed');
  const live = (await store.read()).deliveries.find(d => d.messageId === sent.message.messageId)!;
  assert.equal(live.status, 'failed');
  assert.equal(live.messageId, sent.message.messageId);
});

test('C01: finishMessage nunca conclui task; conclusão de task é só via next (completeLinkedTask)', async () => {
  const store = await seeded();
  await seedPending(store, [{ messageId: 'm-task', deliveryId: 'd-task', to: 'dev', type: 'task' }]);
  const service = new MessageService(store, transportOk('t'));
  await service.receive('m-task', { role: 'dev', threadId: 't', generationId: 'g' });
  await assert.rejects(
    () => service.finishMessage('m-task', { role: 'dev', threadId: 't', generationId: 'g' }),
    /task conclui somente via next/);
  const state = await store.read();
  const completed = MessageService.completeLinkedTask(state, 'm-task');
  assert.equal(completed.deliveries.find(d => d.deliveryId === 'd-task')!.status, 'completed');
});
