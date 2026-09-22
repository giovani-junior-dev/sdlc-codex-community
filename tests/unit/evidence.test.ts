import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRuntime, type Evidence, type RequirementVerdict, type Run } from '../../src/contracts.js';
import { validateStageEvidence, hasValidEvidence, validateEvidenceImport, validateRequirementsManifest, validateRequirementVerdict } from '../../src/evidence/report.js';
import { actorFor, CAPTURED_AT, COMMIT, validCheckEvidence, validEvidence, validGate, validManifest, validRun } from './gate-fixtures.js';

// R5: validateStageEvidence exige gate COMPLETO (manifesto, snapshot, logs verificados) e a
// evidência com proveniência completa. Os casos válidos vêm de gate-fixtures; cada caso de
// rejeição altera UM fato.

const run = (): Run => validRun('review', { revision: 4 });
function reviewState(evidence: Evidence[] = []) {
  const state = emptyRuntime('p');
  const r = run();
  state.runs.push(r);
  state.evidence.push(...evidence);
  return { state, r };
}
/** valida um pass de review com gate completo (verifiedLogs = logs das evidências do estado). */
function gateCheck(state: ReturnType<typeof reviewState>['state'], r: Run, ids: string[], expectedCommit: string | undefined = COMMIT, gateOver: Parameters<typeof validGate>[2] = {}) {
  return validateStageEvidence(state, r, 'review', ids, expectedCommit, validGate(r, state.evidence, gateOver));
}

// R05: evidência review-other, antiga, sem verdict e evidenceIds vazio foi aprovada — agora tudo reprova.
test('R05 matriz de rejeição: prefixo semelhante, sem verdict, sem commit, vazio', () => {
  const r = run();
  const good = validEvidence(r, { id: 'e0' });
  const cases: Array<[string, Partial<Evidence>, RegExp]> = [
    ['prefixo semelhante não casa', { requirementId: 'change:review-other:REQ-1' }, /não pertence a change:review/],
    ['sem verdict', { verdict: undefined }, /verdict ausente/],
    ['outra execução', { runId: 'outro-run' }, /outra execução/],
    ['sem commit', { commit: undefined }, /sem commit/],
  ];
  const baseline = reviewState([good]);
  assert.deepEqual(gateCheck(baseline.state, baseline.r, ['e0']).errors, [], 'o caso completo passa (a rejeição vem do fato alterado)');
  for (const [name, mutation, pattern] of cases) {
    const { state, r: rr } = reviewState([validEvidence(r, { id: 'e1', ...mutation })]);
    const out = gateCheck(state, rr, ['e1']);
    assert.equal(out.ok, false, name);
    assert.match(out.errors.join(';'), pattern, name);
  }
  // evidenceIds vazio reprova
  const empty = gateCheck(baseline.state, baseline.r, []);
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(';'), /evidenceIds não vazio/);
});

test('R05 mudança posterior invalida evidência de código (commit obsoleto)', () => {
  const { state, r } = reviewState([validEvidence(run(), { id: 'e' })]);
  assert.equal(gateCheck(state, r, ['e'], 'abc').ok, true);
  const stale = gateCheck(state, r, ['e'], 'def');
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join(';'), /commit abc obsoleto diante de def/);
});

test('R05 evidência de outra etapa não aprova', () => {
  const build = validRun('build', { revision: 4 });
  const { state, r } = reviewState([validEvidence(build, { id: 'e' })]);
  const out = gateCheck(state, r, ['e']);
  assert.equal(out.ok, false);
  assert.match(out.errors.join(';'), /vinculada a outra etapa \(build\)/);
  assert.match(out.errors.join(';'), /não pertence a change:review/);
});

test('legado estrito hasValidEvidence exige verdict e commit', () => {
  const state = emptyRuntime('p');
  state.evidence.push({ id: 'e', requirementId: 's:build:r', result: 'pass', procedure: 'x', timestamp: '', commit: 'c', verdict: 'pass' });
  assert.equal(hasValidEvidence(state, 's', 'build'), false); // timestamp inválido agora reprova
  state.evidence[0].timestamp = new Date().toISOString();
  assert.equal(hasValidEvidence(state, 's', 'build'), true);
});

// ---------- C09 — política única: campos exigidos e rubrica por tipo de estágio ----------

// R5-05: antes só logPath/runId/stage eram exigidos; agora a proveniência é completa e a
// omissão de QUALQUER fato reprova, sem defaults permissivos.
test('C09: evidência sem logPath, runId, stage, projectId, revisão, producer, log verificado ou snapshot é inválida para pass', () => {
  const r = run();
  const cases: Array<[string, Partial<Evidence>, RegExp]> = [
    ['sem logPath', { logPath: undefined }, /logPath/],
    ['sem runId', { runId: undefined }, /sem runId/],
    ['sem stage', { stage: undefined }, /sem stage/],
    ['sem projectId', { projectId: undefined }, /sem projectId/],
    ['projectId de outro projeto', { projectId: 'outro' }, /outro projeto/],
    ['sem revisão', { revision: undefined }, /sem revisão/],
    ['revisão obsoleta', { revision: 3 }, /revisão 3 obsoleta/],
    ['sem producer', { producer: undefined }, /sem producer/],
    ['producer que não é o proprietário do estágio', { producer: { role: 'dev', threadId: 't-dev', generationId: 'g-dev' } }, /não é o proprietário/],
    ['sem logHash', { logHash: undefined }, /logHash sha256 obrigatório/],
    ['logHash não é sha256', { logHash: 'xyz' }, /logHash sha256 obrigatório/],
    ['sem codeSnapshot', { codeSnapshot: undefined }, /sem codeSnapshot/],
    ['snapshot de outra árvore', { codeSnapshot: { commit: COMMIT, diffFingerprint: 'fp-outro', capturedAt: CAPTURED_AT, source: 'git-readonly' } }, /árvore alterada/],
  ];
  for (const [name, mutation, pattern] of cases) {
    const { state, r: rr } = reviewState([validEvidence(r, { id: 'e', ...mutation })]);
    const out = gateCheck(state, rr, ['e']);
    assert.equal(out.ok, false, name);
    assert.match(out.errors.join(';'), pattern, name);
  }
  // log com hash mas NÃO verificado em disco pelo chamador (ausente/adulterado)
  const { state, r: rr } = reviewState([validEvidence(r, { id: 'e' })]);
  const unverified = gateCheck(state, rr, ['e'], COMMIT, { verifiedLogs: [] });
  assert.equal(unverified.ok, false);
  assert.match(unverified.errors.join(';'), /log não verificado em disco/);
});

test('C09: rubrica incompleta reprova — review sem file/line e e2e sem cenário', () => {
  for (const [name, mutation] of [['sem file nem line', { file: undefined, line: undefined }], ['sem file', { file: undefined }], ['sem line', { line: undefined }]] as const) {
    const { state, r } = reviewState([validEvidence(run(), { id: 'e1', ...mutation })]);
    const out = gateCheck(state, r, ['e1']);
    assert.equal(out.ok, false, name);
    assert.match(out.errors.join(';'), /file\/line/, name);
  }
  const r2 = validRun('e2e', { revision: 4 });
  const state = emptyRuntime('p');
  state.runs.push(r2);
  state.evidence.push(validEvidence(r2, { id: 'e2', procedure: '  ' }));
  const noScenario = validateStageEvidence(state, r2, 'e2e', ['e2'], COMMIT, validGate(r2, state.evidence));
  assert.equal(noScenario.ok, false);
  assert.match(noScenario.errors.join(';'), /cenário/);
  // o mesmo caso com procedure preenchido passa: o fato omitido era o único
  state.evidence.push(validEvidence(r2, { id: 'e3' }));
  assert.deepEqual(validateStageEvidence(state, r2, 'e2e', ['e3'], COMMIT, validGate(r2, state.evidence)).errors, []);
});

test('C09: evidência acumula entre tentativas (validação seleciona por ID, sem sobrescrever)', () => {
  const r = run();
  const { state } = reviewState([
    validEvidence(r, { id: 'antiga', result: 'fail', verdict: 'fail', procedure: 'tentativa 1', logPath: 'logs/t1.log' }),
    validEvidence(r, { id: 'nova', procedure: 'tentativa 2', logPath: 'logs/t2.log' }),
  ]);
  // a tentativa antiga continua registrada (auditoria) e não é selecionável como pass
  assert.equal(state.evidence.length, 2);
  const antiga = gateCheck(state, r, ['antiga']);
  assert.equal(antiga.ok, false);
  assert.match(antiga.errors.join(';'), /result fail não aprova/);
  assert.equal(gateCheck(state, r, ['nova']).ok, true);
});

test('C09: matriz de checks alinhada ao que cmdCheck executa por estágio', async () => {
  const { getRequiredChecks } = await import('../../src/pipeline/workflows.js');
  assert.deepEqual(getRequiredChecks('feature', 'review'), ['unit']); // cmdCheck executa 'unit' em review
  assert.deepEqual(getRequiredChecks('feature', 'e2e'), ['e2e']); // sem exigência duplicada de build
  assert.deepEqual(getRequiredChecks('feature', 'pr'), ['build']);
  assert.deepEqual(getRequiredChecks('feature', 'pr-review'), ['unit']);
  assert.deepEqual(getRequiredChecks('hotfix', 'pr-review'), ['unit']);
  assert.deepEqual(getRequiredChecks('review-only', 'review'), []); // rubrica de revisão, sem check mecânico
});

// ---------- C09 — runCheck produz evidência executada (sem fabricação) ----------

test('C09: runCheck executa comando, grava log e classifica aprovado/falho/ausente', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const { runCheck } = await import('../../src/evidence/checks.js');
  const { FakeProcessRunner } = await import('../../src/adapters/process.js');
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-c-check-'));
  const runner = new FakeProcessRunner((_, args) => args.includes('falha')
    ? { exitCode: 2, stdout: 's', stderr: 'erro', timedOut: false, acceptedBeforeTimeout: false }
    : { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, acceptedBeforeTimeout: false });
  const ok = await runCheck('build', { executable: 'tool', args: ['ok'] }, runner, dir, join(dir, 'ev'));
  assert.equal(ok.status, 'approved');
  assert.match(await readFile(ok.logPath, 'utf8'), /exitCode: 0/);
  const failed = await runCheck('unit', { executable: 'tool', args: ['falha'] }, runner, dir, join(dir, 'ev'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 2);
  const missing = await runCheck('e2e', undefined, runner, dir, join(dir, 'ev'));
  assert.equal(missing.status, 'missing');
  assert.equal(runner.calls.length, 2, 'check não configurado não executa processo');
});

// ---------- M4-F1 — importação: proveniência imutável, um campo por vez ----------

/** manifesto sem requisito obrigatório: isola o fato testado quando só há evidência de check. */
const optionalManifest = () => validManifest({ entries: [{ id: 'REQ-1', stage: 'any', mandatory: false }] });

/** Rubrica humana de review com proveniência completa, como o `next` a receberia para importar. */
function importBase(): Evidence {
  return validEvidence(run(), { id: 'imp-1', procedure: 'rubrica humana de revisão' });
}
// R5-05: o contexto de importação exige o ATOR (produtor = a sessão que executa o next).
function importCtx() {
  const { role, threadId, generationId } = actorFor('reviewer');
  return { run: run(), stage: 'review' as const, projectId: 'p', productChecks: ['unit', 'lint'], actor: { role, threadId, generationId } };
}

test('M4-F1: importação válida passa na validação pura', () => {
  assert.deepEqual(validateEvidenceImport(importBase(), importCtx()), []);
});

test('M4-F1: evidência estrangeira — um campo divergente por vez reprova', () => {
  const cases: Array<[string, Partial<Evidence>, RegExp]> = [
    ['runId de outra execução', { runId: 'outro-run' }, /outra execução/],
    ['runId ausente', { runId: undefined }, /sem runId/],
    ['stage divergente', { stage: 'build' }, /diverge de review/],
    ['stage ausente', { stage: undefined }, /sem stage/],
    ['projectId divergente', { projectId: 'outro' }, /projectId/],
    ['requirementId fora do prefixo', { requirementId: 'change:review-other:REQ-1' }, /requirementId/],
    ['requirementId só prefixo', { requirementId: 'change:review:' }, /requirementId/],
    ['procedure vazio', { procedure: '  ' }, /procedure/],
    ['timestamp ausente', { timestamp: undefined }, /timestamp/],
    ['timestamp inválido', { timestamp: 'data-errada' }, /timestamp/],
    ['revisão errada', { revision: 2 }, /revisão/],
    ['logPath ausente', { logPath: undefined }, /logPath/],
    ['logHash ausente', { logHash: undefined }, /logHash/],
    ['logHash não é sha256', { logHash: 'xyz' }, /logHash/],
    ['check executado pelo produto', { check: 'unit', exitCode: 0 }, /executado pelo produto/],
    ['proveniência legacy', { provenance: 'legacy' }, /legacy/],
    ['pass sem verdict humano', { verdict: undefined }, /rubrica humana/],
    // R5-05: a importação nunca preenche o que falta — cada omissão de proveniência é recusada.
    ['projectId ausente', { projectId: undefined }, /sem projectId/],
    ['revisão ausente', { revision: undefined }, /sem revisão/],
    ['producer ausente', { producer: undefined }, /sem producer/],
    ['producer de outra sessão (papel)', { producer: { role: 'dev', threadId: 't-reviewer', generationId: 'g-reviewer' } }, /producer diverge/],
    ['producer de outra sessão (thread)', { producer: { role: 'reviewer', threadId: 't-outra', generationId: 'g-reviewer' } }, /producer diverge/],
    ['producer de outra geração', { producer: { role: 'reviewer', threadId: 't-reviewer', generationId: 'g-antiga' } }, /producer diverge/],
    ['commit ausente', { commit: undefined }, /sem commit/],
    ['codeSnapshot ausente', { codeSnapshot: undefined }, /sem codeSnapshot completo/],
    ['codeSnapshot sem diffFingerprint', { codeSnapshot: { commit: COMMIT, diffFingerprint: '', capturedAt: CAPTURED_AT, source: 'git-readonly' } }, /sem codeSnapshot completo/],
    ['commit diverge do commit do codeSnapshot', { commit: 'outro' }, /commit da evidência diverge do commit do codeSnapshot/],
  ];
  for (const [name, mutation, pattern] of cases) {
    const e = { ...importBase(), ...mutation } as Evidence;
    const errors = validateEvidenceImport(e, importCtx());
    assert.ok(errors.length > 0, `${name} deve reprovar`);
    assert.match(errors.join(';'), pattern, `${name}: mensagem esperada`);
  }
});

// ---------- M4-F1 — gate: legado e importada nunca satisfazem requisito ----------

test('M4-F1: proveniência legacy não satisfaz gate (nem importada nem migrada)', () => {
  const { state, r } = reviewState([validEvidence(run(), { id: 'leg', provenance: 'legacy' })]);
  const out = gateCheck(state, r, ['leg']);
  assert.equal(out.ok, false);
  assert.match(out.errors.join(';'), /legacy/);
  assert.equal(out.errors.length, 1, 'legacy é o único fato reprovado');
});

test('M4-F1: evidência importada não satisfaz check que o produto executa', () => {
  const r = run();
  // check-unit importada COM producer (proveniência completa): o único fato reprovado é ter sido importada.
  const imported = validCheckEvidence(r, 'unit', {
    id: 'impchk', imported: true, importedAt: '2026-09-19T03:00:00Z',
    producer: { role: 'reviewer', threadId: 't-reviewer', generationId: 'g-reviewer' },
    file: 'src/a.ts', line: 1,
  });
  const { state } = reviewState([imported]);
  const out = gateCheck(state, r, ['impchk'], COMMIT, { manifest: optionalManifest() });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(';'), /importada não satisfaz check/);
  assert.equal(out.errors.length, 1, 'importação é o único fato reprovado');
  // o mesmo check produzido pelo produto (não importado) passa
  const produced = validCheckEvidence(r, 'unit', { id: 'prod', file: 'src/a.ts', line: 1 });
  const ok = reviewState([produced]);
  assert.deepEqual(gateCheck(ok.state, ok.r, ['prod'], COMMIT, { manifest: optionalManifest() }).errors, []);
});

test('M4-F1: rubrica humana (RequirementVerdict) exige evidência referenciada existente', () => {
  const { state } = reviewState([importBase()]);
  const valid: RequirementVerdict = {
    requirementId: 'REQ-1', verdict: 'pass', reviewer: { role: 'reviewer', threadId: 't', generationId: 'g' },
    assessedAt: '2026-09-19T03:00:00Z', evidenceRefs: ['imp-1'],
  };
  assert.deepEqual(validateRequirementVerdict(valid, state), []);
  assert.match(validateRequirementVerdict({ ...valid, evidenceRefs: ['nope'] }, state).join(';'), /não existe/);
  assert.match(validateRequirementVerdict({ ...valid, evidenceRefs: [] }, state).join(';'), /evidenceRefs/);
  assert.match(validateRequirementVerdict({ ...valid, reviewer: { role: 'reviewer', threadId: '', generationId: 'g' } }, state).join(';'), /identidade/);
  assert.match(validateRequirementVerdict({ ...valid, verdict: 'maybe' as never }, state).join(';'), /pass\|fail/);
});

// ---------- M4-F3 — manifesto aprovado e obsolescência por alteração ----------

function manifest() {
  return validManifest({
    entries: [
      { id: 'REQ-1', stage: 'any', mandatory: true },
      { id: 'REQ-2', stage: 'review', mandatory: true },
      { id: 'REQ-3', stage: 'build', mandatory: false },
    ],
  });
}

test('M4-F3: gate valida IDs contra o manifesto aprovado (nunca sufixo arbitrário)', () => {
  const r = run();
  const req = (n: string, over: Partial<Evidence> = {}) => validEvidence(r, { id: `imp-${n}`, requirementId: `change:review:REQ-${n}`, ...over });
  const { state } = reviewState([req('1'), req('2')]);
  const gate = { manifest: manifest() };
  // REQ-1 (any) + REQ-2 (review, obrigatório) cobertos => ok
  assert.equal(gateCheck(state, r, ['imp-1', 'imp-2'], COMMIT, gate).ok, true);
  // requisito fora do plano reprova
  state.evidence.push(req('9'));
  const unknown = gateCheck(state, r, ['imp-1', 'imp-2', 'imp-9'], COMMIT, gate);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(';'), /fora do plano aprovado/);
  // cobertura incompleta: REQ-2 obrigatório ausente
  const incomplete = gateCheck(state, r, ['imp-1'], COMMIT, gate);
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.errors.join(';'), /REQ-2 sem cobertura/);
  // requisito de outra etapa não é aplicável aqui
  state.evidence.push(req('3'));
  const wrongStage = gateCheck(state, r, ['imp-1', 'imp-3'], COMMIT, gate);
  assert.equal(wrongStage.ok, false);
  assert.match(wrongStage.errors.join(';'), /não é aplicável à etapa review/);
});

// R5-05/M3-F2: duplicado NUNCA é aceito, mesmo idêntico (antes só o contraditório era inválido).
test('M4-F3: manifesto com IDs duplicados (contraditórios OU idênticos) ou vazio é inválido', () => {
  const contradictory = manifest();
  contradictory.entries.push({ id: 'REQ-1', stage: 'any', mandatory: false }); // contradiz mandatory:true
  assert.match(validateRequirementsManifest(contradictory).join(';'), /id REQ-1 duplicado/);
  const identical = manifest();
  identical.entries.push({ id: 'REQ-1', stage: 'any', mandatory: true });
  assert.match(validateRequirementsManifest(identical).join(';'), /id REQ-1 duplicado/, 'duplicado idêntico também é inválido');
  assert.match(validateRequirementsManifest({ ...manifest(), entries: [] }).join(';'), /entries vazio/);
  assert.deepEqual(validateRequirementsManifest(manifest()), []);
  assert.match(validateRequirementsManifest({ ...manifest(), planHash: 'não-hex' }).join(';'), /planHash/);
  assert.match(validateRequirementsManifest({ ...manifest(), entries: [{ id: 'REQ-1', stage: 'semente' as never, mandatory: true }] }).join(';'), /stage inválido/);
});

test('M4-F3: árvore alterada após a evidência invalida o gate (HEAD igual, diff diferente)', () => {
  const r = run();
  const snap = { commit: COMMIT, diffFingerprint: 'fp-antigo', capturedAt: CAPTURED_AT, source: 'git-readonly' as const };
  const { state } = reviewState([validEvidence(r, { id: 'imp-1', codeSnapshot: snap })]);
  const stale = gateCheck(state, r, ['imp-1'], COMMIT, { currentSnapshot: { commit: COMMIT, diffFingerprint: 'fp-atual' } });
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join(';'), /árvore alterada/);
  // snapshot atual igual => ok
  assert.equal(gateCheck(state, r, ['imp-1'], COMMIT, { currentSnapshot: { commit: COMMIT, diffFingerprint: 'fp-antigo' } }).ok, true);
  // check produzido pelo produto exige snapshot verificado (evidência sem codeSnapshot reprova)
  const noSnap = reviewState([validCheckEvidence(r, 'unit', { id: 'chk', codeSnapshot: undefined, file: 'src/a.ts', line: 1 })]);
  const out = gateCheck(noSnap.state, noSnap.r, ['chk']);
  assert.equal(out.ok, false);
  assert.match(out.errors.join(';'), /sem codeSnapshot \(snapshot verificado obrigatório\)/);
});

// R5-03/R5-05: pass sem gate ou com gate incompleto não valida NADA (antes o gate era opcional).
test('R5-05: validateStageEvidence com gate ausente ou incompleto reprova mesmo com evidência perfeita', () => {
  const r = run();
  const { state } = reviewState([validEvidence(r, { id: 'e' })]);
  const absent = validateStageEvidence(state, r, 'review', ['e'], COMMIT, undefined as never);
  assert.equal(absent.ok, false);
  assert.match(absent.errors.join(';'), /contexto de gate ausente/);
  const full = validGate(r, state.evidence);
  for (const key of ['manifest', 'manifestHash', 'currentSnapshot', 'currentCodeSnapshot', 'checks', 'verifiedLogs'] as const) {
    const partial = { ...full } as Record<string, unknown>;
    delete partial[key];
    const out = validateStageEvidence(state, r, 'review', ['e'], COMMIT, partial as never);
    assert.equal(out.ok, false, `gate sem ${key}`);
    assert.deepEqual(out.evidence, [], 'nenhuma evidência é avaliada com gate incompleto');
  }
});
