import assert from 'node:assert/strict';
import {
  emptyRuntime, id, type Actor, type Approval, type Evidence, type PullRequestRef, type RequirementsManifest,
  type Role, type Run, type Runtime, type SessionRecord, type Stage, type StageCompletion, type Workflow,
} from '../../src/contracts.js';
import { getRequiredChecks, nextStage, stageOwner } from '../../src/pipeline/workflows.js';
import type { EvidenceGateContext, PrObservation } from '../../src/evidence/report.js';
import type { TransitionResult } from '../../src/pipeline/engine.js';

// R5-03/R5-05/R5-07 — fábricas do caso COMPLETO e VÁLIDO do gate. Cada função gera TODOS
// os fatos exigidos (proveniência da evidência, log verificado, snapshot, manifesto
// aprovado, checks, PR observada, snapshot aprovado). Não há default permissivo: um teste
// de rejeição REMOVE OU ALTERA exatamente um fato por override explícito (`undefined`
// remove o campo) e a asserção fica ligada a esse fato.

export const PROJECT_ID = 'p';
export const SHA_A = 'a'.repeat(64);
/** Hash do arquivo do manifesto: gravado em run.approval e refeito pelo chamador no gate. */
export const MANIFEST_HASH = 'c'.repeat(64);
export const CONFIG_HASH = 'd'.repeat(64);
export const COMMIT = 'abc';
/** Árvore COMPLETA (evidências devem bater com ela) e árvore só de código (approvedSnapshot). */
export const SNAPSHOT = { commit: COMMIT, diffFingerprint: 'fp-full-1' };
export const CODE_SNAPSHOT = { commit: COMMIT, diffFingerprint: 'fp-code-1' };
export const PR_URL = 'https://github.com/o/r/pull/9';
export const BRANCH = 'sdlc/change';
export const BASE = 'main';
export const CAPTURED_AT = '2026-09-19T02:00:00Z';

const ALL_STAGES: Stage[] = ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'];
export const attempts0 = (): Run['attempts'] => Object.fromEntries(ALL_STAGES.map(s => [s, 0])) as Run['attempts'];
export const gaps0 = (): Run['gapFailures'] => Object.fromEntries(ALL_STAGES.map(s => [s, undefined])) as Run['gapFailures'];

export const threadOf = (role: Role): string => `t-${role}`;
export const generationOf = (role: Role): string => `g-${role}`;
export const actorFor = (role: Role): Actor => ({ role, threadId: threadOf(role), generationId: generationOf(role), projectId: PROJECT_ID });

/** Time completo, todas as sessões ready (planner incluso). */
export function validSessions(): SessionRecord[] {
  return (['planner', 'dev', 'reviewer', 'tester-e2e', 'document'] as Role[]).map(role => ({
    role, threadId: threadOf(role), generationId: generationOf(role), projectId: PROJECT_ID,
    cwd: 'c', status: 'ready' as const, lastEventAt: CAPTURED_AT,
  }));
}

export function validManifest(over: Partial<RequirementsManifest> = {}): RequirementsManifest {
  return {
    manifestPath: '.sdlc-codex/requirements.json', planPath: 'plan.md', planHash: 'b'.repeat(64),
    entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }],
    ...over,
  };
}

/** Aprovação completa, com o manifesto coberto por hash (R5-05). */
export function validApproval(over: Partial<Approval> = {}): Approval {
  return {
    intentPath: 'intent.md', planPath: 'plan.md', approvedAt: '2026-09-19T00:00:00Z', approvedBy: 'humano',
    intentHash: SHA_A, planHash: SHA_A, planVersion: 'v1',
    requirementsManifest: { path: '.sdlc-codex/requirements.json', hash: MANIFEST_HASH },
    ...over,
  };
}

export function validPrRef(over: Partial<PullRequestRef> = {}): PullRequestRef {
  return { url: PR_URL, base: BASE, branch: BRANCH, commit: COMMIT, checkedAt: '2026-09-19T04:00:00Z', number: 9, ...over };
}

const isFinalStage = (workflow: Workflow, stage: Stage): boolean => !nextStage(workflow, stage);
/** pr-review e o fechamento (último estágio) de feature/hotfix exigem PR registrada e observada. */
const needsPullRequest = (workflow: Workflow, stage: Stage): boolean =>
  workflow !== 'review-only' && (stage === 'pr-review' || isFinalStage(workflow, stage));

/**
 * Run posicionado em `stage` com tudo o que o fluxo já teria produzido até ali: aprovação com
 * manifesto, configHash, PR registrada (pr-review/fechamento) e snapshot aprovado (document).
 */
export function validRun(stage: Stage, over: Partial<Run> = {}): Run {
  const workflow = over.workflow ?? 'feature';
  return {
    runId: 'run-1', slug: 'change', workflow, intentPath: 'intent.md', planPath: 'plan.md',
    branch: BRANCH, base: BASE, stage, revision: 1,
    attempts: attempts0(), gapFailures: gaps0(), status: 'running', history: [],
    approval: validApproval(), configHash: CONFIG_HASH,
    ...(needsPullRequest(workflow, stage) ? { pullRequest: validPrRef() } : {}),
    ...(workflow !== 'review-only' && stage === 'document'
      ? { approvedSnapshot: { ...CODE_SNAPSHOT, capturedAt: CAPTURED_AT, source: 'git-readonly' as const } } : {}),
    owner: stageOwner[stage],
    ...over,
  };
}

/** Rubrica humana do estágio (produtor = proprietário do estágio), com proveniência completa. */
export function validEvidence(run: Run, over: Partial<Evidence> = {}): Evidence {
  const role = stageOwner[run.stage];
  return {
    id: id(), requirementId: `${run.slug}:${run.stage}:REQ-1`, result: 'pass', procedure: 'rubrica humana do estágio',
    logPath: 'logs/rubrica.log', logHash: SHA_A, timestamp: CAPTURED_AT, producedAt: CAPTURED_AT,
    commit: COMMIT, verdict: 'pass', file: 'src/a.ts', line: 1,
    runId: run.runId, stage: run.stage, projectId: PROJECT_ID, revision: run.revision,
    producer: { role, threadId: threadOf(role), generationId: generationOf(role) },
    codeSnapshot: { ...SNAPSHOT, capturedAt: CAPTURED_AT, source: 'git-readonly' },
    ...over,
  };
}

/** Evidência MECÂNICA (produzida pelo comando `check` do produto): sem producer, não importada. */
export function validCheckEvidence(run: Run, name: string, over: Partial<Evidence> = {}): Evidence {
  return validEvidence(run, {
    requirementId: `${run.slug}:${run.stage}:check-${name}`, procedure: `check ${name}`,
    logPath: `logs/${name}.log`, check: name, exitCode: 0,
    producer: undefined, file: undefined, line: undefined,
    ...over,
  });
}

export function validObservation(over: Partial<PrObservation> = {}): PrObservation {
  return { url: PR_URL, number: 9, state: 'OPEN', base: BASE, branch: BRANCH, headSha: COMMIT, observedAt: '2026-09-19T05:00:00Z', ...over };
}

/**
 * Gate COMPLETO para `run`: manifesto + hash, snapshots, seleção de checks (required do
 * método, nada faltando/dispensado), todos os logs das evidências verificados e, quando o
 * estágio pede, a PR observada e a relação de commit.
 */
export function validGate(run: Run, evidence: Evidence[], over: Partial<EvidenceGateContext> = {}): EvidenceGateContext {
  return {
    manifest: validManifest(), manifestHash: MANIFEST_HASH,
    currentSnapshot: { ...SNAPSHOT }, currentCodeSnapshot: { ...CODE_SNAPSHOT },
    checks: { required: getRequiredChecks(run.workflow, run.stage), missing: [], exempt: [] },
    verifiedLogs: evidence.filter(e => e.logHash !== undefined).map(e => e.id),
    ...(needsPullRequest(run.workflow, run.stage) ? { pullRequest: validObservation() } : {}),
    ...(run.workflow !== 'review-only' && isFinalStage(run.workflow, run.stage) && run.stage !== 'pr-review'
      ? { commitRelation: 'same' as const } : {}),
    ...over,
  };
}

export function validOp(run: Run, evidenceIds: string[], over: Partial<StageCompletion> = {}): StageCompletion {
  return {
    operationId: id(), runId: run.runId, stage: run.stage, expectedRevision: run.revision,
    actor: actorFor(stageOwner[run.stage]), result: 'pass', evidenceIds, expectedCommit: COMMIT,
    ...(run.stage === 'pr' ? { pullRequest: validPrRef() } : {}),
    ...over,
  };
}

export interface Scenario {
  state: Runtime; run: Run; rubric: Evidence; checks: Evidence[]; more: Evidence[]; op: StageCompletion; gate: EvidenceGateContext;
}
export interface ScenarioOptions {
  run?: Partial<Run>;
  /** overrides da rubrica humana (a op referencia SOMENTE ela, como o `next` real faz). */
  rubric?: Partial<Evidence>;
  /** overrides da evidência mecânica de cada check exigido; `null` = nenhuma evidência de check no estado. */
  checkEvidence?: Partial<Evidence> | null;
  /** rubricas humanas ADICIONAIS do estágio (a op as referencia junto da primeira). */
  moreRubrics?: Array<Partial<Evidence>>;
  /** checks ADICIONAIS (além dos exigidos pelo método, ex.: lint) com evidência mecânica válida. */
  moreChecks?: string[];
  manifest?: RequirementsManifest;
  gate?: Partial<EvidenceGateContext>;
  op?: Partial<StageCompletion>;
}

/**
 * O caso de sucesso completo de `stage`: estado com o time inteiro, rubrica + evidência de cada
 * check exigido, op de pass, e o gate completo. `applyCompletion(sc.state, sc.op, sc.gate)`
 * é aceito; cada teste de falha altera UM fato por opção.
 */
export function scenario(stage: Stage, opts: ScenarioOptions = {}): Scenario {
  const run = validRun(stage, opts.run);
  const rubric = validEvidence(run, opts.rubric);
  const checks = opts.checkEvidence === null
    ? []
    : getRequiredChecks(run.workflow, stage).map(name => validCheckEvidence(run, name, opts.checkEvidence ?? {}));
  const more = (opts.moreRubrics ?? []).map(over => validEvidence(run, over));
  const extraChecks = (opts.moreChecks ?? []).map(name => validCheckEvidence(run, name));
  const state = emptyRuntime(PROJECT_ID);
  state.sessions.push(...validSessions());
  state.runs.push(run);
  state.evidence.push(rubric, ...checks, ...extraChecks, ...more);
  const gate = validGate(run, state.evidence, { ...(opts.manifest ? { manifest: opts.manifest } : {}), ...opts.gate });
  return { state, run, rubric, checks: [...checks, ...extraChecks], more, op: validOp(run, [rubric.id, ...more.map(e => e.id)], opts.op), gate };
}

const stripOperations = (state: Runtime): unknown => ({ ...state, operations: {}, revision: 0 });

/**
 * R5 — rejeição de gate: mensagem específica, estágio/revisão/estado da run preservados,
 * nenhuma evidência/task/entrega criada; só o registro da operação recusada (idempotência).
 */
export function assertRejectedNoEffect(before: Runtime, out: TransitionResult, expected: RegExp, label = ''): void {
  const at = label ? ` [${label}]` : '';
  assert.equal(out.result.accepted, false, `deveria rejeitar${at}`);
  assert.equal(out.result.status, 'rejected', `status rejected${at}`);
  assert.match(out.result.error ?? '', expected, `mensagem específica${at}: ${out.result.error}`);
  assert.deepEqual(out.state.runs, before.runs, `estágio/revisão/histórico da run preservados${at}`);
  assert.deepEqual(out.state.evidence, before.evidence, `nenhuma evidência adicionada${at}`);
  assert.deepEqual(out.state.messages, before.messages, `nenhuma task/notify criada${at}`);
  assert.deepEqual(out.state.deliveries, before.deliveries, `nenhuma entrega/outbox criada${at}`);
  assert.equal(out.deliveries.length, 0, `nenhuma entrega retornada${at}`);
  assert.deepEqual(stripOperations(out.state), stripOperations(before), `estado inalterado exceto o registro da operação recusada${at}`);
}
