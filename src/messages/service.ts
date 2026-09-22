import { id, type Delivery, type DeliveryStatus, type Message, type MessageType, type Role, type Runtime } from '../contracts.js';
import { StateStore } from '../state/store.js';
import { CodexTransport, type QueueOutcome } from '../adapters/codex.js';

const now = () => new Date().toISOString();
export type ReceiveAction = 'execute' | 'duplicate' | 'stale' | 'resume';
export interface ReceiveResult { action: ReceiveAction; message: Message; delivery: Delivery; instruction: string; }
export interface SendInput {
  from: Role; to: Role; type: MessageType; body: string; runId?: string;
  correlationId?: string; stage?: Message['stage']; revision?: number;
  linkedTaskMessageId?: string; checkpoint?: string;
}

/** C01 — resultado operacional por entrega no despacho centralizado. */
export interface DispatchOutcome {
  deliveryId: string; messageId: string; status: DeliveryStatus;
  nativeMessageId?: string; error?: string;
}

/** C11 — opções de recuperação: liberação explícita de claim interrompido. */
export interface RecoverOptions { releaseClaimFor?: string; role?: Role; threadId?: string; generationId?: string; }
export interface RecoverItem { messageId: string; status: string; checkpoint?: string; action?: string; }

/** R11/C01: estados avançados nunca rebaixados por send/recover/dispatch tardio. */
const ADVANCED: Delivery['status'][] = ['received', 'completed'];
function safeReceiptUpdate(current: Delivery['status'], next: Delivery['status']): Delivery['status'] {
  if (ADVANCED.includes(current)) return current;
  return next;
}

/** C01 — envelope único usado por send, dispatchPending e recover (mesmo shape do cli). */
function buildEnvelope(message: Message): string {
  return JSON.stringify({
    messageId: message.messageId, projectId: message.projectId, from: message.from,
    type: message.type, body: message.body, runId: message.runId,
    stage: message.stage, revision: message.revision, correlationId: message.correlationId ?? '',
  });
}

export class MessageService {
  constructor(private readonly store: StateStore, private readonly transport: CodexTransport) {}

  /**
   * C01 — ÚNICA fonte de receipt seguro: atualização condicional por deliveryId.
   * Se a entrega avançou (receive/finish de outro escritor venceu), o resultado do
   * primeiro escritor é preservado e nada é rebaixado. IDs e checkpoint intactos.
   */
  private async applyReceipt(deliveryId: string, mapped: DeliveryStatus, nativeMessageId?: string): Promise<Delivery | undefined> {
    let applied: Delivery | undefined;
    await this.store.mutate(current => {
      const delivery = current.deliveries.find(d => d.deliveryId === deliveryId);
      if (!delivery) return { state: current, result: undefined };
      if (ADVANCED.includes(delivery.status)) { applied = delivery; return { state: current, result: undefined }; }
      const next: Delivery = {
        ...delivery, status: safeReceiptUpdate(delivery.status, mapped),
        nativeMessageId: nativeMessageId ?? delivery.nativeMessageId, updatedAt: now(),
      };
      applied = next;
      return { state: { ...current, deliveries: current.deliveries.map(d => d.deliveryId === deliveryId ? next : d) }, result: undefined };
    });
    return applied;
  }

  async send(input: SendInput): Promise<{ message: Message; delivery: Delivery; queue: string }> {
    if (!input.body) throw new Error('corpo vazio; use --body-file');
    const state = await this.store.read();
    const session = state.sessions.find(s => s.role === input.to && s.projectId === state.projectId && s.status === 'ready');
    if (!session?.threadId) throw new Error(`participante ${input.to} não está pronto; relançamento seletivo via up --roles`);
    if (input.runId) {
      const run = state.runs.find(r => r.runId === input.runId);
      if (!run) throw new Error('execução desconhecida');
      if (run.status !== 'running') throw new Error(`execução já está ${run.status}`);
    }
    // C11: resposta só contra pergunta existente e compatível (mesma execução,
    // remetente da answer é destinatário da question e vice-versa).
    if (input.type === 'answer') {
      if (!input.correlationId) throw new Error('answer exige correlationId da pergunta (--reply-to)');
      const question = state.messages.find(m => m.messageId === input.correlationId);
      if (!question || question.type !== 'question') throw new Error('answer sem pergunta correspondente');
      if (question.runId !== input.runId) throw new Error('pergunta de outra execução; resposta recusada');
      if (question.to !== input.from || question.from !== input.to) throw new Error('participantes incompatíveis com a pergunta correlacionada');
    }
    const message: Message = {
      messageId: id(), projectId: state.projectId, runId: input.runId,
      from: input.from, to: input.to, targetThreadId: session.threadId, targetGenerationId: session.generationId,
      type: input.type, correlationId: input.correlationId, stage: input.stage, revision: input.revision,
      body: input.body, createdAt: now(),
      linkedTaskMessageId: input.linkedTaskMessageId, checkpoint: input.checkpoint,
    };
    if (input.type === 'task') {
      throw new Error('task é reservado a kickoff e passagens do motor; conversas livres usam question|answer|notify');
    }
    const delivery: Delivery = { deliveryId: id(), messageId: message.messageId, status: 'pending', updatedAt: now() };
    // Atualização do estado e criação da entrega pendente na mesma gravação (R11: claim preservado).
    await this.store.mutate(current => ({
      state: { ...current, messages: [...current.messages, message], deliveries: [...current.deliveries, delivery] },
      result: undefined,
    }));
    // C01: transporte fora do lock; falha de transporte vira status failed/uncertain,
    // nunca exceção após a entrega estar persistida.
    let outcome: QueueOutcome;
    try {
      outcome = await this.transport.queue(session.threadId, buildEnvelope(message));
    } catch (error) {
      outcome = { status: 'failed', reason: `falha de transporte: ${(error as Error).message}`, result: { exitCode: null, stdout: '', stderr: String(error), timedOut: false, acceptedBeforeTimeout: false } };
    }
    const mapped: DeliveryStatus = outcome.status === 'enqueued' ? 'enqueued' : outcome.status;
    const updated = await this.applyReceipt(delivery.deliveryId, mapped, outcome.receipt?.nativeMessageId);
    return { message, delivery: updated ?? delivery, queue: outcome.status };
  }

  /**
   * C01 — Despacho centralizado de entregas pendentes (kickoff, next e recover
   * convergem aqui; o cli apenas chama este método após suas transações).
   * - Leitura em snapshot, sem lock durante o transporte.
   * - Seleciona APENAS deliveries 'pending' cujo destinatário resolve para sessão
   *   'ready' com threadId da geração vigente (sem sessão ready => permanece
   *   'pending' com diagnóstico no outcome, nunca exceção).
   * - Falha de uma entrega não aborta as demais; resultado claro por entrega.
   */
  async dispatchPending(): Promise<DispatchOutcome[]> {
    const snapshot = await this.store.read();
    const pending = snapshot.deliveries.filter(d => d.status === 'pending');
    const outcomes: DispatchOutcome[] = [];
    for (const delivery of pending) {
      const message = snapshot.messages.find(m => m.messageId === delivery.messageId);
      if (!message) {
        outcomes.push({ deliveryId: delivery.deliveryId, messageId: delivery.messageId, status: delivery.status, error: 'mensagem da entrega não encontrada' });
        continue;
      }
      const session = snapshot.sessions.find(s => s.role === message.to && s.projectId === snapshot.projectId && s.status === 'ready' && s.threadId);
      if (!session) {
        outcomes.push({ deliveryId: delivery.deliveryId, messageId: delivery.messageId, status: delivery.status, error: `participante ${message.to} sem sessão ready; entrega preservada como pending` });
        continue;
      }
      if (session.generationId !== message.targetGenerationId || session.threadId !== message.targetThreadId) {
        // Geração substituída: remapeamento explícito com auditoria antes do envio.
        await this.remapGeneration(message.messageId, session.threadId as string, session.generationId);
      }
      let outcome: QueueOutcome;
      try {
        outcome = await this.transport.queue(session.threadId as string, buildEnvelope(message));
      } catch (error) {
        outcome = { status: 'failed', reason: `falha de transporte: ${(error as Error).message}`, result: { exitCode: null, stdout: '', stderr: String(error), timedOut: false, acceptedBeforeTimeout: false } };
      }
      const mapped: DeliveryStatus = outcome.status === 'enqueued' ? 'enqueued' : outcome.status;
      const applied = await this.applyReceipt(delivery.deliveryId, mapped, outcome.receipt?.nativeMessageId);
      const result: DispatchOutcome = {
        deliveryId: delivery.deliveryId, messageId: delivery.messageId,
        status: applied?.status ?? delivery.status,
        nativeMessageId: applied?.nativeMessageId,
      };
      if (outcome.status !== 'enqueued') result.error = outcome.reason ?? `transporte ${outcome.status}`;
      outcomes.push(result);
    }
    return outcomes;
  }

  /**
   * R12 — receive valida identidade vigente: thread/registro atual, execução,
   * etapa e revisão. Entrega já reivindicada/concluída => duplicate.
   * Etapa antiga => stale. Resume só após liberação explícita (releaseClaim).
   */
  async receive(messageId: string, actor: { role: Role; threadId: string; generationId: string; checkpoint?: string }): Promise<ReceiveResult> {
    let result!: ReceiveResult;
    await this.store.mutate(state => {
      const message = state.messages.find(item => item.messageId === messageId);
      const delivery = state.deliveries.find(item => item.messageId === messageId);
      if (!message || !delivery) throw new Error('mensagem desconhecida');
      if (message.projectId !== state.projectId) throw new Error('mensagem de outro projeto');
      if (message.to !== actor.role) throw new Error('destinatário lógico divergente');
      if (message.targetThreadId !== actor.threadId || message.targetGenerationId !== actor.generationId) {
        throw new Error('thread/geração do ator divergente do destino vigente; sessão antiga não conclui trabalho da nova geração');
      }
      const session = state.sessions.find(s => s.role === actor.role && s.threadId === actor.threadId && s.generationId === actor.generationId);
      if (!session || session.status !== 'ready') throw new Error('sessão do ator não está ready no registro vigente');
      if (message.runId) {
        const run = state.runs.find(r => r.runId === message.runId);
        if (!run) throw new Error('execução da mensagem desconhecida');
        if (message.type === 'task') {
          // C12: para tasks, run + stage + revision são SEMPRE validados. Task de
          // execução done/blocked/exhausted/thrash ou inexistente nunca retorna
          // 'execute'; etapa/revisão antiga é 'stale' em todos os casos.
          if (run.status !== 'running') {
            result = { action: 'stale', message, delivery, instruction: `Execução já está ${run.status}; encerre este turno sem executar efeitos.` };
            return { state, result: undefined };
          }
          if (message.stage !== run.stage || message.revision !== run.revision) {
            result = { action: 'stale', message, delivery, instruction: 'Mensagem de etapa antiga; encerre sem executar.' };
            return { state, result: undefined };
          }
        } else if (message.stage !== undefined && message.revision !== undefined && run.status === 'running') {
          if (message.stage !== run.stage || message.revision !== run.revision) {
            result = { action: 'stale', message, delivery, instruction: 'Mensagem de etapa antiga; encerre sem executar.' };
            return { state, result: undefined };
          }
        }
      }
      let action: ReceiveAction = 'execute';
      let next = delivery;
      if (delivery.status === 'failed') {
        // M2/revisão cruzada: 'failed' é estado de transporte recuperável via
        // recover — nunca 'stale' (a mensagem pode nem ter chegado ao destino).
        throw new Error('entrega falhou no transporte; execute recover para reenvio antes de receber');
      }
      if (delivery.claimReleased && delivery.status === 'received') {
        action = 'resume';
        next = { ...delivery, claimReleased: false, claimedBy: `${actor.role}:${actor.generationId}`, claimedAt: now(), checkpoint: actor.checkpoint ?? delivery.checkpoint, updatedAt: now() };
      } else if (delivery.status === 'completed' || delivery.status === 'received') action = 'duplicate';
      else next = { ...delivery, status: 'received', claimedBy: `${actor.role}:${actor.generationId}`, claimedAt: now(), checkpoint: actor.checkpoint ?? delivery.checkpoint, updatedAt: now(), claimReleased: false };
      result = {
        action, message, delivery: next,
        instruction: action === 'execute'
          ? 'Confirme o recebimento antes de executar efeitos; quem depende de resposta salva checkpoint, envia pergunta e encerra o turno.'
          : action === 'resume'
            ? 'Retome pelo checkpoint registrado; efeitos externos já executados não foram revertidos — inspecione worktree e evidências.'
            : 'Encerre este turno sem repetir efeitos.',
      };
      return {
        state: { ...state, deliveries: state.deliveries.map(item => item.deliveryId === delivery.deliveryId ? next : item) },
        result: undefined,
      };
    });
    return result;
  }

  /**
   * R12 — finish-message conclui conversas/notificações autorizadas, com checkpoint
   * quando houver dependência pendente. Task NUNCA conclui aqui: conclusão de task
   * ocorre na mesma transação de next (completeTask). Rejeita tarefa obsoleta e
   * respeita pausa humana (sessão não-ready não conclui).
   */
  async finishMessage(messageId: string, actor: { role: Role; threadId: string; generationId: string }, checkpoint?: string): Promise<void> {
    await this.store.mutate(state => {
      const message = state.messages.find(m => m.messageId === messageId);
      const delivery = state.deliveries.find(d => d.messageId === messageId);
      if (!message || !delivery) throw new Error('mensagem desconhecida');
      if (message.type === 'task') throw new Error('task conclui somente via next na mesma transação da transição');
      if (message.to !== actor.role) throw new Error('somente o destinatário vigente conclui a mensagem');
      if (message.targetThreadId !== actor.threadId || message.targetGenerationId !== actor.generationId) {
        throw new Error('ator obsoleto; sessão antiga não conclui trabalho da nova geração');
      }
      const session = state.sessions.find(s => s.role === actor.role && s.threadId === actor.threadId && s.generationId === actor.generationId);
      if (!session || session.status !== 'ready') throw new Error('sessão pausada/interrompida; conclusão bloqueada até retomada');
      if (delivery.status === 'completed') return { state, result: undefined };
      // R4-03: completed preserva a trilha de claim; quando a conclusão ocorre sem
      // receive prévio, o próprio concluinte vira o claim registrado.
      const claimed = delivery.claimedBy
        ? delivery
        : { ...delivery, claimedBy: `${actor.role}:${actor.generationId}`, claimedAt: now() };
      const next = { ...claimed, status: 'completed' as const, checkpoint: checkpoint ?? delivery.checkpoint, updatedAt: now() };
      return {
        state: {
          ...state,
          deliveries: state.deliveries.map(d => d.deliveryId === delivery.deliveryId ? next : d),
          events: [...state.events, { at: now(), kind: 'message-completed', detail: `${message.type}:${messageId}` }],
        },
        result: undefined,
      };
    });
  }

  /** Conclusão de task vinculada, para uso na mesma transação de next (R12). Pura: recebe e devolve Runtime.
   *  R4-03: completed exige trilha de claim — o ator que conclui vira o claim quando
   *  a task não passou por receive prévio. */
  static completeLinkedTask(state: Runtime, taskMessageId: string, actor?: { role: Role; generationId: string }): Runtime {
    const delivery = state.deliveries.find(d => d.messageId === taskMessageId);
    if (!delivery) return state;
    const claimed = delivery.claimedBy
      ? delivery
      : { ...delivery, claimedBy: actor ? `${actor.role}:${actor.generationId}` : 'pipeline:next', claimedAt: now() };
    const next = { ...claimed, status: 'completed' as const, updatedAt: now() };
    return {
      ...state,
      deliveries: state.deliveries.map(d => d.deliveryId === delivery.deliveryId ? next : d),
      events: [...state.events, { at: now(), kind: 'message-completed', detail: `task:${taskMessageId}` }],
    };
  }

  /** Liberação explícita de reivindicação interrompida; próximo receive devolve resume com checkpoint. */
  async releaseClaim(messageId: string): Promise<void> {
    await this.store.mutate(state => {
      const delivery = state.deliveries.find(d => d.messageId === messageId);
      if (!delivery) throw new Error('mensagem desconhecida');
      if (delivery.status !== 'received') throw new Error('somente reivindicação ativa (received) pode ser liberada');
      const next = { ...delivery, claimReleased: true, updatedAt: now() };
      return {
        state: {
          ...state,
          deliveries: state.deliveries.map(d => d.deliveryId === delivery.deliveryId ? next : d),
          events: [...state.events, { at: now(), kind: 'claim-released', detail: messageId }],
        },
        result: undefined,
      };
    });
  }

  /**
   * R11/C11 — recover reenvia entregas recuperáveis sem repetir transição.
   * - Resolve o destino VIGENTE por papel (sessão ready atual — nunca a primeira
   *   sessão histórica); UUID antigo nunca é reutilizado às cegas.
   * - Respeita pausa humana: sessões interrupted/closed/unknown não são despertadas;
   *   entrega reportada como `paused`, sem reenvio.
   * - Atualização condicional do receipt (R11/C01 via applyReceipt): nunca rebaixa
   *   received/completed; preserva deliveryId/messageId/nativeMessageId.
   * - opts.releaseClaimFor: liberação explícita de claim interrompido, validando a
   *   identidade do ator (papel/thread/geração contra o destino vigente e sessão
   *   ready); registra auditoria e devolve informação de resume com checkpoint.
   * - Limitado à fila encontrada na invocação; sem loop residente.
   */
  async recover(limit = 100, opts?: RecoverOptions): Promise<RecoverItem[]> {
    if (opts?.releaseClaimFor) return this.releaseClaimForRecovery(opts);
    const snapshot = await this.store.read();
    // C11: fila recuperável = pending/uncertain/failed (falha de transporte é
    // recuperável pelo operador — antes desta correção 'failed' era beco sem
    // saída e receive classificava como stale), MAIS entregas 'enqueued' cujo
    // destinatário foi substituído (a mensagem foi enfileirada na geração antiga
    // e a sessão pronta agora é outra — remapear e reenviar preservando IDs).
    // Entregas enqueued com destino vigente inalterado NÃO são reenviadas.
    const selected = snapshot.deliveries.filter(d => {
      if (['pending', 'uncertain', 'failed'].includes(d.status)) return true;
      if (d.status !== 'enqueued') return false;
      const message = snapshot.messages.find(m => m.messageId === d.messageId);
      if (!message) return false;
      const session = snapshot.sessions.find(s => s.role === message.to && s.projectId === snapshot.projectId && s.status === 'ready' && s.threadId);
      return !session || session.threadId !== message.targetThreadId || session.generationId !== message.targetGenerationId;
    }).slice(0, limit);
    const pending = selected;
    const output: RecoverItem[] = [];
    for (const delivery of pending) {
      const current = (await this.store.read());
      const message = current.messages.find(m => m.messageId === delivery.messageId);
      const live = current.deliveries.find(d => d.deliveryId === delivery.deliveryId);
      if (!message || !live) continue;
      if (['received', 'completed'].includes(live.status)) { output.push({ messageId: message.messageId, status: live.status }); continue; }
      // C11: destino vigente = sessão READY atual do papel (geração corrente).
      const session = current.sessions.find(s => s.role === message.to && s.projectId === current.projectId && s.status === 'ready' && s.threadId);
      if (!session) {
        output.push({ messageId: message.messageId, status: 'paused' });
        continue;
      }
      if (session.threadId !== message.targetThreadId || session.generationId !== message.targetGenerationId) {
        // Entrega 'enqueued' cujo destinatário foi substituído: remapeamento
        // explícito para a nova geração, preservando IDs e trilha de auditoria.
        await this.remapGeneration(message.messageId, session.threadId as string, session.generationId);
      }
      let outcome: QueueOutcome;
      try {
        outcome = await this.transport.queue(session.threadId as string, buildEnvelope(message));
      } catch (error) {
        outcome = { status: 'failed', reason: `falha de transporte: ${(error as Error).message}`, result: { exitCode: null, stdout: '', stderr: String(error), timedOut: false, acceptedBeforeTimeout: false } };
      }
      const applied = await this.applyReceipt(delivery.deliveryId, outcome.status === 'enqueued' ? 'enqueued' : outcome.status, outcome.receipt?.nativeMessageId);
      if (live.status === 'failed') {
        // Auditoria: recuperação explícita de entrega que falhou no transporte.
        await this.store.mutate(current => ({
          state: { ...current, events: [...current.events, { at: now(), kind: 'delivery-recovered', detail: `${delivery.messageId}: failed -> ${applied?.status ?? outcome.status}` }] },
          result: undefined,
        }));
      }
      output.push({ messageId: message.messageId, status: applied?.status ?? outcome.status });
    }
    return output;
  }

  /** C11 — liberação de claim interrompida via recover, com identidade validada. */
  private async releaseClaimForRecovery(opts: RecoverOptions): Promise<RecoverItem[]> {
    const messageId = opts.releaseClaimFor as string;
    let released: RecoverItem | undefined;
    await this.store.mutate(state => {
      const message = state.messages.find(m => m.messageId === messageId);
      const delivery = state.deliveries.find(d => d.messageId === messageId);
      if (!message || !delivery) throw new Error('mensagem desconhecida');
      // Identidade do ator: papel deve ser o destinatário lógico da mensagem.
      if (opts.role && message.to !== opts.role) throw new Error(`ator ${opts.role} não é destinatário da mensagem ${messageId}`);
      // C11: após substituição humana (up --roles), a sessão do destino registrado
      // fica closed/interrupted — a liberação valida contra a GERAÇÃO VIGENTE do
      // papel (sessão ready atual), nunca contra a sessão histórica. Sem sessão
      // ready, retomada/substituição humana é pré-requisito e a operação falha.
      const vigente = state.sessions.find(s => s.role === message.to && s.projectId === state.projectId && s.status === 'ready' && s.threadId);
      if (!vigente) throw new Error(`participante ${message.to} sem sessão ready; retomada/substituição humana (up --roles) é pré-requisito da recuperação de claim`);
      if (opts.threadId && opts.threadId !== message.targetThreadId && opts.threadId !== vigente.threadId) {
        throw new Error('threadId do ator não corresponde nem ao destino registrado nem à geração vigente; claim recusada');
      }
      if (opts.generationId && opts.generationId !== message.targetGenerationId && opts.generationId !== vigente.generationId) {
        throw new Error('geração do ator não corresponde nem ao destino registrado nem à geração vigente; claim recusada');
      }
      if (delivery.status !== 'received') throw new Error('somente reivindicação ativa (received) pode ser liberada');
      // Remapeamento explícito da mensagem/claim para a geração vigente quando o
      // destinatário foi substituído, preservando IDs, checkpoint e auditoria.
      const remapped = message.targetThreadId !== vigente.threadId || message.targetGenerationId !== vigente.generationId;
      const nextMessage: Message = remapped
        ? { ...message, targetThreadId: vigente.threadId as string, targetGenerationId: vigente.generationId }
        : message;
      const next: Delivery = { ...delivery, claimReleased: true, updatedAt: now() };
      released = { messageId, status: next.status, action: 'resume', checkpoint: next.checkpoint };
      return {
        state: {
          ...state,
          messages: state.messages.map(m => m.messageId === messageId ? nextMessage : m),
          deliveries: state.deliveries.map(d => d.deliveryId === delivery.deliveryId ? next : d),
          events: [...state.events,
            { at: now(), kind: 'claim-released', detail: `${messageId} via recover` },
            ...(remapped ? [{ at: now(), kind: 'delivery-remapped', detail: `${messageId}->${vigente.generationId} (recover --claim)` }] : []),
          ],
        },
        result: undefined,
      };
    });
    return [released as RecoverItem];
  }

  /** Remapeamento explícito para geração nova, preservando mensagem e trilha de auditoria. */
  async remapGeneration(messageId: string, targetThreadId: string, generationId: string): Promise<void> {
    await this.store.mutate(state => ({
      state: {
        ...state,
        messages: state.messages.map(m => m.messageId === messageId ? { ...m, targetThreadId, targetGenerationId: generationId } : m),
        events: [...state.events, { at: now(), kind: 'delivery-remapped', detail: `${messageId}->${generationId}` }],
      },
      result: undefined,
    }));
  }
}
