import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence, Stage } from '../../src/contracts.js';
import { FlowProject, HEAD, rubricItems, sha256, writeItems, type ManifestEntry } from './flow-fixtures.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555505';
const ENTRIES: ManifestEntry[] = [
  { id: 'REQ-1', stage: 'any', mandatory: true },
  { id: 'REQ-2', stage: 'review', mandatory: true },
];

async function mkProject(slug: string): Promise<FlowProject> {
  const p = await FlowProject.create({ projectId: PROJECT_ID, slug, name: 'Imp', approval: { entries: ENTRIES } });
  await p.boot();
  return p;
}

/** Itens de rubrica humana íntegros (log real, proveniência completa) — base das mutações campo a campo. */
async function items(p: FlowProject, stage: Stage, ids: string[], snapshot: unknown, o: { idOf?: (req: string, n: number) => string; timestamp?: string } = {}): Promise<Evidence[]> {
  const sess = await p.actor(stage === 'review' ? 'reviewer' : stage === 'build' ? 'dev' : 'tester-e2e');
  return rubricItems({
    root: p.root, slug: p.slug, stage, ids, projectId: PROJECT_ID, run: await p.run(), sess, snapshot, commit: HEAD,
    idOf: o.idOf, timestamp: o.timestamp,
  });
}

// R4-05/M4-F1 + R5-05 — reprodução da evidência estrangeira completa: mudar UM campo por
// vez exige rejeição sem transição, sem mesclar, sem entrega e sem publicação;
// evidência válida avança e preserva timestamp/procedimento/proveniência originais.
test('M4-F1: importação validada campo a campo; válida avança com proveniência preservada', async () => {
  const p = await mkProject('imp-1');

  // build: check executado pelo produto + rubrica importada válida (timestamp antigo
  // de propósito — a importação nunca o reescreve para agora).
  const chkB = await p.check('build');
  assert.equal(chkB.code, 0, chkB.err);
  const run0 = await p.run();
  const dev = await p.actor('dev');
  const rubricB = await items(p, 'build', ['REQ-1'], chkB.payload.snapshot, { idOf: () => 'ev-imp-req', timestamp: '2020-01-01T00:00:00Z' });
  await writeItems(p.root, 'ev.json', rubricB);
  const first = await p.next('build', 'pass', 'ev.json', { opId: 'op-imp-1' });
  assert.equal(first.code, 0, first.err);
  const merged = (await p.state()).evidence.find(e => e.id === 'ev-imp-req')!;
  assert.equal(merged.imported, true, 'importada marcada');
  assert.equal(merged.timestamp, '2020-01-01T00:00:00Z', 'timestamp antigo preservado (nunca reescrito para agora)');
  assert.equal(merged.producedAt, '2020-01-01T00:00:00Z', 'producedAt original preservado');
  assert.equal(merged.procedure, 'rubrica humana do estágio build', 'procedimento preservado');
  assert.equal(merged.runId, run0.runId, 'runId preservado (não reatribuído)');
  assert.equal(merged.stage, 'build', 'stage preservado');
  assert.equal(merged.projectId, PROJECT_ID, 'projectId preservado');
  assert.equal(merged.revision, run0.revision, 'revisão preservada');
  assert.equal(merged.producer?.threadId, dev.threadId, 'produtor preservado (a importação não reatribui)');
  assert.equal(merged.codeSnapshot?.diffFingerprint, (chkB.payload.snapshot as { diffFingerprint: string }).diffFingerprint, 'snapshot copiado do check preservado');
  assert.ok(merged.importedAt, 'importedAt registrado separado da produção');
  assert.equal((await p.run()).stage, 'review');

  // review: check do produto (unit+lint) e matriz de mutação — UM campo por vez. O item mutado é o de
  // REQ-1; REQ-2 segue íntegro, então a rejeição é atribuível ao campo alterado.
  const chkR = await p.check('review');
  assert.equal(chkR.code, 0, chkR.err);
  const run1 = await p.run();
  const validReview = await items(p, 'review', ['REQ-1', 'REQ-2'], chkR.payload.snapshot, { idOf: (req) => `ev-rev-${req}` });
  const omit = <K extends keyof Evidence>(k: K) => (e: Evidence): Evidence => { const c = { ...e }; delete c[k]; return c; };
  const mutations: Array<[string, (e: Evidence) => Evidence, RegExp]> = [
    ['runId de outra execução', e => ({ ...e, runId: 'run-estrangeiro' }), /outra execução/],
    ['runId ausente', omit('runId'), /sem runId/],
    ['stage divergente', e => ({ ...e, stage: 'build' as Stage }), /stage build diverge/],
    ['stage ausente', omit('stage'), /sem stage/],
    ['projectId divergente', e => ({ ...e, projectId: 'outro-projeto' }), /projectId/],
    ['projectId ausente', omit('projectId'), /sem projectId/],
    ['timestamp ausente', e => ({ ...e, timestamp: '' }), /timestamp/],
    ['procedimento vazio', e => ({ ...e, procedure: ' ' }), /procedure/],
    ['revisão errada', e => ({ ...e, revision: 999 }), /revisão 999/],
    ['revisão ausente', omit('revision'), /sem revisão/],
    ['producer ausente', omit('producer'), /sem producer/],
    ['producer de OUTRA sessão', e => ({ ...e, producer: { role: 'reviewer', threadId: 'thread-outra', generationId: 'gen-outra' } }), /producer diverge/],
    ['codeSnapshot ausente', omit('codeSnapshot'), /codeSnapshot/],
    ['commit diverge do commit do snapshot', e => ({ ...e, commit: 'deadbeef' }), /diverge do commit do codeSnapshot/],
    ['logHash ausente', omit('logHash'), /logHash/],
    ['log ausente', e => ({ ...e, logPath: 'logs/inexistente.log' }), /log ausente/],
    ['log adulterado', e => ({ ...e, logHash: sha256('conteúdo original\n') }), /adulterado/],
    ['requirementId fora do slug:stage', e => ({ ...e, requirementId: 'outro:review:REQ-1' }), /requirementId/],
    ['exit0 autodeclarado de check do produto', e => ({ ...e, check: 'unit', exitCode: 0, requirementId: 'imp-1:review:check-unit' }), /executado pelo produto/],
    ['proveniência legacy', e => ({ ...e, provenance: 'legacy' as const }), /legacy/],
    ['id duplicado no estado', e => ({ ...e, id: 'ev-imp-req' }), /id já existe/],
  ];
  let opN = 0;
  for (const [name, mutate, pattern] of mutations) {
    const before = await p.fingerprint();
    const [first, second] = validReview;
    const item = mutate({ ...first, id: name === 'id duplicado no estado' ? 'ev-imp-req' : `ev-mut-${opN}` });
    if (name === 'log adulterado') {
      // grava log com conteúdo divergente do hash declarado
      await mkdir(join(p.root, 'logs'), { recursive: true });
      await writeFile(join(p.root, 'logs', `log-ev-mut-${opN}.log`), 'conteúdo divergente\n');
      item.logPath = `logs/log-ev-mut-${opN}.log`;
    }
    await writeItems(p.root, `ev-mut-${opN}.json`, [item, { ...second, id: `ev-mut-${opN}-r2` }]);
    const y = await p.next('review', 'pass', `ev-mut-${opN}.json`, { opId: `op-mut-${opN}` });
    assert.equal(y.code, 3, `${name}: exit 3 (rejeição sem transição): ${y.err}`);
    assert.match(y.err, pattern, `${name}: rejeição atribuída ao campo`);
    const after = await p.fingerprint();
    assert.equal(after.stage, 'review', `${name}: sem transição`);
    assert.equal(after.revision, run1.revision, `${name}: sem revisão nova`);
    assert.equal(after.evidence, before.evidence, `${name}: evidência não mesclada`);
    assert.equal(after.messages, before.messages, `${name}: sem entrega nova`);
    assert.equal(after.deliveries, before.deliveries, `${name}: sem outbox nova`);
    assert.equal((await p.state()).operations[`op-mut-${opN}`].accepted, false, `${name}: operação registrada como rejeitada`);
    opN++;
  }
  assert.equal(p.harness.ghCalls(), 0, 'nenhuma rejeição de importação toca o gh');
  // replay da rejeição devolve a rejeição anterior sem regravar
  const replay = await p.next('review', 'pass', 'ev-mut-0.json', { opId: 'op-mut-0' });
  assert.equal(replay.code, 3);

  // evidência válida avança
  await writeItems(p.root, 'ev-rev-ok.json', validReview);
  const w = await p.next('review', 'pass', 'ev-rev-ok.json', { opId: 'op-rev-ok' });
  assert.equal(w.code, 0, w.err);
  assert.equal((await p.run()).stage, 'e2e');
});

// M4-F3 — gate por manifesto aprovado: IDs desconhecidos e obrigatórios sem
// cobertura reprovam; cobertura completa avança.
test('M4-F3: gate exige cobertura do manifesto aprovado aplicável à etapa', async () => {
  const p = await mkProject('man-1');

  // build: REQ-1 (any) coberto; REQ-2 é do estágio review — não se exige aqui.
  assert.equal((await p.pass('build')).code, 0);
  assert.equal((await p.run()).stage, 'review');

  // review: REQ-2 obrigatório sem cobertura reprova.
  const chk = await p.check('review');
  assert.equal(chk.code, 0, chk.err);
  const reviewer = await p.actor('reviewer');
  const snapshot = chk.payload.snapshot;
  const mk = (ids: string[], tag: string) => items(p, 'review', ids, snapshot, { idOf: (req) => `ev-man-${tag}-${req}` });
  const onlyReq1 = await mk(['REQ-1'], 'r1');
  const before = await p.fingerprint();
  let r = await p.next('review', 'pass', await writeItems(p.root, 'ev-man-r1.json', onlyReq1), { sess: reviewer, opId: 'op-man-r1' });
  assert.equal(r.code, 3);
  assert.match(r.err, /REQ-2 sem cobertura/, r.err);
  assert.equal((await p.run()).stage, 'review');
  assert.equal((await p.fingerprint()).evidence, before.evidence, 'evidência da rejeição não é mesclada');

  // requisito fora do plano aprovado reprova.
  const withUnknown = await items(p, 'review', ['REQ-9'], snapshot, { idOf: () => 'ev-man-r9' });
  r = await p.next('review', 'pass', await writeItems(p.root, 'ev-man-r9.json', [...onlyReq1, ...withUnknown]), { sess: reviewer, opId: 'op-man-r9' });
  assert.equal(r.code, 3);
  assert.match(r.err, /fora do plano aprovado/, r.err);

  // cobertura completa (REQ-1 + REQ-2) avança.
  const full = await mk(['REQ-1', 'REQ-2'], 'full');
  r = await p.next('review', 'pass', await writeItems(p.root, 'ev-man-full.json', full), { sess: reviewer, opId: 'op-man-r2' });
  assert.equal(r.code, 0, r.err);
  assert.equal((await p.run()).stage, 'e2e');

  // R5-05 (substitui "manifesto desvinculado por alteração do plano"): o manifesto pertence à APROVAÇÃO.
  // Substituído depois do start, o hash difere do aprovado e o `next` (mesmo `fail`) e o `check` falham
  // fechado — nada é gravado — e a mesma operação é repetível depois de restaurar o manifesto aprovado.
  const tester = await p.actor('tester-e2e');
  const reqPath = join(p.root, 'requirements.json');
  const approved = await readFile(reqPath, 'utf8');
  const tampered = JSON.parse(approved) as { entries: Array<{ mandatory: boolean }> };
  tampered.entries[1].mandatory = false; // afrouxa uma exigência obrigatória
  await writeFile(reqPath, JSON.stringify(tampered));
  const failFile = await p.rubric('e2e', ['REQ-1'], await p.snapshotNow(), { sess: tester, result: 'fail' });
  const fp = await p.fingerprint();
  const denied = await p.next('e2e', 'fail', failFile, { sess: tester, opId: 'op-man-x' });
  assert.equal(denied.code, 3, `${denied.out} ${denied.err}`);
  assert.match(denied.err, /manifesto de requisitos divergente do aprovado/);
  assert.deepEqual(await p.fingerprint(), fp, 'nada gravado (nenhuma operação/evidência/entrega)');
  const deniedCheck = await p.check('e2e', tester);
  assert.equal(deniedCheck.code, 3, deniedCheck.err);
  assert.match(deniedCheck.err, /manifesto de requisitos divergente do aprovado/);
  assert.deepEqual(await p.fingerprint(), fp, 'check também não grava com manifesto substituído');
  await writeFile(reqPath, approved);
  const restored = await p.next('e2e', 'fail', failFile, { sess: tester, opId: 'op-man-x' });
  assert.equal(restored.code, 0, restored.err);
  assert.equal((await p.run()).stage, 'build', 'e2e reprovado volta ao build depois de restaurar o manifesto aprovado');
});

// R5-05 — manifesto desvinculado do plano aprovado (planHash de OUTRO plano) falha fechado no start.
test('M4-F3: manifesto desvinculado do plano aprovado não inicia execução', async () => {
  const p = await FlowProject.create({
    projectId: PROJECT_ID, slug: 'man-2', name: 'Imp',
    approval: {
      entries: ENTRIES,
      manifestText: JSON.stringify({ schemaVersion: 1, planPath: 'plan.md', planHash: sha256('# plano ALTERADO\n'), entries: ENTRIES }),
    },
  });
  await p.approve();
  await p.up();
  const r = await p.start();
  assert.equal(r.code, 2, `${r.out} ${r.err}`);
  assert.match(r.err, /hash diferente do plano aprovado|outro plano/);
  assert.equal((await p.state()).runs.length, 0, 'nenhuma execução criada');
});

// M4-F3 — obsolescência por alteração: árvore alterada após o check (HEAD igual)
// invalida o gate; restaurar a árvore permite concluir.
test('M4-F3: alteração da árvore após check invalida gates; HEAD igual não prova árvore igual', async () => {
  const p = await mkProject('obs-1'); // boot com a árvore v1
  p.harness.git.diff = 'diff v1\n';
  const dev = await p.actor('dev');
  const chk = await p.check('build', dev);
  assert.equal(chk.code, 0, chk.err);
  const s1 = chk.payload.snapshot;
  const rubricAt = (snapshot: unknown, tag: string) => items(p, 'build', ['REQ-1'], snapshot, { idOf: () => `ev-obs-${tag}` });
  const rejectsWith = async (name: string, file: string, code: number, pattern: RegExp) => {
    const before = await p.fingerprint();
    const r = await p.next('build', 'pass', file, { sess: dev, opId: `op-obs-${name}` });
    assert.equal(r.code, code, `${name}: ${r.out} ${r.err}`);
    assert.match(r.err, pattern, `${name}: ${r.err}`);
    const after = await p.fingerprint();
    assert.equal(after.stage, 'build', `${name}: sem transição com árvore alterada`);
    assert.equal(after.revision, before.revision);
    assert.equal(after.evidence, before.evidence, `${name}: evidência não mesclada`);
  };

  // A) árvore alterada DEPOIS do check (diff muda, HEAD igual): o check-build aprovado ficou com snapshot
  // obsoleto e a rubrica que copia o snapshot antigo também — o gate reprova.
  p.harness.git.diff = 'diff v2 — árvore diferente, mesmo HEAD\n';
  await rejectsWith('A', await writeItems(p.root, 'ev-obs-a.json', await rubricAt(s1, 'a')), 3, /check obrigatório/);

  // B) R5-05 (substitui "snapshot opcional na rubrica"): rubrica SEM codeSnapshot é recusada na importação.
  p.harness.git.diff = 'diff v1\n';
  await rejectsWith('B', await writeItems(p.root, 'ev-obs-b.json', await rubricAt(undefined, 'b')), 3, /codeSnapshot/);

  // C) evidência de check declarada (não é do produto) sem snapshot verificado também reprova.
  const noSnapCheck = { ...(await rubricAt(s1, 'c-check'))[0], id: 'ev-obs-c-check', requirementId: 'obs-1:build:check-externo', check: 'externo', exitCode: 0 } as Evidence;
  delete noSnapCheck.codeSnapshot;
  const rubricC = await rubricAt(s1, 'c');
  await rejectsWith('C', await writeItems(p.root, 'ev-obs-c.json', [...rubricC, noSnapCheck]), 3, /codeSnapshot/);

  // D) rubrica com snapshot de OUTRA árvore (v3) enquanto o check e a árvore atual são v1: obsoleta.
  p.harness.git.diff = 'diff v3 — nova alteração\n';
  const s3 = await p.snapshotNow();
  p.harness.git.diff = 'diff v1\n';
  await rejectsWith('D', await writeItems(p.root, 'ev-obs-d.json', await rubricAt(s3, 'd')), 3, /árvore alterada/);

  // restaura a árvore: check e gates válidos de novo => avança.
  const ok = await items(p, 'build', ['REQ-1'], s1, { idOf: () => 'ev-obs-ok' });
  const r = await p.next('build', 'pass', await writeItems(p.root, 'ev-obs-ok.json', ok), { sess: dev, opId: 'op-obs-ok' });
  assert.equal(r.code, 0, r.err);
  assert.equal((await p.run()).stage, 'review');
});
