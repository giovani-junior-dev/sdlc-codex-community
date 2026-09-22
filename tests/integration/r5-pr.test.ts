import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from './r5-harness.js';
import type { Stage } from '../../src/contracts.js';
import { blockingPrIntents, reducePrIntents } from '../../src/pipeline/pr-intents.js';

// R5-07/R5-08/M4-F1..F3 — PR observada, snapshot aprovado, ledger e segunda passagem, sempre
// pela fronteira pública (runCli) com falsos SOMENTE nas bordas (gh/git/codex/tool).

async function walkTo(w: World, target: Stage): Promise<void> {
  const order: Stage[] = w.workflow === 'feature' ? ['build', 'review', 'e2e', 'pr', 'pr-review', 'document']
    : w.workflow === 'hotfix' ? ['build', 'review', 'pr', 'pr-review'] : ['review'];
  for (const stage of order) {
    if (stage === target) return;
    const r = await w.pass(stage);
    assert.equal(r.code, 0, `${stage}: ${r.err}`);
  }
}

async function ledger(w: World) { return reducePrIntents(await w.state()); }

// ---------- R5-07 — PR atual e snapshot aprovado no fechamento ----------

test('R5-07 pr-review com PR ABERTA e correspondente (leitura externa realizada) aprova e registra o snapshot aprovado', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr-review');
  const viewsBefore = w.edges.ghViewCalls;
  const r = await w.pass('pr-review');
  assert.equal(r.code, 0, r.err);
  assert.ok(w.edges.ghViewCalls > viewsBefore, 'a PR foi consultada de fato (gh pr view) no estágio exigido');
  const run = await w.run();
  assert.equal(run.stage, 'document');
  assert.ok(run.approvedSnapshot?.diffFingerprint, 'snapshot EFETIVAMENTE aprovado persistido');
  assert.equal(run.approvedSnapshot?.commit, w.edges.git.head);
});

for (const [name, mutate, pattern] of [
  ['PR fechada', (w: World) => { w.edges.prs[0].state = 'CLOSED'; }, /CLOSED/],
  ['PR ausente', (w: World) => { w.edges.prs.length = 0; }, /ABSENT|ausente/i],
  ['base alterada', (w: World) => { w.edges.prs[0].baseRefName = 'develop'; }, /base/i],
  ['head remoto alterado', (w: World) => { w.edges.prs[0].headRefOid = 'ffff999'; }, /head/i],
  ['branch alterada', (w: World) => { w.edges.prs[0].headRefName = 'outra-branch'; }, /branch/i],
] as Array<[string, (w: World) => void, RegExp]>) {
  test(`R5-07 pr-review com ${name} NÃO aprova e nada avança`, async () => {
    const w = await World.create();
    await w.boot();
    await walkTo(w, 'pr-review');
    const c = await w.check('pr-review');
    const file = await w.rubric('pr-review', w.rubricIds('pr-review'), c.payload.snapshot);
    mutate(w);
    const before = await w.fingerprintState();
    const r = await w.next('pr-review', 'pass', file);
    assert.notEqual(r.code, 0, `deveria rejeitar: ${r.out}`);
    assert.match(r.err, pattern);
    const after = await w.fingerprintState();
    assert.equal(after.stage, 'pr-review');
    assert.equal(after.revision, before.revision);
    assert.equal(after.evidence, before.evidence, 'nenhuma evidência adicionada');
    assert.equal(after.messages, before.messages);
    assert.equal(w.edges.ghCreateCalls, 1, 'nenhuma nova publicação');
    assert.ok((await w.run()).approvedSnapshot === undefined, 'sem snapshot aprovado');
  });
}

test('R5-07 mesmo HEAD com código local alterado após o check: pr-review NÃO aprova (HEAD igual ≠ árvore igual)', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr-review');
  const c = await w.check('pr-review');
  const file = await w.rubric('pr-review', w.rubricIds('pr-review'), c.payload.snapshot);
  w.edges.git.diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-um\n+dois\n'; // HEAD igual, diff novo
  const before = await w.fingerprintState();
  const r = await w.next('pr-review', 'pass', file);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /obsolet|snapshot|árvore/i);
  assert.equal((await w.fingerprintState()).evidence, before.evidence);
});

test('R5-07 consulta da PR com timeout / resposta incompleta impede o pass e não grava nada', async () => {
  for (const mode of ['timeout', 'incomplete', 'fail'] as const) {
    const w = await World.create();
    await w.boot();
    await walkTo(w, 'pr-review');
    const c = await w.check('pr-review');
    const file = await w.rubric('pr-review', w.rubricIds('pr-review'), c.payload.snapshot);
    w.edges.ghViewMode = mode;
    const before = await w.fingerprintState();
    const r = await w.next('pr-review', 'pass', file);
    assert.notEqual(r.code, 0, `${mode}: ${r.out}`);
    assert.deepEqual(await w.fingerprintState(), before, `${mode}: nenhuma gravação`);
  }
});

test('R5-07 fechamento (document): código alterado depois do snapshot aprovado em pr-review NÃO fecha', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr-review');
  assert.equal((await w.pass('pr-review')).code, 0);
  w.edges.git.diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-um\n+dois\n'; // alteração posterior à revisão
  const r = await w.pass('document'); // o check/evidência do document reflete a árvore nova — o snapshot aprovado é outro
  assert.notEqual(r.code, 0, `não pode fechar: ${r.out}`);
  assert.match(r.err, /aprovad|revis/i);
  assert.equal((await w.run()).status, 'running');
});

test('R5-07 fechamento (document) com PR fechada depois da revisão NÃO conclui', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr-review');
  assert.equal((await w.pass('pr-review')).code, 0);
  w.edges.prs[0].state = 'CLOSED';
  const r = await w.pass('document');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /CLOSED/);
  assert.equal((await w.run()).status, 'running');
});

test('R5-07 feature fecha com PR correta e snapshot aprovado; planner é notificado', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'document');
  const r = await w.pass('document');
  assert.equal(r.code, 0, r.err);
  const run = await w.run();
  assert.equal(run.status, 'done');
  const s = await w.state();
  assert.ok(s.messages.some(m => m.runId === run.runId && m.type === 'notify' && m.to === 'planner' && /conclu/i.test(m.body)), 'planner notificado');
});

test('R5-07 hotfix fecha no pr-review com a PR observada; review-only NÃO consulta nem cria PR', async () => {
  const h = await World.create({ workflow: 'hotfix' });
  await h.boot();
  await walkTo(h, 'pr-review');
  const viewsBefore = h.edges.ghViewCalls;
  const r = await h.pass('pr-review');
  assert.equal(r.code, 0, r.err);
  assert.ok(h.edges.ghViewCalls > viewsBefore, 'hotfix consulta a PR no fechamento');
  assert.equal((await h.run()).status, 'done');

  const ro = await World.create({ workflow: 'review-only', checks: 'none' });
  await ro.boot();
  assert.equal((await ro.pass('review')).code, 0);
  assert.equal(ro.edges.ghViewCalls + ro.edges.ghListCalls + ro.edges.ghCreateCalls, 0, 'review-only não toca o gh');
});

// ---------- R5-08 — ledger reduzido; segunda passagem PR com novo operationId ----------

test('R5-08 ciclo completo: pr-review fail → correção → nova PR passagem com NOVO operationId reutiliza a PR e fecha sem intenção fantasma', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr-review');
  assert.equal(w.edges.ghCreateCalls, 1);
  // reviewer reprova a PR (fail real, pela CLI, com gap)
  const c = await w.check('pr-review');
  const failFile = await w.rubric('pr-review', w.rubricIds('pr-review'), c.payload.snapshot, undefined, 'fail');
  const failRes = await w.next('pr-review', 'fail', failFile, ['--gap', 'GAP-1']);
  assert.equal(failRes.code, 0, failRes.err);
  assert.equal((await w.run()).stage, 'build');
  // o dev corrige, commita e faz push: novo HEAD local e head remoto da PR existente
  w.edges.git.head = 'def4567';
  w.edges.prs[0].headRefOid = 'def4567';
  for (const stage of ['build', 'review', 'e2e'] as Stage[]) {
    const r = await w.pass(stage);
    assert.equal(r.code, 0, `${stage}: ${r.err}`);
  }
  const l1 = await ledger(w);
  assert.equal([...l1.values()].filter(i => i.status === 'confirmed').length, 1, 'primeira passagem confirmada');
  assert.deepEqual(blockingPrIntents(await w.state(), (await w.run()).runId), [], 'reserved→executed→confirmed NÃO deixa intenção ativa (R5-08)');
  const second = await w.pass('pr'); // novo operationId
  assert.equal(second.code, 0, second.err);
  assert.equal(w.edges.ghCreateCalls, 1, 'segunda passagem reutiliza a PR existente: zero create novo');
  assert.equal((await w.run()).pullRequest?.commit, 'def4567');
  assert.equal((await w.pass('pr-review')).code, 0);
  assert.equal((await w.pass('document')).code, 0);
  const run = await w.run();
  assert.equal(run.status, 'done');
  const finalLedger = await ledger(w);
  assert.equal(finalLedger.size, 2, 'duas intenções (uma por operationId)');
  assert.ok([...finalLedger.values()].every(i => i.status === 'confirmed'), 'ledger final sem ativo fantasma');
  assert.deepEqual(blockingPrIntents(await w.state(), run.runId), []);
  // Revisão B/B4: conta nos EVENTOS (o evento 'executed' preserva o detalhe; o 'confirmed' o substitui no ledger reduzido).
  const executedEvents = (await w.state()).events.filter(e => e.kind === 'pr-intent-updated').map(e => JSON.parse(e.detail) as { status: string; result?: { detail?: string } }).filter(i => i.status === 'executed');
  assert.equal(executedEvents.length, 2, 'uma execução por intenção');
  assert.equal(executedEvents.filter(i => JSON.parse(i.result?.detail ?? '{}').reused === false).length, 1, 'exatamente UMA criação real (a segunda passagem reutilizou)');
});

test('R5-08 segunda passagem com PR desatualizada (push pendente): diagnóstico, nada reservado e nada criado', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr-review');
  const c = await w.check('pr-review');
  const failFile = await w.rubric('pr-review', w.rubricIds('pr-review'), c.payload.snapshot, undefined, 'fail');
  assert.equal((await w.next('pr-review', 'fail', failFile, ['--gap', 'GAP-1'])).code, 0);
  w.edges.git.head = 'def4567'; // commit local novo, SEM push (PR remota continua no head antigo)
  for (const stage of ['build', 'review', 'e2e'] as Stage[]) assert.equal((await w.pass(stage)).code, 0);
  const intentsBefore = (await w.state()).events.filter(e => e.kind.startsWith('pr-intent')).length;
  const r = await w.pass('pr');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /push|head/i);
  assert.equal(w.edges.ghCreateCalls, 1, 'nenhum create');
  assert.equal((await w.state()).events.filter(e => e.kind.startsWith('pr-intent')).length, intentsBefore, 'nenhuma intenção reservada/uncertain por leitura');
  assert.equal((await w.run()).stage, 'pr');
  // após o push a MESMA rodada segue
  w.edges.prs[0].headRefOid = 'def4567';
  assert.equal((await w.pass('pr')).code, 0);
});

test('R5-08 timeout após aceitação: operação nova NÃO cria outra PR — reconcilia por leitura a PR criada', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr');
  w.edges.ghCreateMode = 'timeout-after-accept'; // a PR foi criada, a resposta estourou
  const first = await w.pass('pr', { opId: 'op-pr-A' });
  assert.notEqual(first.code, 0);
  assert.equal(w.edges.ghCreateCalls, 1);
  let intents = await ledger(w);
  assert.equal(intents.get('op-pr-A')?.status, 'uncertain');
  w.edges.ghCreateMode = 'ok';
  const second = await w.pass('pr', { opId: 'op-pr-B' }); // operationId DIFERENTE
  assert.equal(second.code, 0, second.err);
  assert.equal(w.edges.ghCreateCalls, 1, 'zero create novo');
  intents = await ledger(w);
  assert.equal(intents.get('op-pr-A')?.status, 'confirmed', 'pendência encerrada por reconciliação somente-leitura');
  assert.equal(intents.get('op-pr-B')?.status, 'confirmed');
});

test('R5-08 timeout SEM efeito comprovado: operação nova é BLOQUEADA (efeito desconhecido ≠ autorização de nova PR)', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr');
  w.edges.ghCreateMode = 'timeout-no-effect';
  assert.notEqual((await w.pass('pr', { opId: 'op-pr-A' })).code, 0);
  assert.equal(w.edges.ghCreateCalls, 1);
  w.edges.ghCreateMode = 'ok';
  const second = await w.pass('pr', { opId: 'op-pr-B' });
  assert.notEqual(second.code, 0, `não pode criar outra PR: ${second.out}`);
  assert.match(second.err, /op-pr-A|uncertain|efeito/i);
  assert.equal(w.edges.ghCreateCalls, 1, 'nenhuma segunda criação');
  assert.equal((await w.run()).stage, 'pr');
});

test('R5-08 mesma operação reexecutada após uncertain com PR presente: reconcilia por leitura e conclui sem duplicar', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr');
  w.edges.ghCreateMode = 'timeout-after-accept';
  const c = await w.check('pr');
  const file = await w.rubric('pr', w.rubricIds('pr'), c.payload.snapshot);
  assert.notEqual((await w.next('pr', 'pass', file, [], 'op-same')).code, 0);
  w.edges.ghCreateMode = 'ok';
  const again = await w.next('pr', 'pass', file, [], 'op-same');
  assert.equal(again.code, 0, again.err);
  assert.equal(w.edges.ghCreateCalls, 1);
  assert.equal((await ledger(w)).get('op-same')?.status, 'confirmed');
});

// ---------- R5-07 — convergência da documentação (documentRoots aprovadas) ----------

const DOC_DIFF = 'diff --git a/docs/features/x.md b/docs/features/x.md\n@@ -0,0 +1 @@\n+doc\n';
const NUL = String.fromCharCode(0);

test('R5-07 documentação SÓ nas raízes aprovadas (não commitada): fechamento aprova; código alterado junto não', async () => {
  const w = await World.create({ documentRoots: ['docs/features'] });
  await w.boot();
  await walkTo(w, 'pr-review');
  assert.equal((await w.pass('pr-review')).code, 0);
  w.edges.git.diff = DOC_DIFF; // a árvore completa muda; a árvore SEM as raízes documentais (diffCode) não
  const ok = await w.pass('document');
  assert.equal(ok.code, 0, ok.err);
  assert.equal((await w.run()).status, 'done');

  const w2 = await World.create({ documentRoots: ['docs/features'] });
  await w2.boot();
  await walkTo(w2, 'pr-review');
  assert.equal((await w2.pass('pr-review')).code, 0);
  w2.edges.git.diff = DOC_DIFF + 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-um\n+dois\n';
  w2.edges.git.diffCode = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-um\n+dois\n'; // código mudou
  const bad = await w2.pass('document');
  assert.notEqual(bad.code, 0, bad.out);
  assert.match(bad.err, /aprovad|revis/i);
});

test('R5-07 avanço de commit documental (git diff --name-only ⊆ documentRoots) fecha; avanço que toca código não', async () => {
  const mk = async (changed: string[]) => {
    const w = await World.create({ documentRoots: ['docs/features'] });
    await w.boot();
    await walkTo(w, 'pr-review');
    assert.equal((await w.pass('pr-review')).code, 0);
    // a documentação foi COMMITADA e enviada: HEAD local e head remoto avançam
    w.edges.git.head = 'd0c0c0de';
    w.edges.prs[0].headRefOid = 'd0c0c0de';
    w.edges.git.changedNames = changed.join(NUL) + NUL;
    return w;
  };
  const okW = await mk(['docs/features/x.md', 'docs/features/sub/y.md']);
  const ok = await okW.pass('document');
  assert.equal(ok.code, 0, ok.err);
  assert.equal((await okW.run()).status, 'done');

  const badW = await mk(['docs/features/x.md', 'src/a.ts']);
  const bad = await badW.pass('document');
  assert.notEqual(bad.code, 0, bad.out);
  assert.match(bad.err, /aprovad|revis|relação|commit/i);
  assert.equal((await badW.run()).status, 'running');
});

test('R5-07 avanço documental local que ainda não chegou à PR não fecha a entrega', async () => {
  const w = await World.create({ documentRoots: ['docs/features'] });
  await w.boot();
  await walkTo(w, 'pr-review');
  assert.equal((await w.pass('pr-review')).code, 0);
  const remoteHead = w.edges.prs[0].headRefOid;
  w.edges.git.head = 'd0c0c0de';
  w.edges.git.changedNames = 'docs/features/x.md' + NUL;
  assert.equal(w.edges.prs[0].headRefOid, remoteHead, 'fixture mantém PR remota no commit revisado');

  const result = await w.pass('document');
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.err, /head remoto|push|entrega final|commit/i);
  assert.equal((await w.run()).status, 'running');
});

test('R5-07 sem documentRoots aprovadas, QUALQUER avanço de commit depois da revisão exige nova revisão', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr-review');
  assert.equal((await w.pass('pr-review')).code, 0);
  w.edges.git.head = 'd0c0c0de';
  w.edges.prs[0].headRefOid = 'd0c0c0de';
  w.edges.git.changedNames = 'docs/features/x.md' + NUL;
  const r = await w.pass('document');
  assert.notEqual(r.code, 0, r.out);
  assert.equal((await w.run()).status, 'running');
});

// ---------- revisão independente B ----------

test('R5-07 (revisão B/B1) rename de código PARA DENTRO da raiz documental não é avanço documental (caminho antigo conta)', async () => {
  const w = await World.create({ documentRoots: ['docs/features'] });
  await w.boot();
  await walkTo(w, 'pr-review');
  assert.equal((await w.pass('pr-review')).code, 0);
  w.edges.git.head = 'd0c0c0de';
  w.edges.prs[0].headRefOid = 'd0c0c0de';
  // saída REAL do git 2.51 medida pelo revisor: `git mv src/secret.ts docs/features/secret.ts` — com renames ligados só o caminho novo.
  w.edges.git.changedNames = 'docs/features/secret.ts' + NUL;
  w.edges.git.changedNamesNoRenames = 'docs/features/secret.ts' + NUL + 'src/secret.ts' + NUL;
  const r = await w.pass('document');
  assert.notEqual(r.code, 0, `o código removido não pode fechar: ${r.out}`);
  assert.match(r.err, /aprovad|revis|relação|commit/i);
  assert.equal((await w.run()).status, 'running');
  const diffCall = w.edges.runner.calls.find(c => c.executable === 'git' && c.args[0] === 'diff' && c.args.includes('--name-only'));
  assert.ok(diffCall?.args.includes('--no-renames'), 'o adaptador pede --no-renames');
});

test('R5-08 (revisão B/B3) reconciliação por leitura exige head == commit da intenção: PR aberta num commit antigo NÃO encerra a pendência', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr');
  w.edges.ghCreateMode = 'timeout-after-accept';
  assert.notEqual((await w.pass('pr', { opId: 'op-pr-A' })).code, 0);
  w.edges.ghCreateMode = 'ok';
  w.edges.prs[0].headRefOid = 'ffff999'; // a PR observada NÃO está no commit da intenção
  const second = await w.pass('pr', { opId: 'op-pr-B' });
  assert.notEqual(second.code, 0, second.out);
  assert.equal(w.edges.ghCreateCalls, 1, 'nenhuma segunda criação');
  assert.equal((await ledger(w)).get('op-pr-A')?.status, 'uncertain', 'a pendência continua aberta');
});

test('R5-08 (revisão B/B7) mesma operação com HEAD novo: diagnóstico próprio (novo operationId), não erro de ledger', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr');
  const c = await w.check('pr');
  const file = await w.rubric('pr', w.rubricIds('pr'), c.payload.snapshot);
  w.edges.gitFailAfterCreate.add('status');
  assert.notEqual((await w.next('pr', 'pass', file, [], 'op-crash')).code, 0);
  w.edges.gitFailAfterCreate.clear();
  w.edges.git.head = 'beef0001';
  // evidência FRESCA no HEAD novo (senão o gate rejeitaria antes por obsolescência): o guarda é sobre o operationId reutilizado
  const c2 = await w.check('pr');
  const file2 = await w.rubric('pr', w.rubricIds('pr'), c2.payload.snapshot);
  const again = await w.next('pr', 'pass', file2, [], 'op-crash');
  assert.equal(again.code, 3, `${again.out} ${again.err}`);
  assert.match(again.err, /HEAD mudou.*NOVO operationId/);
  assert.doesNotMatch(again.err, /ledger de PR inválido/);
  assert.equal(w.edges.ghCreateCalls, 1);
});

test('R5-07 (revisão B/B5) start avisa que as raízes documentais aprovadas ficam fora da comparação do fechamento', async () => {
  const w = await World.create({ documentRoots: ['docs/features'] });
  await w.writeApproval();
  await w.up();
  const r = await w.start();
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /raízes documentais aprovadas \(docs\/features\)/);
  assert.deepEqual((JSON.parse(r.out) as { documentRoots?: string[] }).documentRoots, ['docs/features']);
});

// ---------- verificação independente V2 ----------

test('R5-07 (verificação V2-02) diff VAZIO entre commits distintos (ex.: submódulo com diff.ignoreSubmodules=all) NÃO prova só-documentação', async () => {
  const w = await World.create({ documentRoots: ['docs/features'] });
  await w.boot();
  await walkTo(w, 'pr-review');
  assert.equal((await w.pass('pr-review')).code, 0);
  w.edges.git.head = 'd0c0c0de';
  w.edges.prs[0].headRefOid = 'd0c0c0de';
  w.edges.git.changedNamesNoRenames = ''; // o Git com a config do repositório omitiu a mudança
  w.edges.git.changedNames = '';
  const r = await w.pass('document');
  assert.notEqual(r.code, 0, `não pode fechar sobre diff vazio: ${r.out}`);
  assert.match(r.err, /aprovad|revis|relação|commit/i);
  assert.equal((await w.run()).status, 'running');
  const diffCall = w.edges.runner.calls.find(c => c.executable === 'git' && c.args[0] === 'diff' && c.args.includes('--name-only'));
  assert.ok(diffCall?.args.includes('--ignore-submodules=none'), 'o adaptador neutraliza diff.ignoreSubmodules');
});

test('R5-08 (verificação V2-01) falha de leitura DEPOIS da reserva não envenena o ledger: nada criado, reserva liberada, reexecução conclui', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr');
  const c = await w.check('pr');
  const file = await w.rubric('pr', w.rubricIds('pr'), c.payload.snapshot);
  w.edges.ghListFailAt.add(w.edges.ghListCalls + 2); // 1ª leitura (pré-reserva) ok; 2ª (pós-reserva) falha
  const first = await w.next('pr', 'pass', file, [], 'op-releitura');
  assert.equal(first.code, 1, `${first.out} ${first.err}`);
  assert.match(first.err, /releitura somente-leitura.*após a reserva.*reserva foi liberada/);
  assert.equal(w.edges.ghCreateCalls, 0, 'nada criado');
  const intent = (await ledger(w)).get('op-releitura');
  assert.equal(intent?.status, 'reserved', `a intenção NÃO vira conflict/uncertain (status=${intent?.status})`);
  const again = await w.next('pr', 'pass', file, [], 'op-releitura'); // mesma operação, rede saudável, MESMO processo
  assert.equal(again.code, 0, again.err);
  assert.equal(w.edges.ghCreateCalls, 1);
  assert.equal((await ledger(w)).get('op-releitura')?.status, 'confirmed');
  assert.equal((await w.run()).stage, 'pr-review');
});

test('R5-08 (verificação V2-01) PR que aparece após a reserva com head divergente: diagnóstico de push (exit 3), nada criado, reserva liberada', async () => {
  const w = await World.create();
  await w.boot();
  await walkTo(w, 'pr');
  const c = await w.check('pr');
  const file = await w.rubric('pr', w.rubricIds('pr'), c.payload.snapshot);
  const at = w.edges.ghListCalls + 2;
  w.edges.ghListHook = n => {
    if (n === at) w.edges.prs.push({ url: 'https://github.com/acme/feat/pull/99', headRefName: 'sdlc/feat-1', baseRefName: 'main', headRefOid: 'ffff999', number: 99, state: 'OPEN' });
  };
  const first = await w.next('pr', 'pass', file, [], 'op-aparece');
  assert.equal(first.code, 3, `${first.out} ${first.err}`);
  assert.match(first.err, /apareceu após a reserva.*push/);
  assert.equal(w.edges.ghCreateCalls, 0);
  assert.equal((await ledger(w)).get('op-aparece')?.status, 'reserved');
  w.edges.prs[0].headRefOid = w.edges.git.head; // após o push
  const again = await w.next('pr', 'pass', file, [], 'op-aparece');
  assert.equal(again.code, 0, again.err);
  assert.equal(w.edges.ghCreateCalls, 0, 'reutilizou a PR existente');
});
