import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { World, io, sha256, PROJECT_ID } from './r5-harness.js';
import { runCli } from '../../src/cli.js';

// R5-03/R5-04/R5-05 — gates obrigatórios pela fronteira PÚBLICA (runCli). Cada caso
// remove exatamente UM fato do fluxo completo; a rejeição afirma: estágio/revisão
// preservados, nenhuma evidência/task/entrega criada, zero efeito externo mutável.

async function noEffect(w: World, before: Awaited<ReturnType<World['fingerprintState']>>): Promise<void> {
  const after = await w.fingerprintState();
  assert.equal(after.stage, before.stage, 'estágio preservado');
  assert.equal(after.revision, before.revision, 'revisão preservada');
  assert.equal(after.status, before.status);
  assert.equal(after.evidence, before.evidence, 'nenhuma evidência adicionada');
  assert.equal(after.messages, before.messages, 'nenhuma task/notify criada');
  assert.equal(after.deliveries, before.deliveries, 'nenhuma entrega/outbox criada');
  assert.equal(w.edges.ghCreateCalls, 0, 'zero gh pr create');
}

// ---------- R5-03 — política única de checks ----------

test('R5-03 checks:{} sem evidência mecânica: next build pass é rejeitado, nada avança', async () => {
  const w = await World.create({ checks: 'none' });
  await w.boot();
  const before = await w.fingerprintState();
  const r = await w.pass('build', { skipCheck: true });
  assert.notEqual(r.code, 0, `deveria rejeitar: ${r.out}`);
  assert.match(r.err, /check.*'?build'?.*(ausente|não configurado|missing|exigido)/i);
  await noEffect(w, before);
});

test('R5-03 checks:{} com run posicionado em pr: next pr pass NÃO publica nem avança', async () => {
  const w = await World.create({ checks: 'none' });
  await w.boot();
  await w.seedStage('pr'); // fixture só posiciona a execução; não autoriza o gate testado
  const before = await w.fingerprintState();
  const r = await w.pass('pr', { skipCheck: true });
  assert.notEqual(r.code, 0, `deveria rejeitar: ${r.out}`);
  assert.match(r.err, /build/i);
  await noEffect(w, before);
  assert.equal(w.edges.ghListCalls, 0, 'nenhuma consulta/publicação antes da pré-validação');
});

test('R5-03 config parcial (sem e2e): check e2e falha e next e2e pass é rejeitado', async () => {
  const w = await World.create({ checks: { build: { executable: 'tool', args: ['build'] }, unit: { executable: 'tool', args: ['unit'] } } });
  await w.boot();
  await w.seedStage('e2e');
  const before = await w.fingerprintState();
  const c = await w.check('e2e');
  assert.notEqual(c.code, 0, 'check exigido e ausente nunca é sucesso');
  const r = await w.pass('e2e', { skipCheck: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /e2e/);
  assert.equal((await w.fingerprintState()).stage, 'e2e');
  assert.equal(before.stage, 'e2e');
});

test('R5-03 lint configurado e falhando reprova o estágio (check e gate)', async () => {
  const w = await World.create();
  await w.boot();
  w.edges.toolFailFor.add('lint');
  const c = await w.check('build');
  assert.notEqual(c.code, 0);
  const before = await w.fingerprintState();
  const r = await w.pass('build', { skipCheck: true });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /lint|build/);
  assert.equal((await w.fingerprintState()).stage, before.stage);
});

test('R5-03 dispensa explícita aprovada no manifesto (e2e) permite o estágio; sem ela, não', async () => {
  const checks = { build: { executable: 'tool', args: ['build'] }, lint: { executable: 'tool', args: ['lint'] }, unit: { executable: 'tool', args: ['unit'] } };
  const w = await World.create({ checks, checkExemptions: [{ workflow: 'feature', stage: 'e2e', check: 'e2e', reason: 'projeto sem interface' }] });
  await w.boot();
  await w.seedStage('e2e');
  const c = await w.check('e2e');
  assert.equal(c.code, 0, `dispensa explícita: ${c.err}`);
  assert.ok(JSON.stringify(c.payload).includes('projeto sem interface'), 'motivo da dispensa exposto');
  const r = await w.pass('e2e');
  assert.equal(r.code, 0, r.err);
});

test('R5-03 dispensa inválida (check que o método não exige naquele estágio) rejeita o start', async () => {
  const w = await World.create({ checkExemptions: [{ workflow: 'feature', stage: 'build', check: 'unit', reason: 'x' }] });
  await w.writeApproval();
  await w.up();
  const r = await w.start();
  assert.notEqual(r.code, 0);
  assert.match(r.err, /dispensa|exempt/i);
  assert.equal((await w.state()).runs.length, 0, 'nenhuma execução criada');
});

test('R5-03 hotfix sem check build configurado: next build pass é rejeitado', async () => {
  const w = await World.create({ workflow: 'hotfix', checks: { unit: { executable: 'tool', args: ['unit'] } } });
  await w.boot();
  const before = await w.fingerprintState();
  const r = await w.pass('build', { skipCheck: true });
  assert.notEqual(r.code, 0);
  await noEffect(w, before);
});

test('R5-03 review-only não exige check mecânico: rubrica completa fecha', async () => {
  const w = await World.create({ workflow: 'review-only', checks: 'none' });
  await w.boot();
  const r = await w.pass('review');
  assert.equal(r.code, 0, r.err);
  assert.equal((await w.run()).status, 'done');
});

// ---------- R5-04 (CLI) — snapshot obrigatório e falha fechada ----------

test('R5-04 check com git status falhando NÃO grava pass mecânico', async () => {
  const w = await World.create();
  await w.boot();
  w.edges.gitFail.add('status');
  const c = await w.check('build');
  assert.notEqual(c.code, 0, 'falha de snapshot é falha do check');
  assert.match(c.err + JSON.stringify(c.payload), /snapshot|status/i);
  const passes = (await w.state()).evidence.filter(e => e.result === 'pass');
  assert.equal(passes.length, 0, 'nenhum pass mecânico utilizável');
});

test('R5-04 check com before ok e after falhando não aprova (sem fallback after??before)', async () => {
  const w = await World.create();
  await w.boot();
  // mede quantas chamadas de status uma captura completa faz (build+lint => 2 checks x 2 capturas)
  // e falha exatamente a partir da primeira chamada do "after" do primeiro check.
  await w.check('build');
  const evidenceBefore = (await w.state()).evidence.length;
  const perCapture = (w.edges.gitCalls.status ?? 0) / 4;
  assert.ok(perCapture >= 1, 'medição da captura');
  w.edges.gitFailFrom.status = (w.edges.gitCalls.status ?? 0) + Math.ceil(perCapture) + 1;
  const c = await w.check('build');
  assert.notEqual(c.code, 0);
  const newPass = (await w.state()).evidence.slice(evidenceBefore).filter(e => e.result === 'pass');
  assert.equal(newPass.length, 0, 'before válido + after inválido nunca vira pass');
});

test('R5-04 check com timeout na captura falha fechado', async () => {
  const w = await World.create();
  await w.boot();
  w.edges.gitTimeout.add('diff');
  const c = await w.check('build');
  assert.notEqual(c.code, 0);
  assert.equal((await w.state()).evidence.filter(e => e.result === 'pass').length, 0);
});

test('R5-04 next pr com snapshot indisponível: nenhuma reserva, nenhum gh, estágio preservado', async () => {
  const w = await World.create();
  await w.boot();
  await w.seedStage('pr');
  const c = await w.check('pr');
  assert.equal(c.code, 0, c.err);
  const file = await w.rubric('pr', w.rubricIds('pr'), c.payload.snapshot);
  const before = await w.fingerprintState();
  w.edges.gitFail.add('status');
  const r = await w.next('pr', 'pass', file);
  assert.notEqual(r.code, 0, `deveria falhar fechado: ${r.out}`);
  assert.equal(w.edges.ghCreateCalls, 0);
  assert.equal(w.edges.ghListCalls, 0, 'nenhuma leitura/escrita externa antes do snapshot');
  const after = await w.fingerprintState();
  assert.equal(after.stage, 'pr');
  assert.equal(after.revision, before.revision);
  const s = await w.state();
  assert.ok(!s.events.some(e => e.kind === 'pr-intent-reserved'), 'nenhuma intenção reservada');
});

test('R5-04 falha de snapshot APÓS o efeito: recibo preservado, não avança, reexecução reutiliza a PR', async () => {
  const w = await World.create();
  await w.boot();
  await w.seedStage('pr');
  const c = await w.check('pr');
  const file = await w.rubric('pr', w.rubricIds('pr'), c.payload.snapshot);
  w.edges.gitFailAfterCreate.add('status');
  const r = await w.next('pr', 'pass', file, [], 'op-pr-1');
  assert.notEqual(r.code, 0, `não pode declarar conclusão: ${r.out}`);
  assert.equal(w.edges.ghCreateCalls, 1, 'o efeito ocorreu uma vez');
  assert.equal((await w.run()).stage, 'pr', 'não avançou');
  const intents = (await w.state()).events.filter(e => e.kind.startsWith('pr-intent')).map(e => JSON.parse(e.detail) as { status: string; result?: { url?: string } });
  assert.ok(intents.some(i => i.status === 'executed' && i.result?.url), 'receipt persistido');
  w.edges.gitFailAfterCreate.clear();
  const again = await w.next('pr', 'pass', file, [], 'op-pr-1');
  assert.equal(again.code, 0, again.err);
  assert.equal(w.edges.ghCreateCalls, 1, 'reexecução NÃO cria de novo');
  assert.equal((await w.run()).stage, 'pr-review');
});

// ---------- R5-05 — manifesto pertence à aprovação; proveniência completa ----------

test('R5-05 start sem manifesto no registro de aprovação é rejeitado', async () => {
  const w = await World.create({ omitManifest: true });
  await w.writeApproval();
  await w.up();
  const r = await w.start();
  assert.notEqual(r.code, 0);
  assert.match(r.err, /manifesto/i);
  assert.equal((await w.state()).runs.length, 0);
});

test('R5-05 manifesto apontando OUTRO plano (hash válido daquele arquivo) é rejeitado', async () => {
  const w = await World.create();
  await w.writeApproval();
  const other = '# outro plano\nREQ-1: x\nREQ-2: y\nREQ-3: z\n';
  await writeFile(join(w.root, 'other.md'), other);
  const foreign = JSON.stringify({ schemaVersion: 1, planPath: 'other.md', planHash: sha256(other), entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }] });
  await writeFile(join(w.root, 'requirements.json'), foreign);
  const approval = JSON.parse(await readFile(join(w.root, 'approval.json'), 'utf8')) as Record<string, unknown>;
  approval.requirementsManifestHash = sha256(foreign); // a aprovação cobre ESTE manifesto, mas ele escolhe outro plano
  await writeFile(join(w.root, 'approval.json'), JSON.stringify(approval));
  await w.up();
  const r = await w.start();
  assert.notEqual(r.code, 0);
  assert.match(r.err, /plano/i);
  assert.equal((await w.state()).runs.length, 0);
});

test('R5-05 manifesto diferente do hash registrado na aprovação é rejeitado no start', async () => {
  const w = await World.create();
  await w.writeApproval();
  const m = JSON.parse(await readFile(join(w.root, 'requirements.json'), 'utf8')) as { entries: unknown[] };
  m.entries.push({ id: 'REQ-99', stage: 'any', mandatory: false });
  await writeFile(join(w.root, 'requirements.json'), JSON.stringify(m));
  await w.up();
  const r = await w.start();
  assert.notEqual(r.code, 0);
  assert.match(r.err, /manifesto|hash/i);
});

test('R5-05 manifesto adulterado depois do start: next pass é rejeitado, nada muda', async () => {
  const w = await World.create();
  await w.boot();
  const c = await w.check('build');
  const file = await w.rubric('build', w.rubricIds('build'), c.payload.snapshot);
  const m = JSON.parse(await readFile(join(w.root, 'requirements.json'), 'utf8')) as { entries: Array<Record<string, unknown>> };
  m.entries[0].mandatory = false;
  await writeFile(join(w.root, 'requirements.json'), JSON.stringify(m));
  const before = await w.fingerprintState();
  const r = await w.next('build', 'pass', file);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /manifesto/i);
  await noEffect(w, before);
});

test('R5-05 config alterada no meio do fluxo: next pass é rejeitado', async () => {
  const w = await World.create();
  await w.boot();
  const c = await w.check('build');
  const file = await w.rubric('build', w.rubricIds('build'), c.payload.snapshot);
  const cfgPath = join(w.root, '.sdlc-codex', 'config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
  cfg.checks = {};
  await writeFile(cfgPath, JSON.stringify(cfg));
  const before = await w.fingerprintState();
  const r = await w.next('build', 'pass', file);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /config/i);
  await noEffect(w, before);
});

test('R5-05 requisito fora do plano aprovado (NOT-IN-APPROVED-PLAN) não aprova', async () => {
  const w = await World.create();
  await w.boot();
  const c = await w.check('build');
  const file = await w.rubric('build', ['REQ-1', 'NOT-IN-APPROVED-PLAN'], c.payload.snapshot);
  const before = await w.fingerprintState();
  const r = await w.next('build', 'pass', file);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /NOT-IN-APPROVED-PLAN/);
  await noEffect(w, before);
});

test('R5-05 requisito obrigatório do manifesto sem cobertura não aprova', async () => {
  const w = await World.create({ entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }, { id: 'REQ-2', stage: 'any', mandatory: true }] });
  await w.boot();
  const c = await w.check('build');
  const file = await w.rubric('build', ['REQ-1'], c.payload.snapshot);
  const before = await w.fingerprintState();
  const r = await w.next('build', 'pass', file);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /REQ-2/);
  await noEffect(w, before);
});

for (const omit of ['projectId', 'revision', 'producer', 'snapshot', 'runId', 'logHash'] as const) {
  test(`R5-05 evidência sem ${omit} nunca contorna a validação`, async () => {
    const w = await World.create();
    await w.boot();
    const c = await w.check('build');
    const before = await w.fingerprintState();
    const r = await w.pass('build', { skipCheck: true, snapshot: c.payload.snapshot, omit });
    assert.notEqual(r.code, 0, `omissão de ${omit} aceita indevidamente: ${r.out}`);
    const pattern = ({ projectId: /projectId/, revision: /revis/, producer: /producer|produtor/, snapshot: /snapshot/, runId: /runId/, logHash: /logHash/ })[omit];
    assert.match(r.err, pattern);
    await noEffect(w, before);
  });
}

test('R5-05 log de evidência ausente é rejeitado', async () => {
  const w = await World.create();
  await w.boot();
  const c = await w.check('build');
  const before = await w.fingerprintState();
  const r = await w.pass('build', { skipCheck: true, snapshot: c.payload.snapshot, omit: 'log' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /log/i);
  await noEffect(w, before);
});

test('R5-05 log de check do produto adulterado depois da produção é rejeitado', async () => {
  const w = await World.create();
  await w.boot();
  const c = await w.check('build');
  const checks = c.payload.checks as Array<{ logPath: string }>;
  await writeFile(checks[0].logPath, 'adulterado\n');
  const file = await w.rubric('build', w.rubricIds('build'), c.payload.snapshot);
  const before = await w.fingerprintState();
  const r = await w.next('build', 'pass', file);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /log|hash/i);
  await noEffect(w, before);
});

test('R5-05 fluxo completo positivo: build passa e avança para review', async () => {
  const w = await World.create();
  await w.boot();
  const r = await w.pass('build');
  assert.equal(r.code, 0, r.err);
  assert.equal((await w.run()).stage, 'review');
  const run = await w.run();
  assert.ok(run.approval?.requirementsManifest?.hash, 'run persiste o hash de manifesto aprovado');
  void io; void runCli; void PROJECT_ID;
});
