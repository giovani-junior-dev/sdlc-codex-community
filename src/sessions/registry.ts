import { id, type Role, type Runtime, type SessionRecord, type SessionStatus } from '../contracts.js';
import { StateStore } from '../state/store.js';

export interface LaunchRecord {
  projectId: string; role: Role; cwd: string; token: string; generationId: string;
  paneId?: string; workspaceId?: string; requestedModel?: string; requestedEffort?: string;
}

/** Normaliza cwd para comparação (separadores, case Windows, trailing slash). */
export function normalizeCwd(cwd: string): string {
  let out = cwd.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out.replace(/\/+$/, '');
}

/**
 * R5-10/M5-F2 — geração vigente do par projeto+papel: a MAIS RECENTE por posição
 * no array de sessões (prepare sempre anexa ao fim e as demais mutações
 * preservam a ordem). Posição, não lastEventAt: um evento tardio numa geração
 * antiga (ex.: SessionEnd) não a torna "mais nova". Isolamento por projectId:
 * projetos com o mesmo nome/papel/demanda nunca se cruzam.
 */
export function latestGeneration(sessions: SessionRecord[], projectId: string, role: Role): SessionRecord | undefined {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].projectId === projectId && sessions[i].role === role) return sessions[i];
  }
  return undefined;
}

/** R5-10 — a geração virou 'unknown' por timeout de lançamento (evidência de auditoria persistida)? */
export function launchTimedOut(events: Runtime['events'], generationId: string): boolean {
  return events.some(e => e.kind === 'launch-timeout' && e.detail === generationId);
}

/**
 * R5-10 (revisão C/A1): a geração vigente do projeto+papel MUDOU depois da decisão do launcher (outro `up` reservou,
 * ou já concluiu, um lançamento) — a decisão ficou obsoleta e NADA foi criado; o chamador reexecuta `up`.
 */
export class LaunchInProgressError extends Error {
  constructor(readonly generationId: string, readonly ageMs: number) {
    super(`a geração vigente do papel mudou depois da decisão (agora ${generationId}, há ${Math.max(0, Math.round(ageMs / 1000))}s): outro lançamento está em andamento ou já concluiu; nenhuma sessão foi criada`);
    this.name = 'LaunchInProgressError';
  }
}

export class SessionRegistry {
  constructor(private readonly store: StateStore) {}
  async state(): Promise<Runtime> { return this.store.read(); }

  /**
   * Reserva a geração 'launching' SOB O LOCK do estado, com CAS sobre a decisão (revisão C/A1 — dois `up` simultâneos
   * liam o estado antes de qualquer prepare e ambos criavam aba; a guarda por "launching recente" não cobre o `up` cuja
   * decisão ficou obsoleta porque o outro já concluiu): `basedOnGeneration` é a geração vigente que fundamentou a
   * decisão (null = nenhuma); se a vigente agora for outra, recusa com LaunchInProgressError e NADA é criado.
   * NUNCA apaga registro anterior (revisão C/A2): a geração substituída segue no runtime até confirmReady fechá-la
   * com auditoria (session-superseded).
   */
  async prepare(input: Omit<LaunchRecord, 'token' | 'generationId'> & { generationId?: string; basedOnGeneration?: string | null }): Promise<LaunchRecord> {
    const { basedOnGeneration, ...rest } = input;
    const record: LaunchRecord = { ...rest, token: id(), generationId: input.generationId ?? id() };
    await this.store.mutate(state => {
      if (basedOnGeneration !== undefined) {
        const current = latestGeneration(state.sessions, input.projectId, input.role);
        if ((current?.generationId ?? null) !== basedOnGeneration) {
          throw new LaunchInProgressError(current?.generationId ?? '(nenhuma)', current ? Date.now() - Date.parse(current.lastEventAt) : 0);
        }
      }
      return {
        state: {
          ...state,
          sessions: [
            ...state.sessions,
            {
              ...record, launchToken: record.token, status: 'launching' as const,
              lastEventAt: new Date().toISOString(),
            },
          ],
          events: [...state.events, { at: new Date().toISOString(), kind: 'launch-prepare', detail: `${record.projectId}:${record.role}:${record.generationId}` }],
        },
        result: record,
      };
    });
    return record;
  }

  /**
   * R10/R4-11 — registro idempotente do fato SessionStart (hook):
   * - hook repetido (mesmo token+session_id) devolve o mesmo registro, sem nova geração;
   * - registro atrasado encontra o launching pendente pelo token; sem pendente => erro, nunca cria;
   * - session_id já usado por outra geração => registro recusado;
   * M5-F1: o hook é UM dos DOIS fatos de prontidão. register persiste o fato
   * (threadId na geração 'launching') mas NÃO promove a 'ready' — 'ready'
   * persistido passa a significar "hook observado E launcher confirmou
   * readiness Herdr" (confirmReady). Sem isso, start aceitaria uma janela em
   * que só o hook tinha sido observado. A demote da geração anterior 'ready'
   * do papel acontece em confirmReady (substituição real), não aqui.
   */
  async register(payload: { event: string; session_id: string; cwd: string; project_id?: string; role?: string; token?: string }): Promise<SessionRecord> {
    if (payload.event !== 'SessionStart') throw new Error('evento de hook não é SessionStart');
    if (!payload.session_id) throw new Error('hook sem session_id; UUID nunca é inferido');
    let registered!: SessionRecord;
    await this.store.mutate(state => {
      // Repetição idempotente: mesmo token+session já confirmados devolvem o mesmo registro.
      const repeated = state.sessions.find(s =>
        s.status === 'ready' && s.launchToken === payload.token &&
        s.threadId === payload.session_id && s.projectId === payload.project_id && s.role === payload.role);
      if (repeated) {
        if (normalizeCwd(repeated.cwd) !== normalizeCwd(payload.cwd)) throw new Error('cwd do hook divergente na repetição');
        registered = repeated;
        return { state, result: undefined };
      }
      const pending = state.sessions.find(s =>
        s.status === 'launching' &&
        s.launchToken === payload.token &&
        s.projectId === payload.project_id &&
        s.role === payload.role);
      if (!pending) throw new Error('lançamento pendente não corresponde ao hook; registro recusado sem criar sessão');
      if (normalizeCwd(pending.cwd) !== normalizeCwd(payload.cwd)) {
        throw new Error(`cwd do hook divergente: esperado ${pending.cwd}, recebido ${payload.cwd}`);
      }
      const same = state.sessions.find(s => s.threadId === payload.session_id && s.generationId === pending.generationId);
      if (same) { registered = same; return { state, result: undefined }; }
      if (state.sessions.some(s => s.threadId === payload.session_id && s.generationId !== pending.generationId)) {
        throw new Error('session_id já pertence a outra geração; registro recusado');
      }
      // Fato do hook persistido; status permanece 'launching' até confirmReady.
      registered = {
        ...pending, threadId: payload.session_id,
        lastEventAt: new Date().toISOString(),
      };
      return {
        state: {
          ...state,
          sessions: state.sessions.map(s => (s === pending ? registered : s)),
          events: [...state.events, { at: new Date().toISOString(), kind: 'session-registered', detail: `${pending.projectId}:${pending.role}:${pending.generationId}` }],
        },
        result: undefined,
      };
    });
    return registered;
  }

  /**
   * M5-F1/R4-11 — confirmação de readiness pelo LAUNCHER (fato Herdr), por
   * generationId. Só promove a 'ready' quando o registro SessionStart (threadId)
   * já existe na MESMA geração — readiness Herdr sozinho nunca promove. Na
   * promoção, a geração anterior 'ready' do mesmo projeto+papel vira
   * 'interrupted' com auditoria (substituição REAL, não no mero registro do
   * hook). Idempotente; recusa geração desconhecida ou em estado terminal —
   * uma geração morta/encerrada não conclui trabalho da vigente.
   * R5-10: `supersedes` é a geração 'unknown'/'launching' do mesmo projeto+papel
   * que o launcher avaliou com PROVA POSITIVA de ausência do agente antes de
   * lançar esta; só na promoção (substituição confirmada) ela vira 'closed',
   * com auditoria. Sem prova (inventário indisponível/ambíguo) o launcher não
   * passa `supersedes` e a antiga permanece 'unknown'.
   */
  async confirmReady(generationId: string, supersedes?: string): Promise<SessionRecord> {
    let confirmed!: SessionRecord;
    await this.store.mutate(state => {
      let closedOld: string | undefined;
      const target = state.sessions.find(s => s.generationId === generationId);
      if (!target) throw new Error(`geração ${generationId} não encontrada no registro; confirmação recusada`);
      if (target.status === 'ready') { confirmed = target; return { state, result: undefined }; }
      if (target.status !== 'launching') {
        throw new Error(`geração ${generationId} está '${target.status}'; não pode ser confirmada ready`);
      }
      if (!target.threadId) {
        throw new Error(`geração ${generationId} sem registro SessionStart; readiness Herdr sem hook não promove a ready`);
      }
      confirmed = { ...target, status: 'ready', lastEventAt: new Date().toISOString() };
      const sessions = state.sessions.map(s => {
        if (s === target) return confirmed;
        // Substituição real: ready anterior do mesmo projeto+papel é interrompida (auditoria preservada).
        if (s.projectId === target.projectId && s.role === target.role && s.status === 'ready') {
          return { ...s, status: 'interrupted' as SessionStatus, lastEventAt: new Date().toISOString() };
        }
        // R5-10: unknown/launching antiga COM prova de ausência, substituída de fato por esta.
        if (supersedes && s.generationId === supersedes && s.projectId === target.projectId && s.role === target.role &&
            (s.status === 'unknown' || s.status === 'launching')) {
          closedOld = s.generationId;
          return { ...s, status: 'closed' as SessionStatus, lastEventAt: new Date().toISOString() };
        }
        return s;
      });
      const events = [...state.events, { at: new Date().toISOString(), kind: 'session-ready', detail: `${target.projectId}:${target.role}:${target.generationId}` }];
      if (closedOld) events.push({ at: new Date().toISOString(), kind: 'session-superseded', detail: `${target.projectId}:${target.role}:${closedOld}->${target.generationId}` });
      return { state: { ...state, sessions, events }, result: undefined };
    });
    return confirmed;
  }

  /**
   * R5-10/M5-F2 — reconciliação de identidade: a geração 'unknown' (ou
   * 'launching' vencida) tem o fato do hook (threadId) e o launcher comprovou
   * saúde pelo inventário ESTRITO (mesmo pane/workspace/agente codex) — volta a
   * 'ready' com auditoria, SEM nova geração. Sem threadId nunca promove;
   * geração terminal (closed/interrupted) nunca ressuscita. Como em
   * confirmReady, a 'ready' anterior do mesmo projeto+papel é interrompida.
   */
  async reconcileHealthy(generationId: string): Promise<SessionRecord> {
    let reconciled!: SessionRecord;
    await this.store.mutate(state => {
      const target = state.sessions.find(s => s.generationId === generationId);
      if (!target) throw new Error(`geração ${generationId} não encontrada no registro; reconciliação recusada`);
      if (target.status === 'ready') { reconciled = target; return { state, result: undefined }; }
      if (target.status !== 'unknown' && target.status !== 'launching') {
        throw new Error(`geração ${generationId} está '${target.status}'; não pode ser reconciliada`);
      }
      if (!target.threadId) {
        throw new Error(`geração ${generationId} sem registro SessionStart; saúde do inventário sem hook não reconcilia identidade`);
      }
      reconciled = { ...target, status: 'ready', lastEventAt: new Date().toISOString() };
      const sessions = state.sessions.map(s => {
        if (s === target) return reconciled;
        if (s.projectId === target.projectId && s.role === target.role && s.status === 'ready') {
          return { ...s, status: 'interrupted' as SessionStatus, lastEventAt: new Date().toISOString() };
        }
        return s;
      });
      return {
        state: {
          ...state, sessions,
          events: [...state.events, { at: new Date().toISOString(), kind: 'session-reconciled', detail: `${target.projectId}:${target.role}:${target.generationId} (${target.status}->ready)` }],
        },
        result: undefined,
      };
    });
    return reconciled;
  }

  /**
   * R4-11 — APIs de evento separadas por identidade inequívoca:
   * - event(threadId, ...) é o fato do HOOK (ex.: SessionEnd → 'closed'),
   *   endereçado pelo UUID da sessão;
   * - eventByGeneration(generationId, ...) é o TIMEOUT do launcher: endereça
   *   EXATAMENTE a geração lançada e aplica-se somente enquanto ela está
   *   'launching' (estado de propriedade do launcher) — assim nunca rebaixa
   *   geração substituta nem reescreve estados terminais;
   * - invalidateByGeneration(generationId, ...) é a INVALIDAÇÃO conservadora
   *   do reuso (R4-15): o launcher avaliou uma geração 'ready' registrada e o
   *   inventário não comprova saúde — rebaixa 'ready'/'launching' para
   *   'unknown' com diagnóstico; estados terminais (closed/interrupted) e
   *   gerações de outros ids nunca são tocados.
   */
  async event(threadId: string, status: SessionStatus): Promise<void> {
    await this.store.mutate(state => ({
      state: {
        ...state,
        sessions: state.sessions.map(s => s.threadId === threadId ? { ...s, status, lastEventAt: new Date().toISOString() } : s),
        events: [...state.events, { at: new Date().toISOString(), kind: `session-${status}`, detail: threadId }],
      },
      result: undefined,
    }));
  }

  /**
   * R5-10: `cause` (ex.: 'launch-timeout') registra, só quando a geração
   * 'launching' foi de fato transicionada, o MOTIVO da transição — é o que
   * permite ao próximo up diferenciar unknown por timeout de unknown por
   * falha de inventário (ambos têm status 'unknown').
   */
  async eventByGeneration(generationId: string, status: SessionStatus, cause?: string): Promise<void> {
    await this.store.mutate(state => {
      const hit = state.sessions.some(s => s.generationId === generationId && s.status === 'launching');
      const at = new Date().toISOString();
      return {
        state: {
          ...state,
          sessions: state.sessions.map(s =>
            s.generationId === generationId && s.status === 'launching'
              ? { ...s, status, lastEventAt: at }
              : s),
          events: [
            ...state.events,
            { at, kind: `session-${status}`, detail: generationId },
            ...(hit && cause ? [{ at, kind: cause, detail: generationId }] : []),
          ],
        },
        result: undefined,
      };
    });
  }

  async invalidateByGeneration(generationId: string, status: SessionStatus = 'unknown'): Promise<void> {
    await this.store.mutate(state => ({
      state: {
        ...state,
        sessions: state.sessions.map(s =>
          s.generationId === generationId && (s.status === 'ready' || s.status === 'launching')
            ? { ...s, status, lastEventAt: new Date().toISOString() }
            : s),
        events: [...state.events, { at: new Date().toISOString(), kind: `session-${status}`, detail: generationId }],
      },
      result: undefined,
    }));
  }

  /**
   * R5-10 (revisão C/A4) — ação HUMANA explícita para unknown ambíguo: o humano (up --roles <papel> --replace-unknown)
   * declara a sessão perdida e autoriza nova geração SEM prova de morte pelo inventário. Fica auditada; a antiga só
   * fecha quando a nova for confirmada (confirmReady). Nunca aplicada por `up` comum.
   */
  async recordHumanReplacement(generationId: string): Promise<void> {
    await this.store.mutate(state => ({
      state: { ...state, events: [...state.events, { at: new Date().toISOString(), kind: 'session-human-replace', detail: generationId }] },
      result: undefined,
    }));
  }

  async attachPane(generationId: string, paneId: string): Promise<void> {
    await this.store.mutate(state => ({
      state: {
        ...state,
        sessions: state.sessions.map(s => s.generationId === generationId ? { ...s, paneId } : s),
      },
      result: undefined,
    }));
  }
}
