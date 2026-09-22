import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowProject } from './flow-fixtures.js';

// R4-07/R4-08/M6-F1 + R5: identidade de execução pela fronteira PÚBLICA. As execuções vêm do fluxo real
// (start com aprovação/manifesto, `check`, rubrica com proveniência completa) — nenhum run é semeado
// diretamente no estado, então nenhuma fixture pré-autoriza o gate. review-only: checks:{} é legítimo
// (o método não exige check mecânico) e o snapshot ainda vem de `check`.

const PROJECT_ID = '11111111-2222-3333-4444-555555555504';

async function mkProject(): Promise<FlowProject> {
  return FlowProject.create({
    projectId: PROJECT_ID, slug: 'dem', workflow: 'review-only', checks: {}, name: 'Ident',
    approval: { entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }] },
  });
}

/** check + rubrica do run ATIVO (snapshot copiado do check) pronta para um `next` com o operationId dado. */
async function prepared(p: FlowProject): Promise<string> {
  const c = await p.check('review');
  assert.equal(c.code, 0, c.err);
  return p.rubric('review', ['REQ-1'], c.payload.snapshot);
}

// R4-07 — slug antigo (done) + novo running: o next aplica-se ao NOVO run; a
// transação nunca reresolve pelo primeiro slug histórico.
test('R4-07: run ativo resolvido uma vez — next aplica ao running, não ao histórico done', async () => {
  const p = await mkProject();
  const oldId = await p.boot();
  const first = await p.pass('review', { opId: 'op-antiga' });
  assert.equal(first.code, 0, first.err);
  const newId = await p.boot(); // mesmo slug, após terminal: novo run
  assert.notEqual(newId, oldId);
  const x = await p.pass('review', { opId: 'op-n1' });
  assert.equal(x.code, 0, x.err);
  const out = JSON.parse(x.out) as { status: string; runId: string; replay?: boolean };
  assert.equal(out.status, 'done');
  assert.equal(out.runId, newId, 'resultado vinculado ao run ativo');
  const state = await p.state();
  assert.equal(state.runs.find(r => r.runId === oldId)!.status, 'done');
  assert.equal(state.runs.find(r => r.runId === oldId)!.revision, 1, 'run histórico intocado');
  assert.equal(state.operations['op-n1'].runId, newId);
});

// R4-08 — operationId do run antigo reproduzido no novo run é CONFLITO: sem
// gravação, sem envio, e o novo run não é concluído.
test('R4-08: operationId de run antigo no novo run é conflito sem gravação', async () => {
  const p = await mkProject();
  const oldId = await p.boot();
  assert.equal((await p.pass('review', { opId: 'OP-X' })).code, 0);
  const newId = await p.boot();
  const file = await prepared(p);
  const before = await p.state();
  assert.equal(before.operations['OP-X'].runId, oldId);
  const r = await p.next('review', 'pass', file, { opId: 'OP-X' });
  assert.equal(r.code, 3);
  assert.match(r.err, /identidade divergente/);
  const after = await p.state();
  assert.equal(after.revision, before.revision, 'conflito sem gravação');
  assert.deepEqual(after.operations['OP-X'], before.operations['OP-X'], 'resultado anterior preservado');
  assert.equal(after.runs.find(x => x.runId === newId)!.status, 'running', 'novo run não concluído por replay estranho');
  assert.equal(after.evidence.length, before.evidence.length, 'evidência do pedido conflitante não é mesclada');
});

// M6-F1 — replay legítimo (mesma identidade) após transição devolve o resultado
// anterior sem regravar; payload divergente com mesmo operationId é conflito.
test('M6-F1: replay legítimo após terminal e conflito de payload divergente', async () => {
  const p = await mkProject();
  const runId = await p.boot();
  const file = await prepared(p);
  const first = await p.next('review', 'pass', file, { opId: 'op-rep' });
  assert.equal(first.code, 0, first.err);
  // Replay idêntico após terminal: devolve resultado, zero gravação.
  const store = p.store();
  const revAfterFirst = (await store.read()).revision;
  const replay = await p.next('review', 'pass', file, { opId: 'op-rep', revision: 0 });
  assert.equal(replay.code, 0, replay.err);
  const replayOut = JSON.parse(replay.out) as { replay: boolean; runId: string; status: string };
  assert.equal(replayOut.replay, true);
  assert.equal(replayOut.runId, runId);
  assert.equal(replayOut.status, 'done');
  assert.equal((await store.read()).revision, revAfterFirst, 'replay não regrava');
  // Mesmo operationId com payload divergente (outro arquivo de evidência): conflito sem gravação.
  const altered = await p.rubric('review', ['REQ-1'], (await p.snapshotNow()), { idOf: () => 'ev-r3-alterada' });
  const conflict = await p.next('review', 'pass', altered, { opId: 'op-rep', revision: 0 });
  assert.equal(conflict.code, 3);
  assert.match(conflict.err, /identidade divergente/);
  assert.equal((await store.read()).revision, revAfterFirst, 'conflito sem gravação');
});

// M6-F1 — operação NOVA (operationId desconhecido) em execução terminal é
// rejeitada com auditoria vinculada à execução.
test('M6-F1: operação nova após terminal é rejeitada com auditoria', async () => {
  const p = await mkProject();
  const runId = await p.boot();
  assert.equal((await p.pass('review', { opId: 'op-fim' })).code, 0);
  // Rubrica ÍNTEGRA para a revisão do run terminal (1): a importação passa; a recusa vem do estado terminal.
  const file = await p.rubric('review', ['REQ-1'], await p.snapshotNow());
  const before = await p.fingerprint();
  const r = await p.next('review', 'pass', file, { opId: 'op-late', revision: 1 });
  assert.equal(r.code, 3);
  assert.match(r.err, /já está done/);
  const state = await p.state();
  assert.equal(state.operations['op-late'].accepted, false);
  assert.equal(state.operations['op-late'].runId, runId);
  assert.equal(state.runs.find(x => x.runId === runId)!.status, 'done');
  assert.equal((await p.fingerprint()).evidence, before.evidence, 'evidência da operação tardia não é mesclada');
  assert.equal((await p.fingerprint()).messages, before.messages, 'nenhuma task/notify criada');
});
