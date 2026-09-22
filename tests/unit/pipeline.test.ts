import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRuntime, id, type Run, type Runtime, type SessionRecord, type Stage } from '../../src/contracts.js';
import { applyCompletion, startRun } from '../../src/pipeline/engine.js';
import type { StageCompletion } from '../../src/contracts.js';
import {
  assertRejectedNoEffect, CONFIG_HASH, MANIFEST_HASH, scenario, validApproval, validManifest, validObservation, validPrRef, validRun,
  type Scenario, type ScenarioOptions,
} from './gate-fixtures.js';

const ALL_STAGES: Stage[] = ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'];
function emptyAttempts(): Record<Stage, number> { return Object.fromEntries(ALL_STAGES.map(s => [s, 0])) as Record<Stage, number>; }
function emptyGapFailures(): Record<Stage, { gapId: string; count: number }> { return Object.fromEntries(ALL_STAGES.map(s => [s, { gapId: '', count: 0 }])) as Record<Stage, { gapId: string; count: number }>; }

function session(role: SessionRecord['role'], thread: string, gen: string): SessionRecord {
  return { role, threadId: thread, generationId: gen, projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: new Date().toISOString() };
}
function stateWith(run: Run, sessions: SessionRecord[], evidenceCommit = 'abc'): Runtime {
  const state = emptyRuntime('p');
  state.sessions.push(...sessions);
  state.runs.push(run);
  state.evidence.push({ id: 'e', requirementId: `${run.slug}:${run.stage}:REQ-2`, result: 'pass', procedure: 'review', timestamp: new Date().toISOString(), commit: evidenceCommit, verdict: 'pass', runId: run.runId, stage: run.stage, logPath: 'logs/e.log', file: 'src/a.ts', line: 7 });
  return state;
}
function op(run: Run, result: 'pass' | 'fail', role: SessionRecord['role'], thread: string, gen: string, extra: Partial<StageCompletion> = {}): StageCompletion {
  return { operationId: id(), runId: run.runId, stage: run.stage, expectedRevision: run.revision, actor: { role, threadId: thread, generationId: gen, projectId: 'p' }, result, evidenceIds: ['e'], ...extra };
}
function featureRun(stage: Run['stage'] = 'review'): Run {
  return { runId: 'run', slug: 'change', workflow: 'feature', intentPath: 'i', planPath: 'p', stage, revision: 4, attempts: emptyAttempts(), gapFailures: emptyGapFailures(), status: 'running', history: [] };
}

test('review failure retorna a build e replay é idempotente', () => {
  const run = featureRun();
  const state = stateWith(run, [session('reviewer', 't-r', 'g-r')]);
  const first = applyCompletion(state, { ...op(run, 'fail', 'reviewer', 't-r', 'g-r'), operationId: 'R1', gapId: 'REQ-2' });
  assert.equal(first.result.accepted, true);
  assert.equal(first.state.runs[0].stage, 'build');
  assert.equal(first.state.runs[0].revision, 5);
  // entrega ao responsável + cópia independente ao planner
  assert.equal(first.deliveries.length, 2);
  assert.deepEqual(first.deliveries.map(() => 1).length, 2);
  const second = applyCompletion(first.state, { ...op(run, 'fail', 'reviewer', 't-r', 'g-r'), operationId: 'R1', gapId: 'REQ-2' });
  assert.deepEqual(second.result, first.result);
  assert.equal(second.deliveries.length, 0);
});

// R5: o pass exige gate completo; a rejeição precisa vir da ausência de evidência, não do gate.
test('pass sem evidência é recusado (regra única R05)', () => {
  const sc = scenario('review', { op: { evidenceIds: [] } });
  assertRejectedNoEffect(sc.state, applyCompletion(sc.state, sc.op, sc.gate), /evidenceIds não vazio/, 'evidenceIds vazio');
  // evidência referenciada que não existe no estado
  const missing = scenario('review');
  missing.state.evidence = missing.state.evidence.filter(e => e.id !== missing.rubric.id);
  assertRejectedNoEffect(missing.state, applyCompletion(missing.state, missing.op, missing.gate), /não encontrada/, 'evidência inexistente');
  // o caso completo do mesmo cenário é aceito (a rejeição vem da evidência, não do fixture)
  const ok = scenario('review');
  assert.equal(applyCompletion(ok.state, ok.op, ok.gate).result.accepted, true);
});

test('R13 hotfix reprovado volta ao build (não repete review)', () => {
  const run: Run = { runId: 'h', slug: 'hot', workflow: 'hotfix', intentPath: 'i', planPath: 'p', stage: 'review', revision: 0, attempts: emptyAttempts(), gapFailures: emptyGapFailures(), status: 'running', history: [] };
  const state = stateWith(run, [session('reviewer', 't', 'g')]);
  const out = applyCompletion(state, { ...op(run, 'fail', 'reviewer', 't', 'g'), gapId: 'REQ-9' });
  assert.equal(out.result.accepted, true);
  assert.equal(out.state.runs[0].stage, 'build');
});

test('R13 review-only reprovado encerra como blocked com relatório', () => {
  const run: Run = { runId: 'r', slug: 'ro', workflow: 'review-only', intentPath: 'i', planPath: 'p', stage: 'review', revision: 0, attempts: emptyAttempts(), gapFailures: emptyGapFailures(), status: 'running', history: [] };
  const state = stateWith(run, [session('reviewer', 't', 'g'), session('planner', 'tp', 'gp')]);
  const out = applyCompletion(state, { ...op(run, 'fail', 'reviewer', 't', 'g'), gapId: 'REQ-1', blockedReason: 'fora de escopo aprovado' });
  assert.equal(out.result.status, 'blocked');
  assert.equal(out.state.runs[0].blockedReason, 'fora de escopo aprovado');
  const msgs = out.state.messages.filter(m => m.runId === 'r');
  assert.ok(msgs.length >= 1 && msgs.every(m => m.type === 'notify' && m.to === 'planner'));
});

test('R13 done notifica o planner', () => {
  // review-only: nenhum check mecânico exigido nem PR; o pass ainda exige gate completo e rubrica
  const sc = scenario('review', { run: { workflow: 'review-only', runId: 'd', slug: 'doc' } });
  const out = applyCompletion(sc.state, sc.op, sc.gate);
  assert.equal(out.result.status, 'done');
  const msgs = out.state.messages.filter(m => m.runId === 'd');
  assert.ok(msgs.some(m => m.type === 'notify' && m.to === 'planner'));
});

test('R13 quarto fail encerra como exhausted', () => {
  const run: Run = { runId: 'x', slug: 'ex', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'build', revision: 0, attempts: { ...emptyAttempts(), build: 3 }, gapFailures: emptyGapFailures(), status: 'running', history: [] };
  const state = stateWith(run, [session('dev', 't', 'g')]);
  const out = applyCompletion(state, op(run, 'fail', 'dev', 't', 'g'));
  assert.equal(out.result.status, 'exhausted');
});

test('R13 mesmo gap 2x seguidas encerra como thrash; pass limpa sequência', () => {
  const run: Run = { runId: 't', slug: 'th', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'review', revision: 0, attempts: emptyAttempts(), gapFailures: { ...emptyGapFailures(), review: { gapId: 'G', count: 1 } }, status: 'running', history: [] };
  const s1 = stateWith(run, [session('reviewer', 't', 'g')]);
  const thrash = applyCompletion(s1, { ...op(run, 'fail', 'reviewer', 't', 'g'), gapId: 'G' });
  assert.equal(thrash.result.status, 'thrash');
  // build intermediário não apaga histórico do reviewer; pass limpa
  const run2: Run = { ...run, gapFailures: { ...emptyGapFailures(), review: { gapId: 'G', count: 1 } } };
  const s2 = stateWith(run2, [session('reviewer', 't', 'g')]);
  const back = applyCompletion(s2, { ...op(run2, 'fail', 'reviewer', 't', 'g'), gapId: 'OUTRO' });
  assert.equal(back.state.runs[0].gapFailures.review?.count, 1);
});

test('R13 repetição de gap com build intermediário mantém thrash do reviewer', () => {
  const run: Run = { runId: 'g', slug: 'gap', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'review', revision: 7, attempts: emptyAttempts(), gapFailures: { ...emptyGapFailures(), review: { gapId: 'REQ-2', count: 1 } }, status: 'running', history: [] };
  const state = stateWith(run, [session('reviewer', 't', 'g')]);
  const out = applyCompletion(state, { ...op(run, 'fail', 'reviewer', 't', 'g'), gapId: 'REQ-2' });
  assert.equal(out.result.status, 'thrash');
});

test('operações após terminal são recusadas', () => {
  // gate e evidência completos: a recusa vem só do estado terminal
  const sc = scenario('build', { run: { runId: 'z', slug: 'zz', revision: 9, status: 'done' } });
  assertRejectedNoEffect(sc.state, applyCompletion(sc.state, sc.op, sc.gate), /operações após terminal são recusadas/, 'terminal');
});

test('geração antiga não conclui; proprietário errado não conclui', () => {
  const run = featureRun();
  const state = stateWith(run, [session('reviewer', 't-r', 'g-nova')]);
  assert.equal(applyCompletion(state, op(run, 'fail', 'reviewer', 't-r', 'g-antiga', { gapId: 'X' })).result.accepted, false);
  assert.equal(applyCompletion(state, op(run, 'fail', 'dev', 't-d', 'g', { gapId: 'X' })).result.accepted, false);
});

// ---------- C08 — aprovação previamente vinculada e time completo ----------

// R5-05: a execução NOVA só inicia com aprovação que cobre o manifesto (caminho + sha256) e configHash.
function approvedRun(extra: Partial<Run> = {}): Run {
  return { ...validRun('build', { runId: 'run-c08', slug: 'bond', revision: 0 }), ...extra };
}
const approval = validApproval;
function fullTeam(): SessionRecord[] {
  return ['planner', 'dev', 'reviewer', 'tester-e2e', 'document'].map(r => session(r as SessionRecord['role'], `t-${r}`, `g-${r}`));
}

test('C08: startRun exige aprovação previamente vinculada (presença, formato, consistência)', () => {
  const base = emptyRuntime('p');
  base.sessions.push(...fullTeam());
  const start = (run: Run) => { try { startRun(base, run); return 'ok'; } catch (e) { return (e as Error).message; } };
  assert.match(start(approvedRun({ approval: undefined })), /aprovação registrada/);
  assert.match(start(approvedRun({ approval: approval({ intentHash: undefined }) })), /intentHash/);
  assert.match(start(approvedRun({ approval: approval({ planHash: undefined }) })), /planHash/);
  assert.match(start(approvedRun({ approval: approval({ planVersion: undefined }) })), /planVersion/);
  assert.match(start(approvedRun({ approval: approval({ intentHash: 'não-hex' }) })), /sha256/);
  // approval apontando para outros artefatos não valida o run
  assert.match(start(approvedRun({ approval: approval({ intentPath: 'outro.md' }) })), /intentPath/);
  assert.match(start(approvedRun({ approval: approval({ approvedAt: 'data-que-não-existe' }) })), /approvedAt/);
  assert.match(start(approvedRun({ approval: approval({ approvedBy: '' }) })), /approvedBy/);
  assert.equal(start(approvedRun()), 'ok');
});

// R5-05: antes a aprovação sem manifesto e o run sem configHash iniciavam (modo legado silencioso).
test('R5-05: startRun recusa aprovação sem manifesto de requisitos coberto por hash e run sem configHash', () => {
  const base = emptyRuntime('p');
  base.sessions.push(...fullTeam());
  const start = (run: Run) => { try { startRun(base, run); return 'ok'; } catch (e) { return (e as Error).message; } };
  assert.match(start(approvedRun({ approval: approval({ requirementsManifest: undefined }) })), /manifesto de requisitos/);
  assert.match(start(approvedRun({ approval: approval({ requirementsManifest: { path: '.sdlc-codex/requirements.json', hash: 'não-hex' } }) })), /manifesto de requisitos/);
  assert.match(start(approvedRun({ approval: approval({ requirementsManifest: { path: '', hash: MANIFEST_HASH } }) })), /manifesto de requisitos/);
  assert.match(start(approvedRun({ configHash: undefined })), /configHash/);
  assert.match(start(approvedRun({ configHash: 'não-hex' })), /configHash/);
  assert.equal(start(approvedRun({ configHash: CONFIG_HASH })), 'ok');
  assert.equal(base.runs.length, 0, 'nenhuma execução criada pelas recusas');
});

test('C08: time parcial (sem tester-e2e) não inicia; time completo com planner inicia', () => {
  const base = emptyRuntime('p');
  base.sessions.push(...fullTeam().filter(s => s.role !== 'tester-e2e'));
  assert.throws(() => startRun(base, approvedRun()), /tester-e2e/);
  const ok = emptyRuntime('p');
  ok.sessions.push(...fullTeam());
  const next = startRun(ok, approvedRun());
  assert.equal(next.runs.length, 1);
});

test('C08: slug reutilizado após terminal inicia nova execução; histórico preservado', () => {
  const base = emptyRuntime('p');
  base.sessions.push(...fullTeam());
  base.runs.push({ ...approvedRun(), runId: 'hist-1', status: 'done', stage: 'document' });
  const next = startRun(base, approvedRun({ runId: 'nova-1' }));
  assert.equal(next.runs.length, 2);
  assert.equal(next.runs[0].status, 'done');
  // mas duas running simultâneas nunca
  assert.throws(() => startRun(next, approvedRun({ runId: 'nova-2' })), /execução ativa/);
});

test('C08: dois startRun concorrentes — um só vence', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { StateStore } = await import('../../src/state/store.js');
  const root = await mkdtemp(join(tmpdir(), 'sdlc-c-start-'));
  const store = new StateStore(root, { projectId: 'p' });
  await store.init('p');
  await store.mutate(s => ({ state: { ...s, sessions: fullTeam().map(x => ({ ...x, projectId: 'p' })) }, result: undefined }));
  // shape persistível: gapFailures com entradas undefined (como o cli monta)
  const cleanGaps = () => Object.fromEntries(ALL_STAGES.map(s => [s, undefined])) as Run['gapFailures'];
  const attempt = (runId: string) => store.mutate(s => ({
    state: startRun(s, { ...approvedRun({ runId }), gapFailures: cleanGaps() }),
    result: undefined,
  })).then(() => 'won').catch(() => 'lost');
  const [a, b] = await Promise.all([attempt('concorrente-a'), attempt('concorrente-b')]);
  assert.notEqual(a, b);
  assert.equal((await store.read()).runs.filter(r => r.status === 'running').length, 1);
});

// ---------- C09 — política única de evidências ----------

// Casos de sucesso completos vêm de gate-fixtures (proveniência, log verificado, snapshot, manifesto
// aprovado, checks); cada teste de rejeição altera UM fato e afirma que nada mudou no estado.
function runAt(stage: Run['stage'], extra: Partial<Run> = {}): Run {
  return { runId: 'run-c09', slug: 'pol', workflow: 'feature', intentPath: 'i', planPath: 'p', stage, revision: 0, attempts: emptyAttempts(), gapFailures: emptyGapFailures(), status: 'running', history: [], ...extra };
}
function passOp(run: Run, expectedCommit?: string, evidenceIds = ['ev-rubric', 'ev-check']): StageCompletion {
  return { operationId: id(), runId: run.runId, stage: run.stage, expectedRevision: run.revision, actor: { role: 'dev', threadId: 't-dev', generationId: 'g-dev', projectId: 'p' }, result: 'pass', evidenceIds, expectedCommit };
}
const applyScenario = (sc: Scenario) => applyCompletion(sc.state, sc.op, sc.gate);
function rejectScenario(stage: Run['stage'], opts: ScenarioOptions, expected: RegExp, label: string): void {
  const sc = scenario(stage, opts);
  assertRejectedNoEffect(sc.state, applyScenario(sc), expected, label);
}

test('C09: pass em estágio que exige commit sem expectedCommit é rejeitado (nunca undefined)', () => {
  rejectScenario('build', { op: { expectedCommit: undefined } }, /commit esperado/, 'sem expectedCommit');
});

test('C09: evidência com commit divergente do esperado é rejeitada (diff alterado)', () => {
  // check reexecutado no commit novo; rubrica de requisito ainda presa ao commit velho
  const velho = { commit: 'commit-velho', codeSnapshot: { commit: 'commit-velho', diffFingerprint: 'fp-full-1', capturedAt: '2026-09-19T02:00:00Z', source: 'git-readonly' as const } };
  const novo = { commit: 'commit-novo', codeSnapshot: { commit: 'commit-novo', diffFingerprint: 'fp-full-1', capturedAt: '2026-09-19T02:00:00Z', source: 'git-readonly' as const } };
  rejectScenario('build', {
    rubric: velho, checkEvidence: novo, op: { expectedCommit: 'commit-novo' },
    gate: { currentSnapshot: { commit: 'commit-novo', diffFingerprint: 'fp-full-1' } },
  }, /commit commit-velho obsoleto diante de commit-novo/, 'rubrica no commit velho');
});

test('C09: pass só com evidência de check (sem rubrica de requisito) é rejeitado', () => {
  const only = (opts: ScenarioOptions = {}) => {
    const sc = scenario('build', opts);
    return { ...sc, op: { ...sc.op, evidenceIds: [sc.checks[0].id] } };
  };
  // manifesto com requisito obrigatório: a rubrica que o cobre falta
  const mandatory = only();
  assertRejectedNoEffect(mandatory.state, applyScenario(mandatory), /REQ-1 sem cobertura/, 'só check, obrigatório');
  // sem requisito obrigatório: continua proibido (regra de rubrica própria do estágio)
  const optional = only({ manifest: validManifest({ entries: [{ id: 'REQ-1', stage: 'any', mandatory: false }] }) });
  assertRejectedNoEffect(optional.state, applyScenario(optional), /pass exige rubrica de requisito do estágio/, 'só check, opcional');
});

test('C09: rubrica de review sem file/line é rejeitada', () => {
  rejectScenario('review', { rubric: { file: undefined, line: undefined } }, /file\/line/, 'review sem file/line');
  assert.equal(applyScenario(scenario('review')).result.accepted, true, 'com file/line o mesmo cenário é aceito');
});

test('C09: check obrigatório ausente para o estágio é rejeitado', () => {
  // apenas rubrica, sem check-build aprovado no commit esperado
  rejectScenario('build', { checkEvidence: null }, /check obrigatório 'build' não passou/, 'sem evidência do check');
  // R5-03: check exigido pelo método e ausente da configuração (sem dispensa) também reprova
  rejectScenario('build', { checkEvidence: null, gate: { checks: { required: [], missing: ['build'], exempt: [] } } }, /'build'.*ausente.*sem dispensa explícita/, 'check ausente da configuração');
});

// ---------- C10 — PR integrada e fechamento verificável ----------

const PR = validPrRef();

test('C10: estágio pr sem pullRequest ref é rejeitado; resposta ambígua nunca passa', () => {
  rejectScenario('pr', { op: { pullRequest: undefined } }, /pullRequest/, 'sem PR ref');
});

test('C10: PR com base errada, branch divergente, commit divergente ou url inválida é rejeitada', () => {
  const cases: Array<[string, Partial<typeof PR>, RegExp]> = [
    ['base errada', { base: 'develop' }, /base da PR \(develop\)/],
    ['branch divergente', { branch: 'outra/branch' }, /branch da PR \(outra\/branch\)/],
    ['commit divergente', { commit: 'divergente' }, /commit da PR \(divergente\) diverge do commit esperado/],
    ['url inválida', { url: 'ftp://x' }, /url de PR inválida/],
    ['commit vazio (resposta ambígua)', { commit: '' }, /PR sem commit/],
  ];
  for (const [name, bad, pattern] of cases) {
    rejectScenario('pr', { op: { pullRequest: { ...PR, ...bad } } }, pattern, name);
  }
});

test('C10: PR válida no estágio pr grava run.pullRequest e avança', () => {
  const sc = scenario('pr');
  const out = applyScenario(sc);
  assert.equal(out.result.accepted, true);
  assert.equal(out.state.runs[0].pullRequest?.url, PR.url);
  assert.equal(out.state.runs[0].stage, 'pr-review');
});

test('C10: done de feature sem PR registrada falha; review-only done sem PR é permitido', () => {
  // último estágio do feature (document): sem PR registrada o done é recusado
  rejectScenario('document', { run: { pullRequest: undefined } }, /pullRequest/, 'feature sem PR');
  // com PR registrada, snapshot aprovado e a PR observada agora, o fechamento é permitido
  const accepted = applyScenario(scenario('document'));
  assert.equal(accepted.result.accepted, true);
  assert.equal(accepted.result.status, 'done');
  // review-only conclui sem PR
  const ro = applyScenario(scenario('review', { run: { workflow: 'review-only' } }));
  assert.equal(ro.result.accepted, true);
  assert.equal(ro.result.status, 'done');
});

test('C10: pr-review rejeita quando o commit mudou após a PR registrada', () => {
  // evidências e commit esperado em 'novo'; a PR registrada segue em 'abc'
  const novo = { commit: 'novo', codeSnapshot: { commit: 'novo', diffFingerprint: 'fp-full-1', capturedAt: '2026-09-19T02:00:00Z', source: 'git-readonly' as const } };
  const opts: ScenarioOptions = {
    rubric: novo, checkEvidence: novo, op: { expectedCommit: 'novo' },
    gate: { currentSnapshot: { commit: 'novo', diffFingerprint: 'fp-full-1' }, pullRequest: validObservation({ headSha: 'novo' }) },
  };
  rejectScenario('pr-review', opts, /reconfirme a PR/, 'PR registrada em commit antigo');
  // R5-07: com a PR reconfirmada no commit novo, a mesma conclusão é aceita
  assert.equal(applyScenario(scenario('pr-review', { ...opts, run: { pullRequest: validPrRef({ commit: 'novo' }) } })).result.accepted, true);
});

// R5-07: pr-review exige a PR OBSERVADA agora (aberta, a mesma, head = commit aprovado).
test('C10/R5-07: pr-review recusa PR não observada, fechada, trocada ou com head remoto diferente do commit aprovado', () => {
  const cases: Array<[string, ScenarioOptions, RegExp]> = [
    ['sem observação atual', { gate: { pullRequest: undefined } }, /observação atual da PR/],
    ['sem PR registrada na execução', { run: { pullRequest: undefined } }, /exige pullRequest registrada/],
    ['PR fechada', { gate: { pullRequest: validObservation({ state: 'CLOSED' }) } }, /somente PR aberta/],
    ['PR observada é outra', { gate: { pullRequest: validObservation({ url: 'https://github.com/o/r/pull/77', number: 77 }) } }, /não é a PR registrada/],
    ['base diverge', { gate: { pullRequest: validObservation({ base: 'develop' }) } }, /base da PR observada/],
    ['branch diverge', { gate: { pullRequest: validObservation({ branch: 'outra/branch' }) } }, /branch da PR observada/],
    ['head remoto atrás do commit aprovado (push pendente)', { gate: { pullRequest: validObservation({ headSha: 'antigo' }) } }, /head remoto da PR \(antigo\) diverge do commit aprovado/],
  ];
  for (const [name, opts, pattern] of cases) rejectScenario('pr-review', opts, pattern, name);
});

// ---------- C12 — terminais, bloqueios e replay ----------

test('C12: blockedReason em feature gera blocked com motivo preservado (sem retry silencioso)', () => {
  const run = runAt('build');
  const state = emptyRuntime('p');
  state.sessions.push(session('dev', 't-dev', 'g-dev'), session('planner', 't-planner', 'g-planner'));
  state.runs.push(run);
  const out = applyCompletion(state, { ...passOp(run, undefined, []), result: 'fail', blockedReason: 'dependência externa impossibilita o escopo' });
  assert.equal(out.result.status, 'blocked');
  assert.equal(out.state.runs[0].blockedReason, 'dependência externa impossibilita o escopo');
  // planner notificado do terminal
  const msgs = out.state.messages.filter(m => m.runId === run.runId);
  assert.ok(msgs.some(m => m.type === 'notify' && m.to === 'planner' && /blocked/.test(m.body)));
});

test('C12: replay com operationId de outra execução é recusado', () => {
  const sc = scenario('build', { run: { runId: 'run-A' } });
  const runB = { ...sc.run, runId: 'run-B' };
  sc.state.runs.push(runB);
  const first = applyCompletion(sc.state, { ...sc.op, operationId: 'OP-COMPARTILHADO' }, sc.gate);
  assert.equal(first.result.accepted, true);
  const replayOther = applyCompletion(first.state, { ...sc.op, runId: runB.runId, operationId: 'OP-COMPARTILHADO' }, sc.gate);
  assert.equal(replayOther.result.accepted, false);
  assert.match(replayOther.result.error ?? '', /outra execução/);
  // replay da MESMA execução devolve o resultado anterior, sem nova transição
  const sameRun = applyCompletion(first.state, { ...sc.op, operationId: 'OP-COMPARTILHADO' }, sc.gate);
  assert.deepEqual(sameRun.result, first.result);
  assert.equal(sameRun.deliveries.length, 0);
});

test('C12: terminais exhausted/thrash notificam o planner (nunca task de execução)', () => {
  const exhausted: Run = { runId: 'x2', slug: 'ex2', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'build', revision: 0, attempts: { ...emptyAttempts(), build: 3 }, gapFailures: emptyGapFailures(), status: 'running', history: [] };
  const s1 = emptyRuntime('p');
  s1.sessions.push(session('dev', 't-dev', 'g-dev'), session('planner', 't-planner', 'g-planner'));
  s1.runs.push(exhausted);
  const out1 = applyCompletion(s1, { ...passOp(exhausted, undefined, []), result: 'fail' });
  assert.equal(out1.result.status, 'exhausted');
  const msgs1 = out1.state.messages.filter(m => m.runId === 'x2');
  assert.ok(msgs1.some(m => m.type === 'notify' && m.to === 'planner'));
  assert.ok(msgs1.every(m => m.type === 'notify'), 'terminal nunca gera task de execução');

  const thrashing: Run = { runId: 't2', slug: 'th2', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'review', revision: 0, attempts: emptyAttempts(), gapFailures: { ...emptyGapFailures(), review: { gapId: 'G', count: 1 } }, status: 'running', history: [] };
  const s2 = emptyRuntime('p');
  s2.sessions.push(session('reviewer', 't-rev', 'g-rev'), session('planner', 't-planner', 'g-planner'));
  s2.runs.push(thrashing);
  const completion2 = { ...passOp(thrashing, undefined, []), result: 'fail' as const, gapId: 'G', actor: { role: 'reviewer' as const, threadId: 't-rev', generationId: 'g-rev', projectId: 'p' } };
  const out2 = applyCompletion(s2, completion2);
  assert.equal(out2.result.status, 'thrash');
  const msgs2 = out2.state.messages.filter(m => m.runId === 't2');
  assert.ok(msgs2.some(m => m.type === 'notify' && m.to === 'planner' && /thrash/.test(m.body)));
});

test('C12: planner indisponível no terminal — diagnóstico registrado e entrega recuperável preservada', () => {
  const run = { ...runAt('build'), runId: 'x3', slug: 'ex3', attempts: { ...emptyAttempts(), build: 3 } };
  const state = emptyRuntime('p');
  state.sessions.push(session('dev', 't-dev', 'g-dev')); // sem planner ready
  state.runs.push(run);
  const out = applyCompletion(state, { ...passOp(run, undefined, []), result: 'fail' });
  assert.equal(out.result.status, 'exhausted');
  assert.ok(out.state.events.some(e => e.kind === 'delivery-diagnostic' && /planner/.test(e.detail)));
  const notifyToPlanner = out.state.messages.filter(m => m.runId === run.runId && m.to === 'planner');
  assert.equal(notifyToPlanner.length, 1);
  const delivery = out.state.deliveries.find(d => d.messageId === notifyToPlanner[0].messageId)!;
  assert.equal(delivery.status, 'pending', 'entrega recuperável preservada para dispatch posterior');
});
