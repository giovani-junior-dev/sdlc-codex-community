import test from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence, Run, Stage, Workflow } from '../../src/contracts.js';
import { applyCompletion } from '../../src/pipeline/engine.js';
import type { EvidenceGateContext } from '../../src/evidence/report.js';
import { assertRejectedNoEffect, scenario, validManifest, type Scenario, type ScenarioOptions } from './gate-fixtures.js';

// R5-03/R5-05 — gate do motor (applyCompletion) com contexto COMPLETO. O caso de sucesso vem de
// gate-fixtures; cada teste de rejeição remove/altera UM fato e afirma: mensagem específica,
// estágio/revisão preservados, nenhuma evidência/task/entrega criada.

const run = (sc: Scenario) => applyCompletion(sc.state, sc.op, sc.gate);
function reject(opts: ScenarioOptions, stage: Stage, expected: RegExp, label: string): void {
  const sc = scenario(stage, opts);
  assertRejectedNoEffect(sc.state, run(sc), expected, label);
}

// Controle positivo: sem ele, as rejeições abaixo poderiam vir de um fixture inválido.
test('R5: o caso completo é aceito em cada estágio de cada workflow (base de todas as rejeições)', () => {
  const cases: Array<[Workflow, Stage]> = [
    ['feature', 'build'], ['feature', 'review'], ['feature', 'e2e'], ['feature', 'pr'], ['feature', 'pr-review'], ['feature', 'document'],
    ['hotfix', 'build'], ['hotfix', 'review'], ['hotfix', 'pr'], ['hotfix', 'pr-review'], ['review-only', 'review'],
  ];
  for (const [workflow, stage] of cases) {
    const sc = scenario(stage, { run: { workflow } });
    const out = run(sc);
    assert.equal(out.result.accepted, true, `${workflow}/${stage}: ${out.result.error}`);
  }
});

test('M4-F1: evidência importada não satisfaz check que o produto executa', () => {
  reject({ checkEvidence: { imported: true, importedAt: '2026-09-19T03:00:00Z' } }, 'build', /check obrigatório 'build' não passou/, 'check importado');
});

test('M4-F1: evidência de proveniência legacy não satisfaz gate de requisito obrigatório', () => {
  reject({ rubric: { provenance: 'legacy' } }, 'build', /legacy/, 'rubrica legacy');
  // check 'legacy' (migrado da v1) tampouco vale como evidência do produto
  reject({ checkEvidence: { provenance: 'legacy' } }, 'build', /check obrigatório 'build' não passou/, 'check legacy');
});

test('M4-F3: check aprovado mas com snapshot obsoleto (árvore alterada após revisão) não passa o gate', () => {
  // diff diferente com HEAD igual: a árvore atual mudou depois do check
  reject({ gate: { currentSnapshot: { commit: 'abc', diffFingerprint: 'fp-DIFERENTE' } } }, 'build', /check obrigatório 'build' não passou/, 'diffFingerprint');
  // commit diferente
  reject({ gate: { currentSnapshot: { commit: 'outro-head', diffFingerprint: 'fp-full-1' } } }, 'build', /check obrigatório 'build' não passou/, 'commit');
  // evidência sem snapshot (R5-05: snapshot verificado é obrigatório)
  reject({ checkEvidence: { codeSnapshot: undefined } }, 'build', /check obrigatório 'build' não passou/, 'check sem snapshot');
});

test('M4-F3: rubrica com snapshot coerente e manifesto coberto avança; manifesto com obrigatório sem cobertura reprova', () => {
  const manifest = validManifest({
    entries: [
      { id: 'REQ-1', stage: 'any', mandatory: true },
      { id: 'REQ-2', stage: 'build', mandatory: true },
    ],
  });
  const good = scenario('build', { manifest, moreRubrics: [{ requirementId: 'change:build:REQ-2' }] });
  assert.equal(run(good).result.accepted, true);
  // REQ-2 obrigatório sem cobertura
  reject({ manifest }, 'build', /REQ-2 sem cobertura/, 'obrigatório sem cobertura');
  // id fora do manifesto
  reject({ manifest, moreRubrics: [{ requirementId: 'change:build:REQ-2' }, { requirementId: 'change:build:REQ-9' }] }, 'build', /fora do plano aprovado/, 'fora do manifesto');
});

// R5-03: a seleção de checks agora é COMPLETA (required + missing + exempt) e vem do chamador.
test('M4-F2: checks config-aware — lint exigido pede evidência de lint (required do gate)', () => {
  const lintRequired = { checks: { required: ['build', 'lint'], missing: [], exempt: [] } };
  // sem evidência de lint: reprova
  reject({ gate: lintRequired }, 'build', /check obrigatório 'lint' não passou/, 'lint sem evidência');
  // com evidência de lint produzida pelo produto: passa
  assert.equal(run(scenario('build', { gate: lintRequired, moreChecks: ['lint'] })).result.accepted, true);
  // sem lint na seleção: passa como antes (o gate não inventa exigência)
  assert.equal(run(scenario('build')).result.accepted, true);
});

// ---------- R5-03/R5-05: o que o gate opcional antigo permitia e agora reprova ----------

test('R5-05: pass com gate ausente ou incompleto é rejeitado (antes: gate opcional preservava o modo legado)', () => {
  const sc = scenario('build');
  assertRejectedNoEffect(sc.state, applyCompletion(sc.state, sc.op, undefined), /contexto de gate incompleto/, 'gate ausente');
  for (const key of ['manifest', 'manifestHash', 'currentSnapshot', 'currentCodeSnapshot', 'checks', 'verifiedLogs'] as const) {
    const partial = { ...sc.gate } as Partial<EvidenceGateContext>;
    delete partial[key];
    assertRejectedNoEffect(sc.state, applyCompletion(sc.state, sc.op, partial as EvidenceGateContext), /contexto de gate incompleto/, `sem ${key}`);
  }
  // seleção parcial de checks (só required) também é proibida
  const onlyRequired = { ...sc.gate, checks: { required: ['build'] } } as unknown as EvidenceGateContext;
  assertRejectedNoEffect(sc.state, applyCompletion(sc.state, sc.op, onlyRequired), /seleção completa de checks/, 'só required');
});

test('R5-05: manifesto do gate inválido (duplicado, vazio) ou de outro hash que o aprovado é rejeitado', () => {
  reject({ manifest: validManifest({ entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }, { id: 'REQ-1', stage: 'any', mandatory: true }] }) }, 'build', /duplicado/, 'ID duplicado idêntico');
  reject({ manifest: validManifest({ entries: [] }) }, 'build', /entries vazio/, 'manifesto vazio');
  reject({ gate: { manifestHash: 'e'.repeat(64) } }, 'build', /hash divergente/, 'manifesto trocado após a aprovação');
  reject({ gate: { manifestHash: 'não-é-sha256' } }, 'build', /hash verificado do manifesto/, 'hash malformado');
});

test('R5-05: run sem manifesto coberto pela aprovação (legado) não passa gate moderno', () => {
  const legacyApproval = (run: Run) => ({ ...run.approval!, requirementsManifest: undefined });
  const sc = scenario('build');
  const legacy = { ...sc.state, runs: [{ ...sc.run, approval: legacyApproval(sc.run) }] };
  assertRejectedNoEffect(legacy, applyCompletion(legacy, sc.op, sc.gate), /run legado/, 'aprovação sem manifesto');
  const noApproval = { ...sc.state, runs: [{ ...sc.run, approval: undefined }] };
  assertRejectedNoEffect(noApproval, applyCompletion(noApproval, sc.op, sc.gate), /run legado/, 'sem aprovação');
});

test('R5-03: check exigido ausente da configuração (checks.missing) reprova mesmo com o restante perfeito', () => {
  reject({ gate: { checks: { required: [], missing: ['build'], exempt: [] } }, checkEvidence: null }, 'build', /'build'.*ausente.*sem dispensa explícita/, 'missing');
  // dispensa explícita aprovada é a única saída: o check dispensado não exige evidência
  // a dispensa só vale se CONSTA no manifesto aprovado (revisão B/B2: o motor não confia na mentira do chamador)
  const approvedExemption = [{ workflow: 'feature' as const, stage: 'e2e' as const, check: 'e2e', reason: 'projeto sem interface' }];
  const exempt = scenario('e2e', { checkEvidence: null, manifest: validManifest({ checkExemptions: approvedExemption }), gate: { checks: { required: [], missing: [], exempt: [{ check: 'e2e', reason: 'projeto sem interface' }] } } });
  assert.equal(run(exempt).result.accepted, true, 'dispensa explícita aprovada libera o check dispensado');
});

test('R5-05: cada fato de proveniência da rubrica removido reprova, com o gate e o resto perfeitos', () => {
  const cases: Array<[string, Partial<Evidence>, RegExp]> = [
    ['sem projectId', { projectId: undefined }, /sem projectId/],
    ['projectId de outro projeto', { projectId: 'outro' }, /outro projeto/],
    ['sem runId', { runId: undefined }, /sem runId/],
    ['sem stage', { stage: undefined }, /sem stage/],
    ['sem revisão', { revision: undefined }, /sem revisão/],
    ['revisão obsoleta', { revision: 0 }, /revisão 0 obsoleta/],
    ['sem producer', { producer: undefined }, /sem producer/],
    ['producer não proprietário do estágio', { producer: { role: 'reviewer', threadId: 't-reviewer', generationId: 'g-reviewer' } }, /não é o proprietário/],
    ['sem logPath', { logPath: undefined }, /logPath/],
    ['sem logHash', { logHash: undefined }, /logHash sha256 obrigatório/],
    ['sem commit', { commit: undefined }, /sem commit/],
    ['commit obsoleto', { commit: 'antigo', codeSnapshot: { commit: 'antigo', diffFingerprint: 'fp-full-1', capturedAt: '2026-09-19T02:00:00Z', source: 'git-readonly' } }, /obsoleto/],
    ['sem codeSnapshot', { codeSnapshot: undefined }, /sem codeSnapshot/],
    ['snapshot de outra árvore', { codeSnapshot: { commit: 'abc', diffFingerprint: 'fp-outra', capturedAt: '2026-09-19T02:00:00Z', source: 'git-readonly' } }, /árvore alterada/],
    ['result pending', { result: 'pending' }, /result pending não aprova/],
    ['verdict fail', { verdict: 'fail' }, /verdict/],
  ];
  for (const [name, mutation, pattern] of cases) reject({ rubric: mutation }, 'build', pattern, name);
});

test('R5-05: cada fato do check mecânico removido reprova (o produto exige evidência da revisão atual)', () => {
  const cases: Array<[string, Partial<Evidence>]> = [
    ['sem projectId', { projectId: undefined }],
    ['revisão de outra tentativa', { revision: 0 }],
    ['sem revisão', { revision: undefined }],
    ['de outra execução', { runId: 'outra' }],
    ['de outra etapa', { stage: 'review' }],
    ['sem logHash', { logHash: undefined }],
    ['reprovado', { result: 'fail', verdict: 'fail', exitCode: 1 }],
    ['sem commit', { commit: undefined }],
    ['commit divergente do esperado', { commit: 'outro', codeSnapshot: { commit: 'abc', diffFingerprint: 'fp-full-1', capturedAt: '2026-09-19T02:00:00Z', source: 'git-readonly' } }],
  ];
  for (const [name, mutation] of cases) reject({ checkEvidence: mutation }, 'build', /check obrigatório 'build' não passou/, name);
  // check inexistente no estado (nunca virou pass por omissão)
  reject({ checkEvidence: null }, 'build', /check obrigatório 'build' não passou/, 'sem evidência de check');
});

test('R5-05: log não verificado em disco (ausente/adulterado) reprova rubrica e check', () => {
  const sc = scenario('build');
  const onlyCheck = { verifiedLogs: [sc.checks[0].id] };
  assertRejectedNoEffect(sc.state, applyCompletion(sc.state, sc.op, { ...sc.gate, ...onlyCheck }), /log não verificado em disco/, 'rubrica sem log verificado');
  const onlyRubric = { verifiedLogs: [sc.rubric.id] };
  assertRejectedNoEffect(sc.state, applyCompletion(sc.state, sc.op, { ...sc.gate, ...onlyRubric }), /check obrigatório 'build' não passou/, 'check sem log verificado');
});

test('R5-05: rubrica de review sem file/line, e2e sem procedimento e pass só com checks reprovam', () => {
  reject({ rubric: { file: undefined, line: undefined } }, 'review', /file\/line/, 'review sem file/line');
  reject({ rubric: { procedure: ' ' } }, 'e2e', /cenário/, 'e2e sem procedimento');
  // pass só com evidência de check (op só referencia o check): a rubrica obrigatória do manifesto falta
  const sc = scenario('build');
  const onlyCheck = { ...sc.op, evidenceIds: [sc.checks[0].id] };
  assertRejectedNoEffect(sc.state, applyCompletion(sc.state, onlyCheck, sc.gate), /REQ-1 sem cobertura/, 'só check, manifesto obrigatório');
});
