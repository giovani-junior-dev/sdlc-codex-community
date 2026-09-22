import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRuntime, type Run, type Stage } from '../../src/contracts.js';
import { statusReport } from '../../src/evidence/report.js';
import { GhAdapter } from '../../src/adapters/git.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';

const ALL_STAGES: Stage[] = ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'];
function emptyAttempts(): Record<Stage, number> { return Object.fromEntries(ALL_STAGES.map(s => [s, 0])) as Record<Stage, number>; }
function emptyGapFailures(): Record<Stage, { gapId: string; count: number }> { return Object.fromEntries(ALL_STAGES.map(s => [s, { gapId: '', count: 0 }])) as Record<Stage, { gapId: string; count: number }>; }

test('status reporta sem inferir morte por silêncio', () => {
  const state = emptyRuntime('p');
  state.sessions.push({ role: 'planner', generationId: 'g', projectId: 'p', cwd: 'c', status: 'unknown', lastEventAt: '2026-01-01T00:00:00Z' });
  const report = statusReport(state) as { sessions: Array<{ status: string }> };
  assert.equal(report.sessions[0].status, 'unknown');
});

// R15: PR existente na retomada é reutilizada; base incorreta não casa.
test('findOpenPr casa branch+base; nada duplicado na retomada', async () => {
  const list = [{ url: 'https://github.com/o/r/pull/7', headRefName: 'sdlc/x', baseRefName: 'main', headRefOid: 'abc123', number: 7 }];
  const runner = new FakeProcessRunner(() => ({ exitCode: 0, stdout: JSON.stringify(list), stderr: '', timedOut: false, acceptedBeforeTimeout: false }));
  const gh = new GhAdapter(runner);
  const found = await gh.findOpenPr('sdlc/x', 'main', 'C:\\r');
  assert.equal(found?.url, 'https://github.com/o/r/pull/7');
  assert.equal(found?.commit, 'abc123');
  assert.equal(await gh.findOpenPr('sdlc/x', 'outra-base', 'C:\\r'), undefined);
  assert.equal(await gh.findOpenPr('sdlc/outra', 'main', 'C:\\r'), undefined);
  assert.deepEqual(runner.calls[0].args.slice(0, 2), ['pr', 'list']);
});

test('done não significa merge/deploy: fechamento é técnico com PR pronta', () => {
  const state = emptyRuntime('p');
  state.runs.push({
    runId: 'r', slug: 's', workflow: 'feature', intentPath: 'i', planPath: 'p',
    stage: 'document', revision: 6, attempts: emptyAttempts(), gapFailures: emptyGapFailures(), status: 'done', history: [],
    pullRequest: { url: 'https://github.com/o/r/pull/7', base: 'main', branch: 'sdlc/s', commit: 'abc', checkedAt: new Date().toISOString() },
  });
  const report = statusReport(state, 's') as { runs: Array<{ status: string; pullRequest: { url: string } }> };
  assert.equal(report.runs[0].status, 'done');
  assert.equal(report.runs[0].pullRequest.url, 'https://github.com/o/r/pull/7');
});

// ---------- C10 + R5 — PR integrada ao fechamento (engine puro, GhAdapter como contrato) ----------
// O motor não faz IO: o pass exige um gate COMPLETO com fatos verificados pelo chamador (manifesto aprovado,
// snapshot, seleção de checks, logs verificados e, em pr-review/fechamento, a PR observada agora). Os fixtures
// abaixo montam o baseline VÁLIDO; cada rejeição altera exatamente um fato.

import { createHash } from 'node:crypto';
import { applyCompletion } from '../../src/pipeline/engine.js';
import { emptyRuntime as runtime, type StageCompletion, type Runtime, type RequirementsManifest } from '../../src/contracts.js';
import type { EvidenceGateContext, PrObservation } from '../../src/evidence/report.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const ALL_STAGES2: Stage[] = ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'];
const attempts0 = () => Object.fromEntries(ALL_STAGES2.map(s => [s, 0])) as Run['attempts'];
const gaps0 = () => Object.fromEntries(ALL_STAGES2.map(s => [s, undefined])) as Run['gapFailures'];

const AT = '2026-09-19T04:00:00Z';
const SNAP = { commit: 'abc', diffFingerprint: 'fp-arvore-1', capturedAt: AT, source: 'git-readonly' as const };
const MANIFEST: RequirementsManifest = {
  manifestPath: 'requirements.json', planPath: 'p', planHash: sha('plano'),
  entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }],
};
const MANIFEST_HASH = sha(JSON.stringify(MANIFEST));
const APPROVAL = {
  intentPath: 'i', planPath: 'p', approvedAt: AT, approvedBy: 'humano', intentHash: sha('intent'), planHash: sha('plano'), planVersion: 'plano-v1',
  requirementsManifest: { path: 'requirements.json', hash: MANIFEST_HASH },
};
const LOG_HASH = sha('log do estágio');
const ROLE_OF: Record<string, { role: 'dev' | 'reviewer' | 'document'; thread: string; gen: string }> = {
  pr: { role: 'dev', thread: 't-dev', gen: 'g-dev' }, 'pr-review': { role: 'reviewer', thread: 't-rev', gen: 'g-rev' },
  document: { role: 'document', thread: 't-doc', gen: 'g-doc' }, review: { role: 'reviewer', thread: 't-rev', gen: 'g-rev' },
};
const checkOf = (stage: Stage) => (stage === 'review' || stage === 'pr-review' ? 'unit' : 'build');

const sessions = () => [
  { role: 'dev' as const, threadId: 't-dev', generationId: 'g-dev', projectId: 'p', cwd: 'c', status: 'ready' as const, lastEventAt: new Date().toISOString() },
  { role: 'reviewer' as const, threadId: 't-rev', generationId: 'g-rev', projectId: 'p', cwd: 'c', status: 'ready' as const, lastEventAt: new Date().toISOString() },
  { role: 'document' as const, threadId: 't-doc', generationId: 'g-doc', projectId: 'p', cwd: 'c', status: 'ready' as const, lastEventAt: new Date().toISOString() },
  { role: 'planner' as const, threadId: 't-planner', generationId: 'g-planner', projectId: 'p', cwd: 'c', status: 'ready' as const, lastEventAt: new Date().toISOString() },
];

/** Evidências do baseline válido: rubrica humana (importada, com produtor) + check do PRODUTO (não importado). */
function evidenceFor(run: Run, stage: Stage, commit = 'abc', withCheck = true): Runtime['evidence'] {
  const p = ROLE_OF[stage];
  const snapshot = { ...SNAP, commit };
  const list: Runtime['evidence'] = [{
    id: 'rub', requirementId: `${run.slug}:${stage}:REQ-1`, result: 'pass', verdict: 'pass', procedure: 'rubrica humana',
    logPath: 'logs/r.log', logHash: LOG_HASH, timestamp: AT, producedAt: AT, commit, file: 'src/a.ts', line: 1,
    runId: run.runId, stage, projectId: 'p', revision: run.revision,
    producer: { role: p.role, threadId: p.thread, generationId: p.gen }, codeSnapshot: snapshot, imported: true, importedAt: AT,
  }];
  if (withCheck) {
    list.push({
      id: 'chk', requirementId: `${run.slug}:${stage}:check-${checkOf(stage)}`, result: 'pass', verdict: 'pass', procedure: 'check do produto',
      logPath: 'logs/b.log', logHash: LOG_HASH, timestamp: AT, producedAt: AT, commit, check: checkOf(stage), exitCode: 0,
      runId: run.runId, stage, projectId: 'p', revision: run.revision, codeSnapshot: snapshot,
    });
  }
  return list;
}

/** Gate completo do baseline: árvore igual à das evidências, logs verificados, check exigido presente. */
function gateFor(stage: Stage, over: Partial<EvidenceGateContext> = {}, withCheck = true): EvidenceGateContext {
  return {
    manifest: MANIFEST, manifestHash: MANIFEST_HASH,
    currentSnapshot: { commit: SNAP.commit, diffFingerprint: SNAP.diffFingerprint },
    currentCodeSnapshot: { commit: SNAP.commit, diffFingerprint: SNAP.diffFingerprint },
    checks: { required: withCheck ? [checkOf(stage)] : [], missing: [], exempt: [] },
    verifiedLogs: withCheck ? ['rub', 'chk'] : ['rub'],
    ...over,
  };
}

const PRREF = { url: 'https://github.com/o/r/pull/9', base: 'main', branch: 'sdlc/close', commit: 'abc', checkedAt: '2026-09-19T04:00:00Z', number: 9 };
/** Observação ATUAL da PR (leitura externa) — o motor não copia nada da referência antiga. */
const OBS: PrObservation = { url: PRREF.url, number: 9, state: 'OPEN', base: 'main', branch: 'sdlc/close', headSha: 'abc', observedAt: AT };

function prStageState(stage: Run['stage'], runExtra: Partial<Run> = {}): { state: Runtime; run: Run } {
  const run: Run = {
    runId: 'run-pr', slug: 'close', workflow: 'feature', intentPath: 'i', planPath: 'p',
    branch: 'sdlc/close', base: 'main', stage, revision: 1, approval: APPROVAL, configHash: sha('config'),
    attempts: attempts0(), gapFailures: gaps0(), status: 'running', history: [], ...runExtra,
  };
  const state = runtime('p');
  state.sessions.push(...sessions());
  state.runs.push(run);
  state.evidence.push(...evidenceFor(run, stage));
  return { state, run };
}
function pass(run: Run, role: 'dev' | 'reviewer' | 'document', extra: Partial<StageCompletion> = {}): StageCompletion {
  const p = Object.values(ROLE_OF).find(x => x.role === role)!;
  return {
    operationId: `op-${run.runId}-${run.stage}-${Math.random()}`, runId: run.runId, stage: run.stage,
    expectedRevision: run.revision, actor: { role, threadId: p.thread, generationId: p.gen, projectId: 'p' },
    result: 'pass', evidenceIds: ['rub', 'chk'], expectedCommit: 'abc', ...extra,
  };
}

test('C10: PR existente e coerente é gravada no run; ausente/ambígua é recusada', () => {
  const { state, run } = prStageState('pr');
  const okOut = applyCompletion(state, pass(run, 'dev', { pullRequest: PRREF }), gateFor('pr'));
  assert.equal(okOut.result.accepted, true, okOut.result.error);
  assert.equal(okOut.state.runs[0].pullRequest?.number, 9);
  const semPr = prStageState('pr');
  assert.match(applyCompletion(semPr.state, pass(semPr.run, 'dev'), gateFor('pr')).result.error ?? '', /pullRequest/);
  const commitVazio = prStageState('pr');
  assert.equal(applyCompletion(commitVazio.state, pass(commitVazio.run, 'dev', { pullRequest: { ...PRREF, commit: '' } }), gateFor('pr')).result.accepted, false);
});

// R5-03/R5-05 (substitui "sem gate o pass segue a matriz legada"): o pass NUNCA é aceito sem gate completo.
test('R5-03: pass sem contexto de gate é recusado, mesmo com PR coerente e evidência aparentemente válida', () => {
  const { state, run } = prStageState('pr');
  const out = applyCompletion(state, pass(run, 'dev', { pullRequest: PRREF }));
  assert.equal(out.result.accepted, false);
  assert.match(out.result.error ?? '', /gate/);
  assert.equal(out.state.runs[0].stage, 'pr', 'sem transição');
  assert.equal(out.deliveries.length, 0, 'nenhuma entrega criada');
  // check exigido pelo método e ausente da seleção (sem dispensa): recusa ANTES de qualquer efeito.
  const missing = prStageState('pr');
  const miss = applyCompletion(missing.state, pass(missing.run, 'dev', { pullRequest: PRREF }), gateFor('pr', { checks: { required: [], missing: ['build'], exempt: [] } }));
  assert.equal(miss.result.accepted, false);
  assert.match(miss.result.error ?? '', /build/);
});

test('C10: base errada ou branch divergente da PR é recusada', () => {
  const wrongBase = prStageState('pr');
  assert.equal(applyCompletion(wrongBase.state, pass(wrongBase.run, 'dev', { pullRequest: { ...PRREF, base: 'develop' } }), gateFor('pr')).result.accepted, false);
  const wrongBranch = prStageState('pr');
  assert.equal(applyCompletion(wrongBranch.state, pass(wrongBranch.run, 'dev', { pullRequest: { ...PRREF, branch: 'outra' } }), gateFor('pr')).result.accepted, false);
});

test('C10: gates de fechamento — done sem PR falha em feature; review-only done sem PR é ok', () => {
  const closing = { pullRequest: PRREF, approvedSnapshot: SNAP };
  const feature = prStageState('document');
  const rejected = applyCompletion(feature.state, pass(feature.run, 'document'), gateFor('document', { pullRequest: OBS, commitRelation: 'same' }));
  assert.equal(rejected.result.accepted, false);
  assert.match(rejected.result.error ?? '', /pullRequest/);
  const withPr = prStageState('document', closing);
  const accepted = applyCompletion(withPr.state, pass(withPr.run, 'document'), gateFor('document', { pullRequest: OBS, commitRelation: 'same' }));
  assert.equal(accepted.result.status, 'done', accepted.result.error);
  // R5-07 (substitui "PR registrada basta para fechar"): o fechamento exige a PR OBSERVADA agora, aberta,
  // a mesma da execução, com head == commit aprovado; e o snapshot aprovado em pr-review.
  const noObs = prStageState('document', closing);
  assert.match(applyCompletion(noObs.state, pass(noObs.run, 'document'), gateFor('document', { commitRelation: 'same' })).result.error ?? '', /observação atual da PR/);
  const closed = prStageState('document', closing);
  assert.match(applyCompletion(closed.state, pass(closed.run, 'document'), gateFor('document', { pullRequest: { ...OBS, state: 'CLOSED' }, commitRelation: 'same' })).result.error ?? '', /CLOSED/);
  const otherPr = prStageState('document', closing);
  assert.match(applyCompletion(otherPr.state, pass(otherPr.run, 'document'), gateFor('document', { pullRequest: { ...OBS, url: 'https://github.com/o/r/pull/10', number: 10 }, commitRelation: 'same' })).result.error ?? '', /não é a PR registrada/);
  const noApproved = prStageState('document', { pullRequest: PRREF });
  assert.match(applyCompletion(noApproved.state, pass(noApproved.run, 'document'), gateFor('document', { pullRequest: OBS, commitRelation: 'same' })).result.error ?? '', /snapshot aprovado/);
  const codeChanged = prStageState('document', closing);
  const drifted = { commit: 'abc', diffFingerprint: 'fp-arvore-2' };
  assert.match(applyCompletion(codeChanged.state, pass(codeChanged.run, 'document'), gateFor('document', { pullRequest: OBS, commitRelation: 'same', currentCodeSnapshot: drifted })).result.error ?? '', /código alterado/);
  // review-only: contrato próprio, sem PR — mas com o MESMO gate completo (manifesto, snapshot, proveniência).
  const ro: Run = {
    runId: 'run-ro', slug: 'ro', workflow: 'review-only', intentPath: 'i', planPath: 'p', approval: APPROVAL, configHash: sha('config'),
    stage: 'review', revision: 0, attempts: attempts0(), gapFailures: gaps0(), status: 'running', history: [],
  };
  const roState = runtime('p');
  roState.sessions.push(...sessions().filter(x => x.role === 'reviewer' || x.role === 'planner'));
  roState.runs.push(ro);
  roState.evidence.push(...evidenceFor(ro, 'review', 'abc', false));
  const roOp: StageCompletion = {
    operationId: 'op-ro', runId: ro.runId, stage: 'review', expectedRevision: 0,
    actor: { role: 'reviewer', threadId: 't-rev', generationId: 'g-rev', projectId: 'p' },
    result: 'pass', evidenceIds: ['rub'], expectedCommit: 'abc',
  };
  const roOut = applyCompletion(roState, roOp, gateFor('review', {}, false));
  assert.equal(roOut.result.status, 'done', roOut.result.error);
  // review-only sem gate também é recusado (nenhum workflow dispensa o gate).
  const roNoGate = applyCompletion(roState, { ...roOp, operationId: 'op-ro-2' });
  assert.equal(roNoGate.result.accepted, false);
});

test('C10: pr-review revalida PR quando o commit muda; mesmo commit passa', () => {
  // Evidência, snapshot e gate TODOS no commit novo: só a regra "PR registrada em outro commit" reprova.
  const changed = prStageState('pr-review', { pullRequest: { ...PRREF, commit: 'abc' } });
  const newer = { ...changed.run, revision: 2 };
  changed.state.runs[0] = newer;
  changed.state.evidence = evidenceFor(newer, 'pr-review', 'novo');
  const newSnap = { commit: 'novo', diffFingerprint: SNAP.diffFingerprint };
  const reject = applyCompletion(changed.state, pass(newer, 'reviewer', { expectedCommit: 'novo' }),
    gateFor('pr-review', { currentSnapshot: newSnap, currentCodeSnapshot: newSnap, pullRequest: { ...OBS, headSha: 'novo' } }));
  assert.equal(reject.result.accepted, false);
  assert.match(reject.result.error ?? '', /reconfirme a PR/);
  const same = prStageState('pr-review', { pullRequest: PRREF });
  const accept = applyCompletion(same.state, pass(same.run, 'reviewer'), gateFor('pr-review', { pullRequest: OBS }));
  assert.equal(accept.result.accepted, true, accept.result.error);
  assert.equal(accept.state.runs[0].approvedSnapshot?.diffFingerprint, SNAP.diffFingerprint, 'pr-review persiste o snapshot aprovado (R5-07)');
  // R5-07: head REMOTO da PR observada diferente do commit aprovado (push pendente/adulterado) não aprova.
  const staleHead = prStageState('pr-review', { pullRequest: PRREF });
  const stale = applyCompletion(staleHead.state, pass(staleHead.run, 'reviewer'), gateFor('pr-review', { pullRequest: { ...OBS, headSha: 'remoto999' } }));
  assert.equal(stale.result.accepted, false);
  assert.match(stale.result.error ?? '', /head remoto/);
  // sem observação da PR (leitura externa não feita): nunca aprova.
  const noObs = prStageState('pr-review', { pullRequest: PRREF });
  assert.match(applyCompletion(noObs.state, pass(noObs.run, 'reviewer'), gateFor('pr-review')).result.error ?? '', /observação atual da PR/);
});
