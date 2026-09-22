import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPrIntent, latestPrIntent, PR_INTENT_RESERVED, PR_INTENT_UPDATED } from '../../src/pipeline/pr-intents.js';
import type { CodeSnapshot, PrIntent } from '../../src/contracts.js';
import { FlowProject, HEAD, type PrRow } from './flow-fixtures.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555505';
const PR7: PrRow = { url: 'https://github.com/acme/feat/pull/7', headRefName: 'sdlc/fx', baseRefName: 'main', headRefOid: HEAD, number: 7, state: 'OPEN' };
const PR9: PrRow = { url: 'https://github.com/acme/feat/pull/9', headRefName: 'sdlc/fx', baseRefName: 'main', headRefOid: HEAD, number: 9, state: 'OPEN' };
/** identidade do repositório calculada pelo produto (git remote get-url origin do fake) — o ledger valida a identidade. */
const REPO = 'git@github.com:acme/feat.git';

/**
 * R4-04/R5 — efeito externo do estágio pr pela fronteira PÚBLICA. O run vem do fluxo real (start com aprovação
 * + manifesto); `seedStage` só POSICIONA o run em `pr` (não autoriza gate); o check do produto e a rubrica com
 * proveniência completa (snapshot copiado do `check`) são produzidos pelos comandos reais. Falsos só nas bordas
 * (gh/git/tool/codex).
 */
async function bootPr() {
  const p = await FlowProject.create({
    projectId: PROJECT_ID, slug: 'fx', name: 'PrFx', checks: { build: { executable: 'tool', args: ['build'] } },
    approval: { entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }] },
  });
  await p.boot();
  await p.seedStage('pr');
  const dev = await p.actor('dev');
  const c = await p.check('pr', dev);
  assert.equal(c.code, 0, c.err);
  const file = await p.rubric('pr', ['REQ-1'], c.payload.snapshot, { sess: dev });
  const run = await p.run();
  return { p, dev, file, run, revision: run.revision, snapshot: c.payload.snapshot as CodeSnapshot };
}
type Booted = Awaited<ReturnType<typeof bootPr>>;
const nextPr = (b: Booted, opId: string, revision = b.revision) => b.p.next('pr', 'pass', b.file, { sess: b.dev, opId, revision });

function intent(b: Booted, operationId: string, status: PrIntent['status'], result?: PrIntent['result']): PrIntent {
  return {
    intentId: operationId, operationId, runId: b.run.runId, repo: REPO, base: 'main', branch: 'sdlc/fx', headCommit: HEAD,
    snapshot: b.snapshot, status, createdAt: new Date().toISOString(), ...(result ? { result } : {}),
  };
}
/** Ledger válido (R5-08): a reserva SEMPRE antecede qualquer atualização. */
async function seedLedger(b: Booted, operationId: string, ...statuses: Array<[PrIntent['status'], PrIntent['result']?]>) {
  await b.p.store().mutate(s => {
    let next = appendPrIntent(s, intent(b, operationId, 'reserved'), PR_INTENT_RESERVED);
    for (const [status, result] of statuses) next = appendPrIntent(next, intent(b, operationId, status, result), PR_INTENT_UPDATED);
    return { state: next, result: undefined };
  });
}

// R4-04 — pedido inválido (revisão divergente) gera ZERO chamadas ao gh: a
// pré-validação pura ocorre antes de qualquer efeito externo.
test('R4-04: pedido inválido gera zero chamadas ao gh', async () => {
  const b = await bootPr();
  const r = await nextPr(b, 'op-invalido', 99);
  assert.equal(r.code, 3);
  assert.match(r.err, /estágio ou revisão divergente/);
  assert.equal(b.p.harness.ghCalls(), 0, 'ZERO chamadas ao gh em pedido inválido');
  assert.equal(b.p.harness.ghCreateCalls, 0, 'zero chamadas mutáveis');
  const state = await b.p.state();
  assert.equal(state.runs[0].stage, 'pr', 'sem transição');
  assert.equal(state.operations['op-invalido'].accepted, false);
  assert.ok(!state.events.some(e => e.kind === 'pr-intent-reserved'), 'sem intenção reservada');
});

test('efeito pr: PR existente é reutilizada (zero create); intenção reservada→executed→confirmed', async () => {
  const b = await bootPr();
  b.p.harness.prs.push(PR7);
  const r = await nextPr(b, 'op-reuse');
  assert.equal(r.code, 0, r.err);
  assert.equal(b.p.harness.ghCreateCalls, 0, 'PR existente localizada antes de criar outra');
  assert.ok(b.p.harness.ghListCalls >= 1);
  const state = await b.p.state();
  assert.equal(state.runs[0].pullRequest?.url, PR7.url);
  assert.equal(state.runs[0].pullRequest?.commit, HEAD);
  assert.equal(state.runs[0].stage, 'pr-review');
  assert.equal(latestPrIntent(state, 'op-reuse')?.status, 'confirmed', 'intenção confirmada com a transição (redução por operationId)');
  assert.ok(state.events.some(e => e.kind === PR_INTENT_RESERVED), 'reserva persistida antes do efeito');
});

test('efeito pr: sem PR existente cria exatamente uma; replay não repete rede nem gravação', async () => {
  const b = await bootPr();
  b.p.harness.nextPr = 9;
  const r = await nextPr(b, 'op-create');
  assert.equal(r.code, 0, r.err);
  assert.equal(b.p.harness.ghCreateCalls, 1, 'exatamente uma criação');
  let state = await b.p.state();
  assert.equal(state.runs[0].pullRequest?.url, PR9.url);
  assert.equal(latestPrIntent(state, 'op-create')?.status, 'confirmed');
  const listAfterCreate = b.p.harness.ghListCalls;
  const viewAfterCreate = b.p.harness.ghViewCalls;
  const revAfterCreate = state.revision;
  // Replay idêntico: mesmo resultado, zero rede, zero gravação.
  const y = await nextPr(b, 'op-create');
  assert.equal(y.code, 0, y.err);
  const replayOut = JSON.parse(y.out) as { replay: boolean; status: string };
  assert.equal(replayOut.replay, true);
  assert.equal(replayOut.status, 'running');
  assert.equal(b.p.harness.ghListCalls, listAfterCreate, 'replay não reconsulta a rede');
  assert.equal(b.p.harness.ghViewCalls, viewAfterCreate, 'replay não observa a PR de novo');
  assert.equal(b.p.harness.ghCreateCalls, 1);
  state = await b.p.state();
  assert.equal(state.revision, revAfterCreate, 'replay não regrava');
});

// R4-04/R5-08 — intenção NÃO confirmada de OUTRA operação da mesma execução bloqueia novo efeito. Uma
// reserva sem desfecho é efeito desconhecido: nenhuma leitura autoriza publicar; o pedido falha antes da rede.
test('R4-04/concorrência: intenção ativa de outra operação impede segunda publicação', async () => {
  const b = await bootPr();
  // Simula reserva concorrente já persistida (outro operationId, mesma execução).
  await seedLedger(b, 'op-outra');
  const r = await nextPr(b, 'op-eu');
  assert.equal(r.code, 3);
  assert.match(r.err, /op-outra.*reserved|não comprovado/);
  assert.equal(b.p.harness.ghCalls(), 0, 'concorrência bloqueada antes da rede');
  const state = await b.p.state();
  assert.equal(state.runs[0].stage, 'pr', 'sem transição');
  assert.equal(state.operations['op-eu'], undefined, 'conflito de reserva sem gravação');
});

// R5-08 (substitui "só reserved bloqueia / confirmed marcado como ativo"): `conflict`, `executed` e
// `uncertain` de OUTRA operação também bloqueiam enquanto o efeito não for COMPROVADO por leitura;
// `executed` cuja PR aberta correspondente é observada é reconciliada como confirmed e a operação nova
// reutiliza a PR (zero create).
for (const status of ['conflict', 'uncertain'] as const) {
  test(`R5-08: intenção '${status}' de outra operação bloqueia novo efeito sem PR comprovada`, async () => {
    const b = await bootPr();
    await seedLedger(b, 'op-outra', [status, { checkedAt: new Date().toISOString(), detail: 'efeito incerto' }]);
    const r = await nextPr(b, 'op-eu');
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, new RegExp(`op-outra.*${status}`));
    assert.equal(b.p.harness.ghCreateCalls, 0, 'nenhuma PR criada');
    const state = await b.p.state();
    assert.equal(state.runs[0].stage, 'pr');
    assert.equal(latestPrIntent(state, 'op-outra')?.status, status, 'pendência preservada até verificação');
    assert.equal(state.operations['op-eu'], undefined);
  });
}

test('R5-08: intenção executed de outra operação com PR aberta comprovada por leitura é reconciliada e a nova operação reutiliza a PR', async () => {
  const b = await bootPr();
  b.p.harness.prs.push(PR7);
  await seedLedger(b, 'op-outra', ['executed', { url: PR7.url, number: 7, checkedAt: new Date().toISOString() }]);
  const r = await nextPr(b, 'op-eu');
  assert.equal(r.code, 0, r.err);
  assert.equal(b.p.harness.ghCreateCalls, 0, 'zero create');
  const state = await b.p.state();
  assert.equal(latestPrIntent(state, 'op-outra')?.status, 'confirmed', 'reconciliada por leitura');
  assert.equal(latestPrIntent(state, 'op-eu')?.status, 'confirmed');
  assert.equal(state.runs[0].pullRequest?.url, PR7.url);
});

test('timeout após possível aceitação => uncertain; reconciliação por leitura reutiliza a PR sem create cego', async () => {
  const b = await bootPr();
  b.p.harness.ghCreateMode = 'timeout-no-effect';
  const r = await nextPr(b, 'op-timeout');
  assert.equal(r.code, 1);
  assert.match(r.err, /incerta|uncertain/);
  let state = await b.p.state();
  assert.equal(latestPrIntent(state, 'op-timeout')?.status, 'uncertain', 'timeout nunca vira retry cego');
  assert.equal(state.runs[0].stage, 'pr', 'sem transição em incerteza');
  assert.equal(state.operations['op-timeout'], undefined, 'operação não registrada como concluída');
  assert.equal(b.p.harness.ghCreateCalls, 1, 'o create foi tentado uma vez');
  // A PR de fato existia (aceitação ocorrida apesar do timeout): reconciliação
  // por LEITURA reutiliza sem novo create.
  b.p.harness.ghCreateMode = 'ok';
  b.p.harness.prs.push(PR9);
  const y = await nextPr(b, 'op-timeout');
  assert.equal(y.code, 0, y.err);
  assert.equal(b.p.harness.ghCreateCalls, 1, 'reconciliação não cria segunda PR');
  state = await b.p.state();
  assert.equal(state.runs[0].pullRequest?.url, PR9.url);
  assert.equal(state.runs[0].stage, 'pr-review');
  assert.equal(latestPrIntent(state, 'op-timeout')?.status, 'confirmed');
});

test('autorização revogada => conflict; reexecução não avança nem repete create', async () => {
  const b = await bootPr();
  b.p.harness.ghCreateMode = 'fail';
  const r = await nextPr(b, 'op-auth');
  assert.equal(r.code, 1);
  assert.match(r.err, /autorização revogada/);
  let state = await b.p.state();
  assert.equal(latestPrIntent(state, 'op-auth')?.status, 'conflict');
  assert.equal(state.runs[0].stage, 'pr', 'não avança indevidamente');
  const y = await nextPr(b, 'op-auth');
  assert.equal(y.code, 1);
  assert.match(y.err, /conflict/);
  assert.equal(b.p.harness.ghCreateCalls, 1, 'falha fechada: sem segundo create');
  state = await b.p.state();
  assert.equal(state.runs[0].stage, 'pr');
});

// R5-07 (substitui "PR existente com head divergente => uncertain"): a leitura acontece ANTES de reservar;
// PR existente com head remoto != HEAD verificado é diagnóstico de push pendente — nada reservado, nada
// criado, nenhuma operação registrada — e a mesma rodada segue após o push.
test('R5-07: PR existente com head divergente do HEAD => push pendente; nada reservado, nada criado', async () => {
  const b = await bootPr();
  b.p.harness.prs.push({ ...PR7, headRefOid: 'outro999', number: 3 });
  const r = await nextPr(b, 'op-head');
  assert.equal(r.code, 3);
  assert.match(r.err, /push|head/i);
  const state = await b.p.state();
  assert.equal(state.events.filter(e => e.kind.startsWith('pr-intent')).length, 0, 'nenhuma intenção reservada por leitura');
  assert.equal(state.runs[0].stage, 'pr');
  assert.equal(state.operations['op-head'], undefined);
  assert.equal(b.p.harness.ghCreateCalls, 0, 'nenhum create com head divergente');
  b.p.harness.prs[0].headRefOid = HEAD; // após o push
  const ok = await nextPr(b, 'op-head');
  assert.equal(ok.code, 0, ok.err);
  assert.equal(b.p.harness.ghCreateCalls, 0);
});

test('head divergente na resposta do create => uncertain; não avança', async () => {
  const b = await bootPr();
  b.p.harness.ghCreateHead = 'outro999'; // a PR criada devolve head diferente do HEAD verificado
  const r = await nextPr(b, 'op-head2');
  assert.equal(r.code, 1);
  assert.match(r.err, /incerto/);
  const state = await b.p.state();
  assert.equal(latestPrIntent(state, 'op-head2')?.status, 'uncertain');
  assert.equal(state.runs[0].stage, 'pr');
  assert.equal(b.p.harness.ghCreateCalls, 1, 'o create ocorreu uma vez; a incerteza impede novo create');
});

test('crash após criação antes da persistência: reexecutão reutiliza a PR sem rede e sem duplicação', async () => {
  const b = await bootPr();
  // Simula o estado pós-crash: intenção 'executed' gravada (reserva → executed), transação NÃO.
  await seedLedger(b, 'op-crash', ['executed', { url: PR9.url, number: 9, checkedAt: new Date().toISOString(), detail: JSON.stringify({ commit: HEAD }) }]);
  const r = await nextPr(b, 'op-crash');
  assert.equal(r.code, 0, r.err);
  assert.equal(b.p.harness.ghCalls(), 0, 'reutiliza a PR sem nenhuma chamada de rede');
  const state = await b.p.state();
  assert.equal(state.runs[0].pullRequest?.url, PR9.url, 'PR da intenção reutilizada');
  assert.equal(state.runs[0].stage, 'pr-review');
  assert.equal(latestPrIntent(state, 'op-crash')?.status, 'confirmed');
});

test('crash após reserva antes do efeito: reconciliação localiza a PR sem create', async () => {
  const b = await bootPr();
  b.p.harness.prs.push(PR7);
  await seedLedger(b, 'op-res');
  const r = await nextPr(b, 'op-res');
  assert.equal(r.code, 0, r.err);
  assert.equal(b.p.harness.ghCreateCalls, 0, 'reserva anterior + PR existente => zero create');
  const state = await b.p.state();
  assert.equal(state.runs[0].pullRequest?.url, PR7.url);
  assert.equal(state.runs[0].stage, 'pr-review');
  assert.equal(latestPrIntent(state, 'op-res')?.status, 'confirmed');
});

// R5-08 (substitui a semeadura de `updated` SEM reserva, que o ledger antigo ignorava): ledger inválido
// falha FECHADO (exit 1, diagnóstico) antes de qualquer rede — ignorar autorizaria uma nova publicação.
test('R5-08: ledger de PR inválido (executed sem reserva) falha fechado sem rede e sem transição', async () => {
  const b = await bootPr();
  await b.p.store().mutate(s => ({
    state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: PR_INTENT_UPDATED, detail: JSON.stringify(intent(b, 'op-orfa', 'executed', { url: PR9.url, number: 9 })) }] },
    result: undefined,
  }));
  const r = await nextPr(b, 'op-eu');
  assert.equal(r.code, 1);
  assert.match(r.err, /ledger de PR inválido/);
  assert.equal(b.p.harness.ghCalls(), 0, 'nenhuma rede acionada');
  assert.equal((await b.p.state()).runs[0].stage, 'pr');
});

// M8/N1 — revisão cruzada: dois comandos `next pr` concorrentes com o MESMO
// operationId devem produzir NO MÁXIMO uma PR. Antes da correção, ambos liam o
// pré-flight sem lock, a reserva não enxergava a própria intenção do vencedor e
// o mutate final no-opiava em silêncio — dois creates, dois exit 0.
test('M8/N1: concorrência mesmo operationId cria no máximo uma PR', async () => {
  const b = await bootPr();
  const [r1, r2] = await Promise.all([nextPr(b, 'op-n1'), nextPr(b, 'op-n1')]);
  assert.ok(r1.code === 0 || r2.code === 0, `pelo menos um executor conclui: ${r1.code}/${r2.code} ${r1.err} ${r2.err}`);
  assert.equal(b.p.harness.ghCreateCalls, 1, `no máximo UMA PR criada (criadas: ${b.p.harness.ghCreateCalls})`);
  // Rede do vencedor: leitura ANTES de reservar + releitura DEPOIS de vencer a reserva (revisão B/B6) + list interno do
  // createPr => até 3 leituras, somadas ao perdedor (que lê antes de reservar e aborta na reserva sem criar) => até 4.
  // Todas SOMENTE LEITURA; a garantia é o único create (assert acima).
  assert.ok(b.p.harness.ghListCalls <= 4, `leituras gh bounded (list: ${b.p.harness.ghListCalls})`);
  const state = await b.p.state();
  assert.equal(state.runs[0].stage, 'pr-review', 'transição aplicada exatamente uma vez');
  assert.equal(state.runs[0].revision, b.revision + 1, 'revisão avançou uma vez');
  const op = state.operations['op-n1'];
  assert.equal(op.accepted, true, 'operação registrada como concluída');
  assert.equal(latestPrIntent(state, 'op-n1')?.status, 'confirmed');
});
