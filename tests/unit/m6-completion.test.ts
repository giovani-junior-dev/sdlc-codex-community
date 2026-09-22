import test from 'node:test';
import assert from 'node:assert/strict';
import type { CodeSnapshot } from '../../src/contracts.js';
import { applyCompletion, validateCompletion } from '../../src/pipeline/engine.js';
import { assertRejectedNoEffect, CAPTURED_AT, scenario, validObservation, validPrRef, type Scenario, type ScenarioOptions } from './gate-fixtures.js';

/** Mensagem de rejeição do dry-run e da aplicação real (mesma pré-validação, R4-04). */
function assertSameRejection(sc: Scenario, expected: RegExp, label: string): void {
  const dry = validateCompletion(sc.state, sc.op, sc.gate);
  assert.equal(dry.ok, false, `dry-run deve rejeitar [${label}]`);
  const applied = applyCompletion(sc.state, sc.op, sc.gate);
  assertRejectedNoEffect(sc.state, applied, expected, label);
  assert.equal(applied.result.error, dry.ok ? '' : dry.error, `mensagens coincidem [${label}]`);
}

// M6-F2 — a pré-validação pura espelha a aplicação real SEM exigir a PR (dry-run pré-efeito).
test('validateCompletion é equivalente à aplicação, exceto a referência de PR do estágio pr', () => {
  const sc = scenario('pr', { op: { pullRequest: undefined } });
  // Dry-run: aceita o que a aplicação aceitaria com PR válida, sem nenhuma referência.
  assert.deepEqual(validateCompletion(sc.state, sc.op, sc.gate), { ok: true });
  // Aplicação sem PR é recusada; com PR válida aceita.
  assertRejectedNoEffect(sc.state, applyCompletion(sc.state, sc.op, sc.gate), /pullRequest/, 'aplicação sem PR');
  assert.equal(applyCompletion(sc.state, { ...sc.op, pullRequest: validPrRef() }, sc.gate).result.accepted, true);
  // Mensagens de rejeição coincidem entre dry-run e aplicação.
  assertSameRejection(scenario('pr', { op: { expectedRevision: 99, pullRequest: undefined } }), /estágio ou revisão divergente/, 'revisão errada');
  assertSameRejection(scenario('build', { op: { actor: { role: 'reviewer', threadId: 't-reviewer', generationId: 'g-reviewer', projectId: 'p' } } }), /papel não é proprietário/, 'papel errado');
  // R5-05: a pré-validação exige o MESMO gate completo — gate incompleto reprova igual antes do efeito externo.
  assertSameRejection(scenario('pr', { op: { pullRequest: undefined }, gate: { manifestHash: 'e'.repeat(64) } }), /hash divergente/, 'manifesto trocado');
  assertSameRejection(scenario('pr', { op: { pullRequest: undefined }, gate: { checks: { required: [], missing: ['build'], exempt: [] } }, checkEvidence: null }), /ausente\(s\)/, 'check ausente da config');
  const noGate = scenario('pr', { op: { pullRequest: undefined } });
  const dryNoGate = validateCompletion(noGate.state, noGate.op, undefined);
  assert.equal(dryNoGate.ok, false);
  assert.match(dryNoGate.ok ? '' : dryNoGate.error, /contexto de gate incompleto/);
  assert.equal(applyCompletion(noGate.state, noGate.op, undefined).result.error, dryNoGate.ok ? '' : dryNoGate.error);
});

// M6-F1 — payloadHash semântico gravado no resultado (aceito e recusado).
test('applyCompletion grava payloadHash do pedido no OperationResult', () => {
  const sc = scenario('build');
  const accepted = applyCompletion(sc.state, sc.op, sc.gate, { payloadHash: 'f'.repeat(64) });
  assert.equal(accepted.result.accepted, true);
  assert.equal(accepted.result.payloadHash, 'f'.repeat(64));
  const wrongOwner = scenario('build', { op: { actor: { role: 'reviewer', threadId: 't-reviewer', generationId: 'g-reviewer', projectId: 'p' } } });
  const rejected = applyCompletion(wrongOwner.state, wrongOwner.op, wrongOwner.gate, { payloadHash: 'e'.repeat(64) });
  assert.equal(rejected.result.accepted, false);
  assert.equal(rejected.result.payloadHash, 'e'.repeat(64));
  // R5: rejeição por gate ausente também registra o payloadHash (replay seguro)
  const gateless = applyCompletion(sc.state, { ...sc.op, operationId: 'op-sem-gate' }, undefined, { payloadHash: 'd'.repeat(64) });
  assert.equal(gateless.result.accepted, false);
  assert.equal(gateless.result.payloadHash, 'd'.repeat(64));
});

// M6-F3 (R4-06)/R5-07 — fechamento vinculado ao que a revisão independente APROVOU. O vínculo
// antigo comparava run.pullRequest.commit com o commit atual; a R5-07 compara o CÓDIGO atual com o
// snapshot aprovado em pr-review (HEAD igual/diferente sozinho não prova nada) e a PR observada agora.
const OLD = 'old';
const NEW = 'new';
const newTree: CodeSnapshot = { commit: NEW, diffFingerprint: 'fp-full-new', capturedAt: CAPTURED_AT, source: 'git-readonly' };
/**
 * document com PR/aprovação de pr-review em OLD e evidências/HEAD em NEW. Base: avanço só
 * documental (mesmo fingerprint de código do aprovado). O fechamento só é aceito
 * depois que a PR observada também aponta para NEW.
 */
function closingAtNewCommit(over: { run?: ScenarioOptions['run']; gate?: ScenarioOptions['gate'] } = {}): Scenario {
  return scenario('document', {
    run: {
      pullRequest: validPrRef({ commit: OLD }),
      approvedSnapshot: { commit: OLD, diffFingerprint: 'fp-code-1', capturedAt: CAPTURED_AT, source: 'git-readonly' },
      ...over.run,
    },
    rubric: { commit: NEW, codeSnapshot: newTree },
    checkEvidence: { commit: NEW, codeSnapshot: newTree },
    op: { expectedCommit: NEW },
    gate: {
      currentSnapshot: { commit: NEW, diffFingerprint: 'fp-full-new' },
      currentCodeSnapshot: { commit: NEW, diffFingerprint: 'fp-code-1' },
      commitRelation: 'docs-only-advance',
      pullRequest: validObservation({ headSha: OLD }),
      ...over.gate,
    },
  });
}

test('document não fecha com código alterado sobre PR aprovada em commit antigo (OLD na PR / NEW no document)', () => {
  // A evidência acompanha o commit atual (NEW) — os checks passam e a rejeição vem
  // especificamente do vínculo com o snapshot aprovado em pr-review.
  const changed = closingAtNewCommit({ gate: { currentCodeSnapshot: { commit: NEW, diffFingerprint: 'fp-code-NOVO' }, commitRelation: 'code-changed' } });
  const out = applyCompletion(changed.state, changed.op, changed.gate);
  assertRejectedNoEffect(changed.state, out, /código alterado após a aprovação de pr-review/, 'diff de código novo');
  assert.equal(out.state.runs[0].status, 'running', 'sem fechamento indevido');
  // mesmo fingerprint de código, mas commit fora da relação aprovada (código mudou de commit)
  assertRejectedNoEffect(changed.state, applyCompletion(changed.state, changed.op, { ...changed.gate, currentCodeSnapshot: { commit: NEW, diffFingerprint: 'fp-code-1' } }), /não corresponde ao aprovado.*code-changed/, 'relação code-changed');
  assertRejectedNoEffect(changed.state, applyCompletion(changed.state, changed.op, { ...changed.gate, currentCodeSnapshot: { commit: NEW, diffFingerprint: 'fp-code-1' }, commitRelation: undefined }), /não verificada/, 'relação não verificada');
  // Avanço só documental ainda local não fecha: a PR precisa publicar o commit final.
  const docsOnly = closingAtNewCommit();
  assertRejectedNoEffect(docsOnly.state, applyCompletion(docsOnly.state, docsOnly.op, docsOnly.gate), /publique o avanço documental/, 'avanço documental sem push');
  // Quando o push documental chegou à PR (head === commit atual), o fechamento é válido.
  const pushed = closingAtNewCommit({ gate: { pullRequest: validObservation({ headSha: NEW }) } });
  assert.equal(applyCompletion(pushed.state, pushed.op, pushed.gate).result.status, 'done');
  // Sem nenhum avanço (mesmo commit e árvore de código): relação 'same'
  const same = scenario('document');
  assert.equal(applyCompletion(same.state, same.op, same.gate).result.status, 'done');
});

test('fechamento exige o snapshot aprovado e a PR observada agora (cada fato removido reprova)', () => {
  const cases: Array<[string, Scenario, RegExp]> = [
    ['sem snapshot aprovado em pr-review', closingAtNewCommit({ run: { approvedSnapshot: undefined } }), /snapshot aprovado em pr-review/],
    ['sem PR registrada na execução', closingAtNewCommit({ run: { pullRequest: undefined } }), /exige pullRequest registrada/],
    ['sem observação atual da PR', closingAtNewCommit({ gate: { pullRequest: undefined } }), /observação atual da PR/],
    ['PR observada fechada', closingAtNewCommit({ gate: { pullRequest: validObservation({ headSha: OLD, state: 'CLOSED' }) } }), /somente PR aberta/],
    ['PR observada já mergeada', closingAtNewCommit({ gate: { pullRequest: validObservation({ headSha: OLD, state: 'MERGED' }) } }), /somente PR aberta/],
    ['PR observada é outra', closingAtNewCommit({ gate: { pullRequest: validObservation({ headSha: OLD, url: 'https://github.com/o/r/pull/77', number: 77 }) } }), /não é a PR registrada/],
    ['base da PR observada diverge', closingAtNewCommit({ gate: { pullRequest: validObservation({ headSha: OLD, base: 'develop' }) } }), /base da PR observada/],
    ['branch da PR observada diverge', closingAtNewCommit({ gate: { pullRequest: validObservation({ headSha: OLD, branch: 'outra/branch' }) } }), /branch da PR observada/],
    ['PR observada sem head SHA', closingAtNewCommit({ gate: { pullRequest: validObservation({ headSha: '' }) } }), /sem head SHA/],
    ['head remoto nem aprovado nem o avanço documental', closingAtNewCommit({ gate: { pullRequest: validObservation({ headSha: 'outro-head' }) } }), /head remoto da PR \(outro-head\)/],
    ['head no commit novo sem avanço documental declarado', closingAtNewCommit({ gate: { commitRelation: 'same', pullRequest: validObservation({ headSha: NEW }) } }), /head remoto da PR \(new\)/],
  ];
  for (const [name, sc, pattern] of cases) assertSameRejection(sc, pattern, name);
});

test('validateCompletion cobre o fechamento vinculado à PR (mesma mensagem da aplicação)', () => {
  const stale = closingAtNewCommit({ gate: { currentCodeSnapshot: { commit: NEW, diffFingerprint: 'fp-code-NOVO' }, commitRelation: 'code-changed' } });
  const dry = validateCompletion(stale.state, stale.op, stale.gate);
  assert.equal(dry.ok, false);
  assert.match(dry.ok ? '' : dry.error, /código alterado após a aprovação de pr-review/);
  assert.equal(applyCompletion(stale.state, stale.op, stale.gate).result.error, dry.ok ? '' : dry.error);
});
