import { randomUUID } from 'node:crypto';

export type Role = 'planner' | 'dev' | 'reviewer' | 'tester-e2e' | 'document';
export type Workflow = 'feature' | 'hotfix' | 'review-only';
export type Stage = 'build' | 'review' | 'e2e' | 'pr' | 'pr-review' | 'document';
export type RunStatus = 'running' | 'done' | 'blocked' | 'exhausted' | 'thrash';
export type DeliveryStatus = 'pending' | 'enqueued' | 'received' | 'completed' | 'failed' | 'uncertain';
export type SessionStatus = 'launching' | 'ready' | 'interrupted' | 'closed' | 'unknown';
export type MessageType = 'task' | 'question' | 'answer' | 'notify';

export const ROLES: Role[] = ['planner', 'dev', 'reviewer', 'tester-e2e', 'document'];
export const STAGES: Stage[] = ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'];
export const WORKFLOWS: Workflow[] = ['feature', 'hotfix', 'review-only'];
export const id = (): string => randomUUID();

export interface Actor { role: Role; threadId: string; generationId: string; projectId?: string; }

/** Decisão M0-F2 nº5: estado verificável do código no instante da verificação.
 *  HEAD igual não prova árvore igual: diffFingerprint cobre modificações
 *  rastreadas + staged + untracked relevantes (exclusões só de artefatos
 *  operacionais: .sdlc-codex/, dist/, node_modules/, logs). */
export interface CodeSnapshot {
  commit: string;
  diffFingerprint: string;
  capturedAt: string;
  source: 'git-readonly' | 'launcher-context';
}

/** Decisão M0-F2 nº3: evidência MECÂNICA, produzida pela execução de um check.
 *  Rubrica humana é estrutura separada (RequirementVerdict) que referencia
 *  evidenceIds — nunca se mistura veredito humano com resultado mecânico. */
export interface Evidence {
  id: string;
  requirementId: string;
  result: 'pass' | 'fail' | 'pending';
  procedure: string;
  logPath?: string;
  timestamp: string;
  commit?: string;
  verdict?: string;
  file?: string;
  line?: number;
  runId?: string;
  stage?: Stage;
  projectId?: string;
  /** revisão-alvo da execução (Run.revision quando a evidência pertence a uma run). */
  revision?: number;
  /** produtor/identidade mecânica: quem executou o check. */
  producer?: { role: Role; threadId: string; generationId: string };
  check?: string;
  exitCode?: number;
  logHash?: string;
  /** instante real de produção (distinto de timestamp legado). */
  producedAt?: string;
  codeSnapshot?: CodeSnapshot;
  /** Decisão M0-F2 nº3: importada ≠ produzida; importação NUNCA reescreve
   *  producedAt/runId/stage e não satisfaz gate de check que o produto executa. */
  imported?: boolean;
  importedAt?: string;
  /**
   * R4-03/decisão M0-F2 nº7: evidência carregada de estado v1 (legado) é marcada
   * 'legacy' pela migração na carga. NUNCA se inventa runId/revisão/timestamp para
   * evidência sem proveniência; gate de requisito obrigatório rejeita 'legacy' (M4).
   */
  provenance?: 'legacy';
}

/** Decisão M0-F2 nº4: manifesto estruturado dos IDs de requisitos aprovados.
 *  Gate valida requirementIds contra este manifesto — prefixo slug:stage
 *  arbitrário não prova conformidade. */
export interface RequirementsManifest {
  manifestPath: string;
  planPath: string;
  planHash: string;
  entries: Array<{ id: string; stage: Stage | 'any'; mandatory: boolean }>;
  /** R5-03/M3-F1: dispensa EXPLÍCITA de check canônico, definida ANTES da aprovação
   *  (o manifesto é coberto por hash no registro de aprovação). `checks:{}` na
   *  configuração nunca é dispensa. */
  checkExemptions?: Array<{ workflow: Workflow; stage: Stage; check: string; reason: string }>;
  /** R5-07/M4-F2: diretórios/arquivos (relativos ao projeto) em que o estágio document
   *  pode alterar o repositório depois da revisão final. Regra explícita e aprovada —
   *  nunca exceção por extensão. */
  documentRoots?: string[];
}

/** Rubrica humana: veredito do revisor sobre requisitos, com evidência referenciada. */
export interface RequirementVerdict {
  requirementId: string;
  verdict: 'pass' | 'fail';
  reviewer: { role: Role; threadId: string; generationId: string };
  assessedAt: string;
  evidenceRefs: string[];
  note?: string;
}

/** Decisão M0-F2 nº6: intenção de PR persistida antes de qualquer efeito externo.
 *  Reservada sob lock; lock liberado antes da chamada de rede; reconciliação por
 *  repo/base/branch/commit; timeout após possível aceitação => 'uncertain'. */
export interface PrIntent {
  intentId: string;
  operationId: string;
  runId: string;
  repo: string;
  base: string;
  branch: string;
  headCommit: string;
  snapshot: CodeSnapshot;
  status: 'reserved' | 'executed' | 'confirmed' | 'uncertain' | 'conflict';
  createdAt: string;
  result?: { url?: string; number?: number; checkedAt?: string; detail?: string };
}

/** Decisão M0-F2 nº2: chave semântica de replay — mesmo operationId com payload
 *  diferente é conflito; replay idêntico devolve resultado anterior sem gravação. */
export interface OperationIdentity {
  projectId: string;
  runId: string;
  stage: Stage;
  operationId: string;
  baseRevision: number;
  actor: Actor;
  payloadHash: string;
}
export interface StageCompletion {
  operationId: string;
  runId: string;
  stage: Stage;
  expectedRevision: number;
  actor: Actor;
  result: 'pass' | 'fail';
  evidenceIds: string[];
  gapId?: string;
  blockedReason?: string;
  expectedCommit?: string;
  // C10: referência de PR verificada externamente (cli via GhAdapter) antes da conclusão do estágio pr.
  pullRequest?: PullRequestRef;
}
export interface QueueReceipt { threadId: string; nativeMessageId: string; }
export interface SessionRecord {
  role: Role; threadId?: string; generationId: string; projectId: string; cwd: string;
  paneId?: string; workspaceId?: string; status: SessionStatus; lastEventAt: string;
  requestedModel?: string; requestedEffort?: string; launchToken?: string;
}
export interface Approval {
  intentPath: string; planPath: string; approvedAt: string; approvedBy: string;
  intentHash?: string; planHash?: string; planVersion?: string;
  /** R5-05/M3-F2: manifesto de requisitos coberto pela aprovação (caminho relativo ao
   *  projeto + sha256 do arquivo, registrados ANTES do start). Ausente em runs legados:
   *  eles não passam gate moderno (reaprovação explícita). */
  requirementsManifest?: { path: string; hash: string };
}
export interface PullRequestRef { url: string; base: string; branch: string; commit: string; number?: number; checkedAt: string; }
export interface Run {
  runId: string; slug: string; workflow: Workflow; intentPath: string; planPath: string;
  branch?: string; base?: string; worktree?: string; stage: Stage; revision: number;
  attempts: Record<Stage, number>;
  gapFailures: Partial<Record<Stage, { gapId: string; count: number }>>;
  status: RunStatus; owner?: Role; approval?: Approval;
  blockedReason?: string; pullRequest?: PullRequestRef;
  /** R5-07/M4-F2: snapshot EFETIVAMENTE aprovado pela revisão independente (pr-review);
   *  o fechamento compara o código atual contra ele. */
  approvedSnapshot?: CodeSnapshot;
  /** R5-05: sha256 da configuração efetiva (checks/prBase/protectedPaths) no start; next/check
   *  recusam config trocada no meio do fluxo. Ausente em runs legados. */
  configHash?: string;
  history: Array<{ at: string; stage: Stage; result: string; operationId: string }>;
}
export interface Message {
  messageId: string; projectId: string; runId?: string; from: Role; to: Role;
  targetThreadId: string; targetGenerationId: string; type: MessageType;
  correlationId?: string; stage?: Stage; revision?: number; body: string; createdAt: string;
  linkedTaskMessageId?: string; checkpoint?: string;
}
export interface Delivery {
  deliveryId: string; messageId: string; status: DeliveryStatus; nativeMessageId?: string;
  claimedBy?: string; claimedAt?: string; checkpoint?: string; updatedAt: string;
  claimReleased?: boolean;
}
export interface OperationResult {
  operationId: string;
  accepted: boolean;
  /**
   * R4-03: status discriminado por `accepted` (enum fechado, nunca livre):
   * - accepted=true  => resultado da transição, um RunStatus ('running'|'done'|'blocked'|'exhausted'|'thrash');
   * - accepted=false => 'rejected', com `error` obrigatório.
   */
  status: RunStatus | 'rejected';
  runId?: string;
  revision?: number;
  error?: string;
  /** Decisão M0-F2 nº2: sha256 do pedido canônico (projectId, runId, stage, operationId,
   *  revisão-base, ator, hash de conteúdo) para replay seguro: mesmo operationId +
   *  payloadHash igual => replay devolve resultado anterior; payload diferente => conflito. */
  payloadHash?: string;
  /** R5-11: operação aceita SEM runId/revisão só existe como legado migrado (marcada pela
   *  migração v1); nunca é elegível a replay aceito nem a gate moderno. */
  provenance?: 'legacy';
}
export interface Runtime {
  /** 2 = atual; 1 = legado (aceito apenas para migração validada com backup na carga). */
  schemaVersion: 1 | 2; revision: number; projectId: string; sessions: SessionRecord[];
  runs: Run[]; messages: Message[]; deliveries: Delivery[];
  operations: Record<string, OperationResult>; evidence: Evidence[];
  events: Array<{ at: string; kind: string; detail: string }>;
}

export function emptyRuntime(projectId: string): Runtime {
  return { schemaVersion: 2, revision: 0, projectId, sessions: [], runs: [], messages: [], deliveries: [], operations: {}, evidence: [], events: [] };
}
export function isRole(value: string): value is Role { return (ROLES as string[]).includes(value); }
export function isStage(value: string): value is Stage { return (STAGES as string[]).includes(value); }
export function isWorkflow(value: string): value is Workflow { return (WORKFLOWS as string[]).includes(value); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean { return UUID_RE.test(value); }

function fail(message: string): never { throw new Error(`runtime inválido: ${message}`); }

function checkRecord(value: unknown, path: string, fields: Record<string, (v: unknown) => boolean>): void {
  if (!value || typeof value !== 'object') fail(`${path} deve ser objeto`);
  for (const [key, test] of Object.entries(fields)) {
    const v = (value as Record<string, unknown>)[key];
    if (!test(v)) fail(`${path}.${key} inválido`);
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isOptStr = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';
const isIsoDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isOptIso = (v: unknown): v is string | undefined => v === undefined || isIsoDate(v);
const isOptBool = (v: unknown): v is boolean | undefined => v === undefined || typeof v === 'boolean';
const isIntGte0 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** C03/R4-03: estágios permitidos por workflow (fonte única também usada pelo pipeline). */
const WORKFLOW_STAGES: Record<Workflow, readonly Stage[]> = {
  feature: ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'],
  hotfix: ['build', 'review', 'pr', 'pr-review'],
  'review-only': ['review'],
};
/** R4-03: statuses válidos de execução (reutilizado no enum fechado de OperationResult). */
const RUN_STATUSES: readonly RunStatus[] = ['running', 'done', 'blocked', 'exhausted', 'thrash'];

function checkSession(s: SessionRecord, projectId: string): void {
  checkRecord(s, 'sessions[]', {
    role: (v): v is Role => typeof v === 'string' && isRole(v),
    generationId: (v): v is string => typeof v === 'string' && v.length > 0,
    projectId: isStr,
    cwd: isStr,
    status: (v): v is SessionStatus => ['launching', 'ready', 'interrupted', 'closed', 'unknown'].includes(v as string),
    lastEventAt: isIsoDate,
    threadId: isOptStr, paneId: isOptStr, workspaceId: isOptStr,
    requestedModel: isOptStr, requestedEffort: isOptStr, launchToken: isOptStr,
  });
  if (s.projectId !== projectId) fail(`sessions[] role ${s.role}: projectId divergente do runtime`);
  if (s.threadId !== undefined && !s.threadId.length) fail('sessions[].threadId inválido');
}

function checkRun(r: Run, projectId: string): void {
  void projectId;
  checkRecord(r, 'runs[]', {
    runId: isStr, slug: isStr,
    workflow: (v): v is Workflow => typeof v === 'string' && isWorkflow(v),
    intentPath: isStr, planPath: isStr,
    stage: (v): v is Stage => typeof v === 'string' && isStage(v),
    revision: isIntGte0,
    status: (v): v is RunStatus => typeof v === 'string' && (RUN_STATUSES as string[]).includes(v),
    branch: isOptStr, base: isOptStr, worktree: isOptStr, blockedReason: isOptStr,
  });
  // C03: estágio deve pertencer ao workflow (review-only nunca fica em pr/build etc.)
  if (!WORKFLOW_STAGES[r.workflow].includes(r.stage)) {
    fail(`runs[] ${r.runId}: estágio ${r.stage} incompatível com workflow ${r.workflow}`);
  }
  if (!Array.isArray(r.history)) fail('runs[].history deve ser array');
  for (const h of r.history) {
    checkRecord(h, 'runs[].history[]', { at: isIsoDate, stage: (v): v is Stage => typeof v === 'string' && isStage(v), result: isStr, operationId: isStr });
  }
  if (r.owner !== undefined && !isRole(r.owner)) fail('runs[].owner inválido');

  // C03: attempts e gapFailures são obrigatórios com shapes exatos
  if (r.attempts === undefined || typeof r.attempts !== 'object' || r.attempts === null || Array.isArray(r.attempts)) {
    fail('runs[].attempts deve ser objeto');
  }
  for (const [stage, count] of Object.entries(r.attempts)) {
    if (!isStage(stage)) fail(`runs[].attempts chave inválida: ${stage}`);
    if (!isIntGte0(count)) fail(`runs[].attempts[${stage}] deve ser inteiro >= 0`);
  }
  if (r.gapFailures === undefined || typeof r.gapFailures !== 'object' || r.gapFailures === null || Array.isArray(r.gapFailures)) {
    fail('runs[].gapFailures deve ser objeto');
  }
  for (const [stage, v] of Object.entries(r.gapFailures)) {
    if (!isStage(stage)) fail(`runs[].gapFailures chave inválida: ${stage}`);
    if (v !== undefined) {
      if (typeof v !== 'object' || !v || Array.isArray(v)) fail(`runs[].gapFailures[${stage}] deve ser objeto`);
      const obj = v as Record<string, unknown>;
      if (typeof obj.gapId !== 'string' || !obj.gapId.length) fail(`runs[].gapFailures[${stage}].gapId inválido`);
      if (!isIntGte0(obj.count)) fail(`runs[].gapFailures[${stage}].count inválido`);
    }
  }

  // C03: aprovação completa quando presente
  if (r.approval !== undefined) {
    checkRecord(r.approval, 'runs[].approval', {
      intentPath: isStr, planPath: isStr, approvedAt: isIsoDate, approvedBy: isStr,
      planVersion: isOptStr,
    });
    const a = r.approval as Approval & Record<string, unknown>;
    if (a.intentHash !== undefined && (typeof a.intentHash !== 'string' || !SHA256_RE.test(a.intentHash))) {
      fail('runs[].approval.intentHash deve ser sha256 hex');
    }
    if (a.planHash !== undefined && (typeof a.planHash !== 'string' || !SHA256_RE.test(a.planHash))) {
      fail('runs[].approval.planHash deve ser sha256 hex');
    }
    if (a.planVersion !== undefined && !a.planVersion.length) fail('runs[].approval.planVersion inválido');
    if (a.requirementsManifest !== undefined) {
      checkRecord(a.requirementsManifest, 'runs[].approval.requirementsManifest', { path: isStr, hash: (v): v is string => typeof v === 'string' && SHA256_RE.test(v) });
    }
  }
  if (r.configHash !== undefined && (typeof r.configHash !== 'string' || !SHA256_RE.test(r.configHash))) fail('runs[].configHash deve ser sha256 hex');
  if (r.approvedSnapshot !== undefined) {
    checkRecord(r.approvedSnapshot, 'runs[].approvedSnapshot', {
      commit: isStr, diffFingerprint: isStr, capturedAt: isIsoDate,
      source: (v): v is CodeSnapshot['source'] => v === 'git-readonly' || v === 'launcher-context',
    });
  }

  if (r.pullRequest !== undefined) {
    checkRecord(r.pullRequest, 'runs[].pullRequest', { url: isStr, base: isStr, branch: isStr, commit: isStr, checkedAt: isIsoDate });
    if (r.pullRequest.number !== undefined && !Number.isInteger(r.pullRequest.number)) fail('runs[].pullRequest.number inválido');
  }
}

function checkMessage(m: Message, projectId: string): void {
  checkRecord(m, 'messages[]', {
    messageId: isStr, projectId: isStr, from: (v): v is Role => typeof v === 'string' && isRole(v),
    to: (v): v is Role => typeof v === 'string' && isRole(v),
    targetThreadId: (v): v is string => typeof v === 'string',
    targetGenerationId: (v): v is string => typeof v === 'string',
    type: (v): v is MessageType => ['task', 'question', 'answer', 'notify'].includes(v as string),
    body: (v): v is string => typeof v === 'string' && v.length > 0, createdAt: isIsoDate,
    correlationId: isOptStr, linkedTaskMessageId: isOptStr, checkpoint: isOptStr,
  });
  if (m.projectId !== projectId) fail(`messages[] ${m.messageId}: projectId divergente do runtime`);
  if (m.stage !== undefined && !isStage(m.stage)) fail(`messages[] ${m.messageId}: stage inválido`);
  if (m.revision !== undefined && !isIntGte0(m.revision)) fail(`messages[] ${m.messageId}: revision inválida`);
}

function checkDelivery(d: Delivery, messageIds: Set<string>): void {
  checkRecord(d, 'deliveries[]', {
    deliveryId: isStr, messageId: isStr,
    status: (v): v is DeliveryStatus => ['pending', 'enqueued', 'received', 'completed', 'failed', 'uncertain'].includes(v as string),
    updatedAt: isIsoDate,
    nativeMessageId: isOptStr, claimedBy: isOptStr, checkpoint: isOptStr,
    claimedAt: isOptIso, claimReleased: isOptBool,
  });
  if (!messageIds.has(d.messageId)) fail(`deliveries[] ${d.deliveryId}: messageId sem mensagem`);
  // R4-03/decisão M0-F2 nº8: claim (claimedBy + claimedAt) é trilha obrigatória.
  if ((d.claimedBy === undefined) !== (d.claimedAt === undefined)) {
    fail(`deliveries[] ${d.deliveryId}: claimedBy e claimedAt devem vir em par (identidade + instante)`);
  }
  if (d.status === 'received' || d.status === 'completed') {
    // received requer claimant; completed exige a trilha de conclusão (o claim do recebimento).
    if (d.claimedBy === undefined) fail(`deliveries[] ${d.deliveryId}: ${d.status} exige claim (claimedBy + claimedAt)`);
  } else {
    // pending/enqueued/failed/uncertain: nenhuma reivindicação pode existir; contexto
    // do transporte (nativeMessageId/checkpoint) é preservado, nunca apagado.
    if (d.claimedBy !== undefined) fail(`deliveries[] ${d.deliveryId}: ${d.status} não admite claim`);
    if (d.claimReleased === true) fail(`deliveries[] ${d.deliveryId}: ${d.status} não admite claimReleased`);
  }
}

function checkEvidence(e: Evidence, runIds: Set<string>): void {
  checkRecord(e, 'evidence[]', {
    id: isStr, requirementId: isStr,
    result: (v): v is Evidence['result'] => ['pass', 'fail', 'pending'].includes(v as string),
    procedure: isStr, timestamp: isIsoDate,
    logPath: isOptStr, file: isOptStr, runId: isOptStr,
  });
  if (e.stage !== undefined && !isStage(e.stage)) fail(`evidence[] ${e.id}: stage inválido`);
  if (e.commit !== undefined && typeof e.commit !== 'string') fail(`evidence[] ${e.id}: commit inválido`);
  if (e.verdict !== undefined && !['pass', 'fail'].includes(e.verdict)) fail(`evidence[] ${e.id}: verdict inválido`);
  if (e.line !== undefined && !isIntGte0(e.line)) fail(`evidence[] ${e.id}: line inválida`);
  if (e.runId !== undefined && !runIds.has(e.runId)) fail(`evidence[] ${e.id}: runId sem execução`);
  if (e.provenance !== undefined && e.provenance !== 'legacy') fail(`evidence[] ${e.id}: provenance inválida (somente 'legacy')`);
}

/** S07: Validação runtime completa e estrita. Exige arrays obrigatórios, enums, referências, unicidade e identidade do projeto. */
export function validateRuntime(value: unknown): Runtime {
  if (!value || typeof value !== 'object') fail('não é objeto');
  const r = value as Partial<Runtime>;
  if (r.schemaVersion !== 1 && r.schemaVersion !== 2) fail('schemaVersion deve ser 1 (legado, só para migração) ou 2');
  if (!Number.isInteger(r.revision) || (r.revision as number) < 0) fail('revision deve ser inteiro não negativo');
  if (typeof r.projectId !== 'string' || !r.projectId.length) fail('projectId inválido');
  for (const key of ['sessions', 'runs', 'messages', 'deliveries', 'evidence', 'events'] as const) {
    if (!Array.isArray(r[key])) fail(`${key} deve ser array`);
  }
  if (!r.operations || typeof r.operations !== 'object' || Array.isArray(r.operations)) fail('operations deve ser objeto');

  const projectId = r.projectId as string;
  const sessionKeys = new Set<string>();
  const readyByRole = new Map<string, string>();
  for (const s of r.sessions as SessionRecord[]) {
    checkSession(s, projectId);
    const key = `${s.role}:${s.generationId}:${s.threadId ?? ''}`;
    if (sessionKeys.has(key)) fail(`sessions[] duplicado: ${key}`);
    sessionKeys.add(key);
    // C03: no máximo uma sessão 'ready' por papel (geração vigente única)
    if (s.status === 'ready') {
      const prev = readyByRole.get(s.role);
      if (prev !== undefined) fail(`sessions[]: mais de uma sessão 'ready' para papel ${s.role} (${prev}, ${s.generationId})`);
      readyByRole.set(s.role, s.generationId);
    }
  }

  const runIds = new Set<string>();
  let runningCount = 0;
  for (const run of r.runs as Run[]) {
    checkRun(run, projectId);
    if (runIds.has(run.runId)) fail(`runs[] runId duplicado: ${run.runId}`);
    runIds.add(run.runId);
    if (run.status === 'running') {
      runningCount++;
      // C03: um pipeline ativo por projeto
      if (runningCount > 1) fail(`runs[]: mais de uma execução com status 'running' (${run.runId})`);
    }
  }

  const messageIds = new Set<string>();
  for (const m of r.messages as Message[]) {
    checkMessage(m, projectId);
    if (messageIds.has(m.messageId)) fail(`messages[] messageId duplicado: ${m.messageId}`);
    messageIds.add(m.messageId);
    // C03: runId referenciado deve existir
    if (m.runId !== undefined && !runIds.has(m.runId)) {
      fail(`messages[] ${m.messageId}: runId sem execução (${m.runId})`);
    }
  }

  // R4-03/decisão M0-F2 nº8: relações message -> message (validação pura: rejeita sem escrever).
  const messagesById = new Map((r.messages as Message[]).map(m => [m.messageId, m]));
  for (const m of r.messages as Message[]) {
    if (m.linkedTaskMessageId !== undefined) {
      const linked = messagesById.get(m.linkedTaskMessageId);
      if (!linked) fail(`messages[] ${m.messageId}: linkedTaskMessageId sem mensagem (${m.linkedTaskMessageId})`);
      // R5-11: o vínculo aponta uma TASK (nunca notify/question/answer), de outra
      // mensagem, do mesmo projeto (garantido pelo runtime único) e do MESMO run.
      if (m.type === 'task') fail(`messages[] ${m.messageId}: task não pode carregar linkedTaskMessageId`);
      if (linked.messageId === m.messageId) fail(`messages[] ${m.messageId}: linkedTaskMessageId aponta a própria mensagem`);
      if (linked.type !== 'task') {
        fail(`messages[] ${m.messageId}: linkedTaskMessageId deve apontar uma task (${linked.messageId} é ${linked.type})`);
      }
      if (linked.runId !== m.runId) {
        fail(`messages[] ${m.messageId}: linkedTaskMessageId aponta task de outra execução (${linked.runId ?? 'sem run'} != ${m.runId ?? 'sem run'})`);
      }
    }
    if (m.type === 'answer') {
      // answer referencia a pergunta pelo correlationId (= messageId da question).
      if (!m.correlationId) fail(`messages[] ${m.messageId}: answer exige correlationId da pergunta`);
      const question = messagesById.get(m.correlationId as string);
      if (!question || question.type !== 'question') {
        fail(`messages[] ${m.messageId}: answer sem pergunta correspondente (${m.correlationId})`);
      }
      if (question.to !== m.from) {
        fail(`messages[] ${m.messageId}: pergunta dirigida a ${question.to}; answer vem de ${m.from}`);
      }
      if (question.runId !== undefined && m.runId !== undefined && question.runId !== m.runId) {
        fail(`messages[] ${m.messageId}: pergunta de outra execução (${question.runId} != ${m.runId})`);
      }
    }
  }

  const deliveryIds = new Set<string>();
  const deliveryMessageIds = new Set<string>();
  for (const d of r.deliveries as Delivery[]) {
    checkDelivery(d, messageIds);
    if (deliveryIds.has(d.deliveryId)) fail(`deliveries[] deliveryId duplicado: ${d.deliveryId}`);
    deliveryIds.add(d.deliveryId);
    // R4-03/decisão M0-F2 nº8: uma entrega por messageId.
    if (deliveryMessageIds.has(d.messageId)) fail(`deliveries[]: mais de uma entrega para messageId ${d.messageId}`);
    deliveryMessageIds.add(d.messageId);
  }

  const evidenceIds = new Set<string>();
  for (const e of r.evidence as Evidence[]) {
    checkEvidence(e, runIds);
    if (evidenceIds.has(e.id)) fail(`evidence[] id duplicado: ${e.id}`);
    evidenceIds.add(e.id);
  }

  for (const ev of r.events as Runtime['events']) {
    checkRecord(ev, 'events[]', { at: isIsoDate, kind: (v): v is string => typeof v === 'string' && v.length > 0, detail: (v): v is string => typeof v === 'string' });
  }

  // S07/C03/R4-03: operations com status discriminado por accepted (enum fechado),
  // referências válidas e payloadHash sha256 quando presente (decisão M0-F2 nº2).
  for (const [opId, op] of Object.entries(r.operations)) {
    if (!op || typeof op !== 'object') fail(`operations[${opId}] inválido`);
    const obj = op as OperationResult;
    if (!isStr(obj.operationId) || obj.operationId !== opId) fail(`operations[${opId}].operationId inválido`);
    if (typeof obj.accepted !== 'boolean') fail(`operations[${opId}].accepted inválido`);
    if (obj.accepted) {
      if (!(RUN_STATUSES as string[]).includes(obj.status)) {
        fail(`operations[${opId}]: status '${String(obj.status)}' inválido para operação aceita (esperado RunStatus)`);
      }
    } else {
      if (obj.status !== 'rejected') fail(`operations[${opId}]: status '${String(obj.status)}' inválido para operação recusada (esperado 'rejected')`);
      if (!isStr(obj.error)) fail(`operations[${opId}]: operação recusada exige error descritivo`);
    }
    if (obj.provenance !== undefined && obj.provenance !== 'legacy') fail(`operations[${opId}].provenance inválida (somente 'legacy')`);
    if (obj.runId !== undefined && (typeof obj.runId !== 'string' || !runIds.has(obj.runId))) {
      fail(`operations[${opId}]: runId sem execução`);
    }
    if (obj.revision !== undefined && !isIntGte0(obj.revision)) fail(`operations[${opId}].revision inválido`);
    // R5-11: operação ACEITA moderna exige runId + revisão coerente com a execução; só o
    // legado migrado (provenance 'legacy') pode existir sem elas — nunca elegível a replay.
    // R5-11 (revisão A/F4): 'legacy' só descreve operação SEM identificação completa — a marca não
    // se aplica a operação que possui runId E revisão (só a migração v1 a produz).
    if (obj.provenance === 'legacy' && obj.runId !== undefined && obj.revision !== undefined) {
      fail(`operations[${opId}]: provenance 'legacy' incompatível com operação que já possui runId e revisão`);
    }
    if (obj.accepted && obj.provenance !== 'legacy') {
      if (obj.runId === undefined) fail(`operations[${opId}]: operação aceita exige runId (ou provenance 'legacy' de migração explícita)`);
      if (obj.revision === undefined) fail(`operations[${opId}]: operação aceita exige revisão`);
      const opRun = (r.runs as Run[]).find(x => x.runId === obj.runId)!;
      if ((obj.revision as number) > opRun.revision) {
        fail(`operations[${opId}]: revisão ${obj.revision} incoerente com a execução ${opRun.runId} (revisão atual ${opRun.revision})`);
      }
    }
    if (obj.error !== undefined && typeof obj.error !== 'string') fail(`operations[${opId}].error inválido`);
    if (obj.payloadHash !== undefined && (typeof obj.payloadHash !== 'string' || !SHA256_RE.test(obj.payloadHash))) {
      fail(`operations[${opId}].payloadHash deve ser sha256 hex (decisão M0-F2 nº2)`);
    }
  }

  return value as Runtime;
}