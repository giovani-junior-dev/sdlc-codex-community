import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRuntime, type PrIntent, type Runtime } from '../../src/contracts.js';
import { appendPrIntent, blockingPrIntents, findActivePrIntent, latestPrIntent, reducePrIntents, PrLedgerError, PR_INTENT_RESERVED, PR_INTENT_UPDATED } from '../../src/pipeline/pr-intents.js';
import { requiredChecks, validateCheckExemptions } from '../../src/evidence/checks.js';
import { validateRequirementsManifest, validateGateContext, validateManifestAgainstPlan } from '../../src/evidence/report.js';
import { validateCompletion } from '../../src/pipeline/engine.js';
import { getRequiredChecks as getCanonical } from '../../src/pipeline/workflows.js';

// ---------- R5-08/M4-F1 — ledger reduzido ----------

const snap = { commit: 'c1', diffFingerprint: 'f1', capturedAt: '2026-01-01T00:00:00Z', source: 'git-readonly' as const };
const intent = (operationId: string, status: PrIntent['status'], over: Partial<PrIntent> = {}): PrIntent => ({
  intentId: operationId, operationId, runId: 'run-1', repo: 'git@x:y.git', base: 'main', branch: 'sdlc/x', headCommit: 'c1',
  snapshot: snap, status, createdAt: '2026-01-01T00:00:00Z', ...over,
});
const ev = (i: PrIntent, kind = i.status === 'reserved' ? PR_INTENT_RESERVED : PR_INTENT_UPDATED) => ({ at: '2026-01-01T00:00:00Z', kind, detail: JSON.stringify(i) });
const stateWith = (...events: Array<ReturnType<typeof ev>>): Runtime => ({ ...emptyRuntime('p'), events });

test('R5-08 reserved→executed→confirmed reduz para confirmed e NÃO deixa intenção ativa', () => {
  const s = stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', 'executed')), ev(intent('op1', 'confirmed')));
  assert.equal(latestPrIntent(s, 'op1')?.status, 'confirmed');
  assert.deepEqual(blockingPrIntents(s, 'run-1'), []);
  assert.equal(findActivePrIntent(s, 'run-1'), undefined);
});

test('R5-08 eventos intercalados de dois operationIds reduzem independentemente', () => {
  const s = stateWith(
    ev(intent('op1', 'reserved')), ev(intent('op2', 'reserved')),
    ev(intent('op1', 'executed')), ev(intent('op1', 'confirmed')), ev(intent('op2', 'executed')),
  );
  assert.equal(reducePrIntents(s).get('op1')?.status, 'confirmed');
  assert.equal(reducePrIntents(s).get('op2')?.status, 'executed');
  assert.deepEqual(blockingPrIntents(s, 'run-1', 'op1').map(i => i.operationId), ['op2']);
  assert.deepEqual(blockingPrIntents(s, 'run-1', 'op2'), [], 'op1 confirmed não bloqueia');
});

test('R5-08 uncertain, conflict, executed e reserved BLOQUEIAM novo efeito; confirmed não', () => {
  for (const status of ['reserved', 'executed', 'uncertain', 'conflict'] as const) {
    const events = status === 'reserved' ? [ev(intent('op1', 'reserved'))]
      : status === 'conflict' || status === 'uncertain' || status === 'executed'
        ? [ev(intent('op1', 'reserved')), ev(intent('op1', status))] : [];
    assert.equal(blockingPrIntents(stateWith(...events), 'run-1', 'op2').length, 1, `${status} bloqueia`);
  }
  assert.equal(blockingPrIntents(stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', 'executed')), ev(intent('op1', 'confirmed'))), 'run-1', 'op2').length, 0);
});

test('R5-08 intenções de OUTRA execução não bloqueiam esta', () => {
  const s = stateWith(ev(intent('op1', 'reserved', { runId: 'run-A' })));
  assert.deepEqual(blockingPrIntents(s, 'run-B'), []);
});

test('R5-08 uncertain e conflict só saem por confirmed (reconciliação por leitura)', () => {
  for (const from of ['uncertain', 'conflict'] as const) {
    const s = stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', from)), ev(intent('op1', 'confirmed')));
    assert.equal(latestPrIntent(s, 'op1')?.status, 'confirmed');
  }
});

test('R5-08 evento de PR com JSON inválido falha fechado (nunca é ignorado)', () => {
  const s = stateWith({ at: '2026-01-01T00:00:00Z', kind: PR_INTENT_UPDATED, detail: '{not json' });
  assert.throws(() => blockingPrIntents(s, 'run-1'), PrLedgerError);
  assert.throws(() => latestPrIntent(s, 'op1'), /JSON inválido/);
});

test('R5-08 evento sem campos obrigatórios ou com status inválido falha fechado', () => {
  assert.throws(() => reducePrIntents(stateWith({ at: 'x', kind: PR_INTENT_RESERVED, detail: JSON.stringify({ operationId: 'op1', status: 'reserved' }) })), PrLedgerError);
  assert.throws(() => reducePrIntents(stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', 'inventado' as PrIntent['status'])))), /status inválido/);
});

test('R5-08 transição fora de ordem falha fechado (confirmed→executed, updated sem reserva, reserved-kind com status errado)', () => {
  assert.throws(() => reducePrIntents(stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', 'executed')), ev(intent('op1', 'confirmed')), ev(intent('op1', 'executed')))), /transição inválida confirmed → executed/);
  assert.throws(() => reducePrIntents(stateWith(ev(intent('op9', 'executed')))), /sem reserva anterior/);
  assert.throws(() => reducePrIntents(stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', 'confirmed')))), /transição inválida reserved → confirmed/);
  assert.throws(() => reducePrIntents(stateWith({ at: 'x', kind: PR_INTENT_RESERVED, detail: JSON.stringify(intent('op1', 'executed')) })), /esperado reserved/);
});

test('R5-08 identidade (run/repo/base/branch/commit) alterada entre eventos falha fechado', () => {
  assert.throws(() => reducePrIntents(stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', 'executed', { branch: 'outra' })))), /identidade/);
});

test('R5-08 re-reserva do MESMO operationId após crash é permitida (reserved→reserved)', () => {
  const s = stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', 'reserved')));
  assert.equal(latestPrIntent(s, 'op1')?.status, 'reserved');
});

test('R5-08 appendPrIntent recusa gravar transição inválida (nada é anexado)', () => {
  const s = stateWith(ev(intent('op1', 'reserved')), ev(intent('op1', 'executed')), ev(intent('op1', 'confirmed')));
  assert.throws(() => appendPrIntent(s, intent('op1', 'executed'), PR_INTENT_UPDATED), PrLedgerError);
  const ok = appendPrIntent(stateWith(), intent('op2', 'reserved'), PR_INTENT_RESERVED);
  assert.equal(ok.events.length, 1);
});

// ---------- R5-03/M3-F1 — política única (tabela workflow × estágio × configuração) ----------

const cmd = { executable: 't', args: ['x'] };
const FULL = { build: cmd, lint: cmd, unit: cmd, e2e: cmd };

test('R5-03 tabela feature: obrigação vem do MÉTODO, não da presença do comando na config', () => {
  const stages = ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'] as const;
  const expected: Record<string, string[]> = { build: ['build'], review: ['unit'], e2e: ['e2e'], pr: ['build'], 'pr-review': ['unit'], document: ['build'] };
  for (const stage of stages) {
    const empty = requiredChecks({}, 'feature', stage);
    assert.deepEqual(empty.missing, expected[stage], `checks:{} em ${stage} => missing (nunca dispensa)`);
    assert.deepEqual(empty.required, []);
    assert.deepEqual(empty.exempt, []);
    assert.equal(empty.notApplicable, false);
    const full = requiredChecks(FULL, 'feature', stage);
    assert.deepEqual(full.missing, []);
    assert.ok(expected[stage].every(n => full.required.includes(n)));
  }
});

test('R5-03 tabela hotfix e review-only', () => {
  assert.deepEqual(requiredChecks({}, 'hotfix', 'build').missing, ['build']);
  assert.deepEqual(requiredChecks({}, 'hotfix', 'review').missing, ['unit']);
  assert.deepEqual(requiredChecks({}, 'hotfix', 'pr').missing, ['build']);
  assert.deepEqual(requiredChecks({}, 'hotfix', 'pr-review').missing, ['unit']);
  for (const stage of ['review', 'pr-review', 'build'] as const) {
    const ro = requiredChecks({}, 'review-only', stage);
    assert.equal(ro.notApplicable, true, 'o MÉTODO não exige check em review-only');
    assert.deepEqual(ro.missing, []);
  }
});

test('R5-03 configuração parcial e lint falhando/ausente', () => {
  const partial = requiredChecks({ build: cmd }, 'feature', 'build');
  assert.deepEqual(partial.required, ['build']);
  assert.deepEqual(partial.missing, []);
  assert.deepEqual(requiredChecks({ build: cmd, lint: cmd }, 'feature', 'build').required, ['build', 'lint'], 'lint configurado passa a ser exigido');
  assert.deepEqual(requiredChecks({ build: cmd }, 'feature', 'build').missing, [], 'lint ausente não é obrigação do método');
});

test('R5-03 dispensa explícita aprovada retira SÓ o check dispensado, com motivo; inválida é rejeitada', () => {
  const ex = [{ workflow: 'feature' as const, stage: 'e2e' as const, check: 'e2e', reason: 'sem UI' }];
  const sel = requiredChecks({ build: cmd }, 'feature', 'e2e', ex);
  assert.deepEqual(sel.missing, []);
  assert.deepEqual(sel.exempt, [{ check: 'e2e', reason: 'sem UI' }]);
  assert.deepEqual(requiredChecks({ build: cmd }, 'feature', 'build', ex).missing, [], 'outras etapas intactas');
  assert.deepEqual(requiredChecks({}, 'feature', 'build', ex).missing, ['build'], 'dispensa de e2e não dispensa build');
  assert.deepEqual(validateCheckExemptions(ex), []);
  assert.match(validateCheckExemptions([{ workflow: 'feature', stage: 'build', check: 'unit', reason: 'x' }])[0], /não exige/);
  assert.match(validateCheckExemptions([{ workflow: 'hotfix', stage: 'e2e', check: 'e2e', reason: 'x' }])[0], /não pertence/);
  assert.match(validateCheckExemptions([{ workflow: 'feature', stage: 'e2e', check: 'e2e', reason: ' ' }])[0], /motivo/);
  assert.match(validateCheckExemptions([{ workflow: 'review-only', stage: 'review', check: 'unit', reason: 'x' }])[0], /não exige/, 'nada a dispensar em review-only');
});

// ---------- R5-05 — manifesto e gate incompleto ----------

const SHA = 'a'.repeat(64);
const manifest = (over: Record<string, unknown> = {}) => ({ manifestPath: 'm.json', planPath: 'p.md', planHash: SHA, entries: [{ id: 'REQ-1', stage: 'any' as const, mandatory: true }], ...over });

test('R5-05 manifesto: IDs duplicados (mesmo idênticos), vazio e raízes documentais inseguras são inválidos', () => {
  assert.deepEqual(validateRequirementsManifest(manifest()), []);
  assert.match(validateRequirementsManifest(manifest({ entries: [{ id: 'A', stage: 'any', mandatory: true }, { id: 'A', stage: 'any', mandatory: true }] })).join(';'), /duplicado/);
  assert.match(validateRequirementsManifest(manifest({ entries: [] })).join(';'), /vazio/);
  for (const bad of ['../fora', '/abs', 'C:/x', '.git/x', '.sdlc-codex', '', 'a/../b']) {
    assert.match(validateRequirementsManifest(manifest({ documentRoots: [bad] })).join(';'), /documentRoots/, bad);
  }
  assert.deepEqual(validateRequirementsManifest(manifest({ documentRoots: ['docs/features', 'CHANGELOG.md'] })), []);
});

test('R5-05 manifesto pertence ao plano aprovado: outro plano, outro hash e ID fora do texto do plano', () => {
  const same = (a: string, b: string) => a === b;
  const m = manifest({ entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }, { id: 'REQ-2', stage: 'any', mandatory: false }] });
  assert.deepEqual(validateManifestAgainstPlan(m, { planPath: 'p.md', planHash: SHA, planText: 'REQ-1 e REQ-2' }, same), []);
  assert.match(validateManifestAgainstPlan(m, { planPath: 'q.md', planHash: SHA, planText: 'REQ-1 REQ-2' }, same).join(';'), /outro plano/);
  assert.match(validateManifestAgainstPlan(m, { planPath: 'p.md', planHash: 'b'.repeat(64), planText: 'REQ-1 REQ-2' }, same).join(';'), /hash diferente/);
  assert.match(validateManifestAgainstPlan(m, { planPath: 'p.md', planHash: SHA, planText: 'apenas REQ-1' }, same).join(';'), /REQ-2.*não consta/);
  assert.match(validateManifestAgainstPlan(m, { planPath: 'p.md', planHash: SHA, planText: 'REQ-10 e REQ-1x REQ-2' }, same).join(';'), /REQ-1.*não consta/, 'ID é token completo, não prefixo');
});

test('R5-05 validateGateContext: cada fato obrigatório ausente é erro (gate incompleto nunca desativa requisito)', () => {
  const full = {
    manifest: manifest(), manifestHash: SHA,
    currentSnapshot: { commit: 'c', diffFingerprint: 'f' }, currentCodeSnapshot: { commit: 'c', diffFingerprint: 'f' },
    checks: { required: ['build'], missing: [], exempt: [] }, verifiedLogs: [],
  };
  assert.deepEqual(validateGateContext(full), []);
  assert.match(validateGateContext(undefined).join(';'), /ausente/);
  for (const key of ['manifest', 'manifestHash', 'currentSnapshot', 'currentCodeSnapshot', 'checks', 'verifiedLogs']) {
    const partial = { ...full } as Record<string, unknown>;
    delete partial[key];
    assert.ok(validateGateContext(partial).length > 0, `sem ${key} => erro`);
  }
  assert.ok(validateGateContext({ ...full, checks: { required: ['build'] } }).length > 0, 'só required (sem missing/exempt) é proibido');
});

test('R5-05 engine: pass com gate ausente ou incompleto é REJEITADO (chamada direta, sem CLI)', () => {
  const s = emptyRuntime('p');
  s.sessions = [{ role: 'dev', threadId: 't', generationId: 'g', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: '2026-01-01T00:00:00Z' }];
  s.runs = [{
    runId: 'r1', slug: 's', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'build', revision: 0, status: 'running', owner: 'dev',
    attempts: { build: 0, review: 0, e2e: 0, pr: 0, 'pr-review': 0, document: 0 }, gapFailures: {}, history: [],
  }];
  const op = { operationId: 'o', runId: 'r1', stage: 'build' as const, expectedRevision: 0, actor: { role: 'dev' as const, threadId: 't', generationId: 'g' }, result: 'pass' as const, evidenceIds: ['e'], expectedCommit: 'c' };
  const r1 = validateCompletion(s, op);
  assert.equal(r1.ok, false);
  assert.match((r1 as { error: string }).error, /gate/i);
  const r2 = validateCompletion(s, op, { manifest: manifest() } as never);
  assert.equal(r2.ok, false);
  assert.match((r2 as { error: string }).error, /gate incompleto/i);
});

// Revisão B/B2 — o motor NÃO confia na seleção de checks do chamador: recalcula a política do método.
test('R5-03 (revisão B/B2) gate com checks MENTIROSOS ({required:[],missing:[],exempt:[]}) é rejeitado pelo motor, em todo estágio com check', () => {
  for (const [workflow, stage] of [['feature', 'build'], ['feature', 'review'], ['feature', 'e2e'], ['feature', 'pr-review'], ['hotfix', 'build']] as const) {
    const s = emptyRuntime('p');
    s.sessions = [
      { role: 'dev', threadId: 't', generationId: 'g', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: '2026-01-01T00:00:00Z' },
      { role: 'reviewer', threadId: 't', generationId: 'g', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: '2026-01-01T00:00:00Z' },
      { role: 'tester-e2e', threadId: 't', generationId: 'g', projectId: 'p', cwd: 'c', status: 'ready', lastEventAt: '2026-01-01T00:00:00Z' },
    ];
    const owner = ({ build: 'dev', review: 'reviewer', e2e: 'tester-e2e', 'pr-review': 'reviewer' } as const)[stage as 'build'];
    s.runs = [{
      runId: 'r1', slug: 's', workflow, intentPath: 'i', planPath: 'p', stage, revision: 0, status: 'running', owner,
      attempts: { build: 0, review: 0, e2e: 0, pr: 0, 'pr-review': 0, document: 0 }, gapFailures: {}, history: [],
      approval: { intentPath: 'i', planPath: 'p', approvedAt: '2026-01-01T00:00:00Z', approvedBy: 'h', intentHash: SHA, planHash: SHA, planVersion: 'v', requirementsManifest: { path: 'm.json', hash: SHA } },
    }];
    const gate = {
      manifest: manifest(), manifestHash: SHA,
      currentSnapshot: { commit: 'c', diffFingerprint: 'f' }, currentCodeSnapshot: { commit: 'c', diffFingerprint: 'f' },
      checks: { required: [], missing: [], exempt: [] }, verifiedLogs: [],
    };
    const op = { operationId: 'o', runId: 'r1', stage, expectedRevision: 0, actor: { role: owner, threadId: 't', generationId: 'g' }, result: 'pass' as const, evidenceIds: ['e'], expectedCommit: 'c' };
    const r = validateCompletion(s, op, gate);
    assert.equal(r.ok, false, `${workflow}/${stage}`);
    assert.match((r as { error: string }).error, /não cobre a política do método/, `${workflow}/${stage}`);
    // dispensa que NÃO consta no manifesto aprovado também é recusada
    const claimed = validateCompletion(s, op, { ...gate, checks: { required: [], missing: [], exempt: [{ check: getCanonical(workflow, stage)[0], reason: 'inventada' }] } });
    assert.equal(claimed.ok, false);
    assert.match((claimed as { error: string }).error, /não consta no manifesto aprovado/);
  }
});
