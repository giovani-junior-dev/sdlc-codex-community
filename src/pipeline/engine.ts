import { id, type Delivery, type Message, type OperationResult, type PullRequestRef, type Role, type Run, type RunStatus, type Runtime, type StageCompletion } from '../contracts.js';
import { nextStage, stageOwner, workflowStages, getRequiredChecks, stageRequiresCommit } from './workflows.js';
import { validateStageEvidence, validateGateContext, type EvidenceGateContext } from '../evidence/report.js';
import { validateCheckExemptions } from '../evidence/checks.js';

export interface TransitionResult { state: Runtime; result: OperationResult; deliveries: Delivery[]; }
/** M6-F2 — contexto externo da aplicação: payloadHash semântico do pedido
 *  (decisão M0-F2 nº2), gravado em OperationResult para replay seguro. */
export interface ApplyContext { payloadHash?: string; }
const now = () => new Date().toISOString();
const SHA256_RE = /^[0-9a-f]{64}$/i;
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/**
 * C08 — início de execução só com aprovação PREVIAMENTE vinculada e time completo.
 * O engine valida presença, formato e consistência interna da aprovação (a
 * conferência dos hashes contra o conteúdo dos arquivos é do cli, que gravou
 * os hashes ao montar o run). Nunca preenchemos vínculos ausentes para tornar
 * válida uma aprovação desvinculada.
 * Reuso de slug após terminal: runs históricos permanecem auditáveis e NÃO
 * impedem nova execução com o mesmo slug; o que não pode é haver duas running
 * (revalidado aqui dentro, sob o lock da gravação — de startRuns concorrentes
 * um só vence). Buscas por slug no cli consideram somente running.
 */
export function startRun(state: Runtime, run: Run): Runtime {
  if (!workflowStages[run.workflow]) throw new Error('workflow inválido');
  if (!workflowStages[run.workflow].includes(run.stage)) throw new Error('estágio inicial não pertence ao workflow');
  const approval = run.approval;
  if (!approval) throw new Error('execução exige aprovação registrada');
  if (!approval.intentHash || !SHA256_RE.test(approval.intentHash)) {
    throw new Error('aprovação sem intentHash sha256; aprovação desvinculada não inicia execução');
  }
  if (!approval.planHash || !SHA256_RE.test(approval.planHash)) {
    throw new Error('aprovação sem planHash sha256; aprovação desvinculada não inicia execução');
  }
  if (!approval.planVersion?.trim()) throw new Error('aprovação sem planVersion; vínculo de versão do plano é obrigatório');
  // R5-05: execução NOVA só inicia com manifesto coberto pela aprovação; nunca modo legado silencioso.
  if (!approval.requirementsManifest?.hash || !SHA256_RE.test(approval.requirementsManifest.hash) || !approval.requirementsManifest.path) {
    throw new Error('aprovação sem manifesto de requisitos (caminho + sha256); execução nova exige manifesto coberto pela aprovação');
  }
  if (!run.configHash || !SHA256_RE.test(run.configHash)) throw new Error('execução exige configHash (config aprovada no start)');
  if (norm(approval.intentPath) !== norm(run.intentPath)) throw new Error('aprovação vinculada a outro intentPath');
  if (norm(approval.planPath) !== norm(run.planPath)) throw new Error('aprovação vinculada a outro planPath');
  if (!approval.approvedBy?.trim()) throw new Error('aprovação sem approvedBy');
  if (Number.isNaN(Date.parse(approval.approvedAt))) throw new Error('aprovação com approvedAt inválido');
  // C08: time completo na transação de start (incl. planner, que supervisiona).
  const requiredRoles: Role[] = [...new Set<Role>([...workflowStages[run.workflow].map(s => stageOwner[s]), 'planner'])];
  for (const role of requiredRoles) {
    const session = state.sessions.find(s => s.role === role && s.projectId === state.projectId && s.status === 'ready' && s.threadId);
    if (!session) throw new Error(`participante ${role} não registrado/ready; time incompleto não inicia execução`);
  }
  if (state.runs.some(r => r.status === 'running')) throw new Error('já existe uma execução ativa neste projeto');
  if (state.runs.some(r => r.runId === run.runId)) throw new Error('runId duplicado');
  return { ...state, runs: [...state.runs, run] };
}

/** Próximo estágio após falha que admite correção: review/e2e/pr-review voltam ao build (feature E hotfix). */
function correctionStage(run: Run): Run['stage'] {
  if (['review', 'e2e', 'pr-review'].includes(run.stage) && run.workflow !== 'review-only') return 'build';
  return run.stage;
}

/**
 * R13 — tabela completa:
 * - feature: build→review→e2e→pr→pr-review→document→done; fail em review/e2e/pr-review volta a build; fail em build/pr/document repete.
 * - hotfix: build→review→pr→pr-review→done; mesma regra de correção no build.
 * - review-only: review; fail encerra como blocked com relatório (sem implementação automática).
 * - 4º fail no mesmo estágio => exhausted; mesmo gap 2x consecutivas sem pass intermediário => thrash.
 * - pass limpa a sequência de gap do estágio (mantém auditoria em history).
 * - done notifica o planner (notify); terminais blocked/exhausted/thrash notificam o planner (notify),
 *   nunca "task Executar estágio". Cópia de progresso ao planner é entrega independente (R13).
 * - blockedReason é persistido no run. Operações após terminal são recusadas.
 * - Conclusão de task vinculada ocorre na mesma gravação da transição (campo linkedTaskMessageId
 *   resolvido pelo chamador via completeLinkedTask em messages/service).
 * - M4: `gate` opcional (EvidenceGateContext) traz o contexto evidencial do chamador
 *   (checks efetivos config-aware, manifesto aprovado e fingerprint atual da árvore);
 *   sem ele, o gate preserva o comportamento legado da matriz do método.
 */
/**
 * M6-F2 (R4-04) — PRÉ-VALIDAÇÃO PURA e compartilhada de uma conclusão: projeto,
 * identidade do ator, estágio, revisão, snapshot e evidências são conferidos
 * EXATAMENTE como na aplicação real (applyCompletion a delega), mas SEM gravar
 * nada e SEM exigir a referência de PR do estágio pr — que só existe depois do
 * efeito externo. A CLI faz dry-run com esta função antes de qualquer chamada
 * de rede, garantindo que pedido inválido gera ZERO efeito externo.
 * Retorna { ok: true } ou { ok: false, error } com a MESMA mensagem que a
 * aplicação real produziria.
 */
export function validateCompletion(state: Runtime, operation: StageCompletion, gate?: EvidenceGateContext): { ok: true } | { ok: false; error: string } {
  const run = state.runs.find(item => item.runId === operation.runId);
  if (!run) return { ok: false, error: 'execução desconhecida' };
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (run.status !== 'running') return fail(`execução já está ${run.status}; operações após terminal são recusadas`);
  if (run.stage !== operation.stage || run.revision !== operation.expectedRevision) {
    return fail('estágio ou revisão divergente');
  }
  if (!operation.operationId || !operation.runId) return fail('operationId/runId obrigatórios');
  if (operation.actor.projectId && operation.actor.projectId !== state.projectId) {
    return fail('projeto do ator divergente');
  }
  if (operation.actor.role !== stageOwner[run.stage]) return fail('papel não é proprietário do estágio');
  if (!operation.actor.threadId || !operation.actor.generationId) return fail('ator sem threadId/generationId');
  const session = state.sessions.find(s =>
    s.role === operation.actor.role &&
    s.threadId === operation.actor.threadId &&
    s.generationId === operation.actor.generationId &&
    s.status === 'ready');
  if (!session) return fail('sessão ou geração não autorizada');
  if (operation.result === 'pass') {
    // R5-03/R5-05/M3-F3: o gate é OBRIGATÓRIO e COMPLETO para qualquer pass — o motor não
    // faz IO, mas exige fatos verificados; ausência de um fato reprova (nunca dispensa).
    const gateErrors = validateGateContext(gate);
    if (gateErrors.length || !gate) return fail(`contexto de gate incompleto: ${gateErrors.join('; ')}`);
    // R5-05: o manifesto pertence à APROVAÇÃO desta execução. Run legado (aprovação sem
    // manifesto) não passa gate moderno; substituição do manifesto no meio do fluxo reprova.
    const approvedManifest = run.approval?.requirementsManifest;
    if (!approvedManifest) {
      return fail('execução sem manifesto de requisitos coberto pela aprovação (run legado); reaprove e inicie novamente — gate moderno não é dispensado');
    }
    if (gate.manifestHash.toLowerCase() !== approvedManifest.hash.toLowerCase()) {
      return fail('manifesto de requisitos difere do aprovado no start (hash divergente); substituição no meio do fluxo exige reaprovação');
    }
    // R5-03: a seleção COMPLETA de checks; qualquer check exigido pelo método e ausente
    // (sem dispensa explícita aprovada) reprova ANTES de qualquer efeito externo.
    if (gate.checks.missing.length) {
      return fail(`check(s) obrigatório(s) '${gate.checks.missing.join("', '")}' ausente(s) da configuração e sem dispensa explícita aprovada para ${run.workflow}/${operation.stage}`);
    }
    // Fronteira de confiança (verificação V2-04): o motor é PURO — recalcula a política do método, mas o CONTEÚDO de `gate.manifest`
    // e `gate.manifestHash` é afirmação do chamador (a CLI lê o arquivo e confere o hash contra a aprovação antes de montar o gate).
    // Revisão B/B2: o motor NÃO confia na seleção do chamador — recalcula a política do método (função pura, sem IO) e exige
    // que required ∪ missing ∪ exempt cubra TODO check canônico do workflow/estágio; cada dispensa deve ser válida e constar
    // no manifesto APROVADO. Uma seleção mentirosa ({required:[], missing:[], exempt:[]}) reprova.
    const coveredChecks = new Set([...gate.checks.required, ...gate.checks.missing, ...gate.checks.exempt.map(x => x.check)]);
    const uncovered = getRequiredChecks(run.workflow, operation.stage).filter(name => !coveredChecks.has(name));
    if (uncovered.length) {
      return fail(`seleção de checks do gate não cobre a política do método (${uncovered.join(', ')}) para ${run.workflow}/${operation.stage}`);
    }
    const exemptErrors = validateCheckExemptions(gate.checks.exempt.map(x => ({ workflow: run.workflow, stage: operation.stage, check: x.check, reason: x.reason })));
    if (exemptErrors.length) return fail(`dispensa de check inválida: ${exemptErrors.join('; ')}`);
    for (const x of gate.checks.exempt) {
      const approvedExemption = gate.manifest.checkExemptions?.some(e => e.workflow === run.workflow && e.stage === operation.stage && e.check === x.check);
      if (!approvedExemption) return fail(`dispensa de '${x.check}' não consta no manifesto aprovado para ${run.workflow}/${operation.stage}`);
    }
    // C09: política única — expectedCommit é EXPECTATIVA do chamador (HEAD verificado
    // pelo cli), nunca preenchimento retroativo. Estágio que exige evidência de código
    // sem expectedCommit é rejeitado (o motor nunca passa undefined adiante).
    if (stageRequiresCommit(run.workflow, operation.stage) && !operation.expectedCommit) {
      return fail(`estágio ${operation.stage} exige commit esperado verificado; sem expectedCommit não há como validar evidência de código`);
    }
    // M4-F1: evidência importada ou 'legacy' NUNCA satisfaz check que o produto executa.
    // R5: evidência mecânica também é do run/estágio/REVISÃO, do projeto, com log verificado
    // e snapshot igual ao da árvore atual (alteração após o check invalida o gate).
    const verified = new Set(gate.verifiedLogs);
    for (const checkName of gate.checks.required) {
      const passed = state.evidence.some(e =>
        e.requirementId === `${run.slug}:${operation.stage}:check-${checkName}` &&
        e.result === 'pass' && e.verdict === 'pass' && e.commit &&
        e.projectId === state.projectId && e.runId === run.runId && e.stage === operation.stage &&
        e.revision === run.revision && e.logHash !== undefined && verified.has(e.id) &&
        !e.imported && e.provenance !== 'legacy' &&
        e.codeSnapshot !== undefined &&
        e.codeSnapshot.diffFingerprint === gate.currentSnapshot.diffFingerprint &&
        e.codeSnapshot.commit === gate.currentSnapshot.commit &&
        (operation.expectedCommit === undefined || e.commit === operation.expectedCommit));
      if (!passed) return fail(`check obrigatório '${checkName}' não passou para estágio ${operation.stage}: exige evidência do produto aprovada, da revisão atual, com log verificado e snapshot igual ao da árvore atual (evidência ausente, reprovada, de outra revisão ou com snapshot obsoleto não vale)`);
    }
    const check = validateStageEvidence(state, run, operation.stage, operation.evidenceIds, operation.expectedCommit, gate);
    if (!check.ok) return fail(`evidência insuficiente: ${check.errors.join('; ')}`);
    // C09: rubrica própria da etapa — um pass não pode carregar apenas checks;
    // precisa de ao menos uma evidência de requisito/rubrica do estágio.
    const hasRubric = check.evidence.some(e => !e.requirementId.slice(`${run.slug}:${operation.stage}:`.length).startsWith('check-'));
    if (!hasRubric) return fail('pass exige rubrica de requisito do estágio (evidência não-check)');
    if (operation.stage === 'pr-review' && run.pullRequest && operation.expectedCommit &&
        run.pullRequest.commit !== operation.expectedCommit) {
      return fail(`commit mudou após a PR registrada (${run.pullRequest.commit} → ${operation.expectedCommit}); reconfirme a PR no novo commit`);
    }
    const isFinal = !nextStage(run.workflow, operation.stage);
    // R5-07/M4-F2 — pr-review e FECHAMENTO exigem a PR ATUAL observada agora (leitura
    // externa feita pelo chamador): aberta, mesma identidade da PR registrada, base/branch
    // da execução e head igual ao commit que está sendo aprovado. Nada é copiado da
    // referência antiga para "renovar" checkedAt. review-only não tem PR.
    if (run.workflow !== 'review-only' && (operation.stage === 'pr-review' || isFinal)) {
      if (!run.pullRequest) return fail(`estágio ${operation.stage} exige pullRequest registrada; sem PR o pass é recusado`);
      const obs = gate.pullRequest;
      if (!obs) return fail(`estágio ${operation.stage} exige observação atual da PR (leitura externa); sem ela o pass é recusado`);
      if (obs.state !== 'OPEN') return fail(`PR ${obs.url} está '${obs.state}'; somente PR aberta valida ${operation.stage}`);
      if (obs.url !== run.pullRequest.url || (obs.number !== undefined && run.pullRequest.number !== undefined && obs.number !== run.pullRequest.number)) {
        return fail(`PR observada (${obs.url}) não é a PR registrada da execução (${run.pullRequest.url})`);
      }
      if (run.base && obs.base !== run.base) return fail(`base da PR observada (${obs.base}) diverge da base da execução (${run.base})`);
      if (run.branch && obs.branch !== run.branch) return fail(`branch da PR observada (${obs.branch}) diverge da branch da execução (${run.branch})`);
      if (!obs.headSha) return fail('PR observada sem head SHA; resposta incompleta nunca vira sucesso');
    }
    if (run.workflow !== 'review-only' && operation.stage === 'pr-review') {
      if (gate.pullRequest!.headSha !== operation.expectedCommit) {
        return fail(`head remoto da PR (${gate.pullRequest!.headSha}) diverge do commit aprovado (${operation.expectedCommit}); faça push do commit revisado`);
      }
    }
    // R5-07: fechamento de feature (document) compara o código atual com o snapshot
    // EFETIVAMENTE aprovado em pr-review. HEAD igual com diff novo não é aprovação; a
    // documentação só altera raízes documentais aprovadas no manifesto (nunca por extensão).
    if (run.workflow !== 'review-only' && isFinal && operation.stage !== 'pr-review') {
      const approved = run.approvedSnapshot;
      if (!approved) return fail('fechamento exige o snapshot aprovado em pr-review; aprovação independente anterior ausente');
      if (gate.currentCodeSnapshot.diffFingerprint !== approved.diffFingerprint) {
        return fail('código alterado após a aprovação de pr-review (snapshot atual difere do aprovado); nova revisão independente exigida');
      }
      if (gate.commitRelation !== 'same' && gate.commitRelation !== 'docs-only-advance') {
        return fail(`commit atual não corresponde ao aprovado em pr-review (relação: ${gate.commitRelation ?? 'não verificada'}); nova revisão independente exigida`);
      }
      const head = gate.pullRequest!.headSha;
      const requiredRemoteHead = gate.commitRelation === 'docs-only-advance'
        ? operation.expectedCommit
        : approved.commit;
      if (head !== requiredRemoteHead) {
        return fail(`head remoto da PR (${head}) não corresponde ao commit exigido para o fechamento (${requiredRemoteHead}); publique o avanço documental antes de concluir`);
      }
    }
    // C10: fechamento verificável — feature/hotfix só chegam a 'done' com PR registrada.
    if (isFinal && run.workflow !== 'review-only' && !run.pullRequest) {
      return fail(`fechamento de ${run.workflow} exige pullRequest registrada; done sem PR é recusado`);
    }
  }
  return { ok: true };
}

export function applyCompletion(state: Runtime, operation: StageCompletion, gate?: EvidenceGateContext, context?: ApplyContext): TransitionResult {
  const previous = state.operations[operation.operationId];
  if (previous) {
    // C12: replay só devolve resultado anterior quando a operação pertence a ESTA execução.
    if (previous.runId === operation.runId) return { state, result: previous, deliveries: [] };
    return rejected(state, operation, `operationId ${operation.operationId} já usado por outra execução; operação antiga com ID diferente é recusada`, undefined, context?.payloadHash);
  }
  // M6-F2 (R4-04) — pré-validação PURA e compartilhada: projeto, identidade do
  // ator, estágio, revisão, snapshot e evidências são conferidos ANTES de
  // qualquer efeito externo (a CLI faz dry-run com esta função antes do gh).
  const preflight = validateCompletion(state, operation, gate);
  if (!preflight.ok) {
    return rejected(state, operation, preflight.error, state.runs.find(item => item.runId === operation.runId), context?.payloadHash);
  }
  const run = state.runs.find(item => item.runId === operation.runId)!;
  if (operation.result === 'pass' && operation.stage === 'pr') {
    // C10: PR verificada externamente (cli via GhAdapter) é obrigatória e válida.
    // Só a aplicação real exige a referência — o dry-run pré-efeito (validateCompletion)
    // valida tudo o mais sem ela.
    const prError = validatePullRequestRef(operation.pullRequest, run, operation.expectedCommit);
    if (prError) return rejected(state, operation, prError, run, context?.payloadHash);
  }

  const attempts = {
    ...run.attempts,
    [run.stage]: (run.attempts[run.stage] ?? 0) + (operation.result === 'fail' ? 1 : 0),
  };
  const history = [...run.history, { at: now(), stage: run.stage, result: operation.result, operationId: operation.operationId }];
  const deliveries: Delivery[] = [];
  let next = run.stage;
  let status: RunStatus = run.status;
  let gapFailures = { ...run.gapFailures };
  let blockedReason: string | undefined;

  if (operation.result === 'pass') {
    gapFailures = { ...gapFailures, [run.stage]: undefined };
    const following = nextStage(run.workflow, run.stage);
    if (!following) status = 'done';
    else next = following;
  } else {
    const prior = run.gapFailures[run.stage];
    const sameGap = prior && operation.gapId && prior.gapId === operation.gapId;
    const count = sameGap ? prior.count + 1 : 1;
    gapFailures = { ...gapFailures, [run.stage]: operation.gapId ? { gapId: operation.gapId, count } : undefined };
    blockedReason = operation.blockedReason;
    if (operation.blockedReason) {
      // C12: impossibilidade real declarada em qualquer workflow => blocked com motivo
      // preservado; nunca retry silencioso de um escopo impossível.
      status = 'blocked';
    } else if (run.workflow === 'review-only' && run.stage === 'review') {
      status = 'blocked';
      blockedReason = operation.gapId ? `reprovação terminal: gap ${operation.gapId}` : 'reprovação terminal de review-only';
    } else if (count >= 2 && operation.gapId) status = 'thrash';
    else if ((attempts[run.stage] ?? 0) >= 4) status = 'exhausted';
    else next = correctionStage(run);
  }

  const terminal = status !== 'running';
  const updatedRun: Run = {
    ...run, stage: next, revision: run.revision + 1, attempts, gapFailures, status, history,
    owner: terminal ? run.owner : stageOwner[next],
    blockedReason: terminal ? blockedReason : undefined,
    // C10: PR verificada no estágio pr fica registrada no run (fechamento e revalidação).
    ...(operation.result === 'pass' && run.stage === 'pr' ? { pullRequest: operation.pullRequest } : {}),
    // R5-07: snapshot EFETIVAMENTE aprovado pela revisão independente (pr-review); volta a
    // build (correção) invalida a aprovação anterior.
    approvedSnapshot: operation.result === 'pass' && run.stage === 'pr-review' && run.workflow !== 'review-only' && gate
      ? { commit: gate.currentCodeSnapshot.commit, diffFingerprint: gate.currentCodeSnapshot.diffFingerprint, capturedAt: now(), source: 'git-readonly' as const }
      : next === 'build' ? undefined : run.approvedSnapshot,
  };
  const runs = state.runs.map(item => item.runId === run.runId ? updatedRun : item);
  state = {
    ...state, runs,
    operations: { ...state.operations },
    revision: state.revision + 1,
    events: [...state.events, { at: now(), kind: 'transition', detail: `${run.slug}:${run.stage}:${operation.result}->${status}:${next}` }],
  };

  const plannerSession = state.sessions.find(s => s.role === 'planner' && s.status === 'ready');
  const ownerSession = !terminal ? state.sessions.find(s => s.role === stageOwner[next] && s.status === 'ready') : undefined;

  const enqueue = (to: Role, type: Message['type'], body: string, stage?: Message['stage']): void => {
    const target = state.sessions.find(s => s.role === to && s.status === 'ready');
    if (!target) {
      // C12: participante indisponível — entrega fica pendente/recuperável e o
      // diagnóstico fica registrado; nunca se desperta sessão interrupted/closed.
      state = {
        ...state,
        events: [...state.events, { at: now(), kind: 'delivery-diagnostic', detail: `sem sessão ready para ${to}; entrega ${type} preservada como recuperável` }],
      };
    }
    const message: Message = {
      messageId: id(), projectId: state.projectId, runId: run.runId,
      from: 'planner', to, targetThreadId: target?.threadId ?? '', targetGenerationId: target?.generationId ?? '',
      type, stage, revision: updatedRun.revision, body, createdAt: now(),
    };
    const delivery: Delivery = { deliveryId: id(), messageId: message.messageId, status: 'pending', updatedAt: now() };
    deliveries.push(delivery);
    state = { ...state, messages: [...state.messages, message], deliveries: [...state.deliveries, delivery] };
  };

  if (!terminal) {
    // Entrega ao responsável + cópia independente de progresso ao planner (notify, só reconhece).
    enqueue(stageOwner[next], 'task', `Executar estágio ${next} para ${run.slug}`, next);
    if (stageOwner[next] !== 'planner') {
      enqueue('planner', 'notify', `Progresso ${run.slug}: ${run.stage} concluído; próximo ${next} com ${stageOwner[next]}`, next);
    }
  } else if (status === 'done') {
    // R13: done notifica o planner para fechamento consolidado.
    enqueue('planner', 'notify', `Demanda ${run.slug} concluída tecnicamente; consolidar fechamento`, undefined);
    void plannerSession; void ownerSession;
  } else {
    // blocked/exhausted/thrash: notificação ao planner, nunca task de execução.
    enqueue('planner', 'notify',
      `Demanda ${run.slug} em ${status}${blockedReason ? `: ${blockedReason}` : ''}; decisão humana necessária`, undefined);
  }

  const result: OperationResult = { operationId: operation.operationId, accepted: true, status, runId: run.runId, revision: updatedRun.revision, payloadHash: context?.payloadHash };
  state = { ...state, operations: { ...state.operations, [operation.operationId]: result } };
  return { state, result, deliveries };
}

function rejected(state: Runtime, operation: StageCompletion, error: string, run?: Run, payloadHash?: string): TransitionResult {
  const result: OperationResult = { operationId: operation.operationId, accepted: false, status: 'rejected', runId: run?.runId, revision: run?.revision, error, payloadHash };
  return { state: { ...state, operations: { ...state.operations, [operation.operationId]: result } }, result, deliveries: [] };
}

/**
 * C10 — validação da referência de PR verificada externamente (o motor é puro:
 * quem consulta/cria via GhAdapter é o cli, que passa o PullRequestRef conferido).
 * Resposta externa inválida ou ambígua é rejeitada; não há fallback de sucesso
 * com commit vazio. Retorna mensagem de erro ou undefined quando válida.
 */
function validatePullRequestRef(pr: PullRequestRef | undefined, run: Run, expectedCommit?: string): string | undefined {
  if (!pr) return 'estágio pr exige pullRequest verificada externamente (cli via GhAdapter); sem PR ref o pass é recusado';
  if (!/^https?:\/\//i.test(pr.url)) return `url de PR inválida: ${pr.url}`;
  if (run.base && pr.base !== run.base) return `base da PR (${pr.base}) diverge da base do run (${run.base})`;
  if (run.branch && pr.branch !== run.branch) return `branch da PR (${pr.branch}) diverge da branch do run (${run.branch})`;
  if (!pr.commit) return 'PR sem commit; resposta ambígua nunca vira sucesso';
  if (expectedCommit && pr.commit !== expectedCommit) {
    return `commit da PR (${pr.commit}) diverge do commit esperado (${expectedCommit})`;
  }
  if (!pr.checkedAt || Number.isNaN(Date.parse(pr.checkedAt))) return 'PR sem checkedAt verificável';
  return undefined;
}
