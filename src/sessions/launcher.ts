import type { Role, SessionRecord } from '../contracts.js';
import type { HerdrAdapter, HerdrAgent, HerdrPane, HerdrWorkspace } from '../adapters/herdr.js';
import type { GitAdapter } from '../adapters/git.js';
import { LaunchInProgressError, SessionRegistry, latestGeneration, launchTimedOut, normalizeCwd } from './registry.js';
import { delimiter, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

function agentNameFor(projectId: string, role: Role): string {
  const projectKey = createHash('sha256').update(projectId).digest('hex').slice(0, 16);
  return `sdlc-${projectKey}-${role}`;
}

export interface LaunchTeamInput {
  projectId: string; projectRoot: string; roles: Role[]; demand?: string;
  devWorktree?: string; devBranch?: string; gitBase?: string;
  modelByRole?: Partial<Record<Role, { model?: string; effort?: string }>>;
  registrationTimeoutMs?: number;
  /** R5-10: folga além do prazo de registro em que um 'launching' ainda conta como em andamento (padrão: o próprio registrationTimeoutMs). */
  launchGraceMs?: number;
  /** Binário nativo do Codex; no Windows seu diretório precisa preceder o shim npm para o Start-Process do Herdr. */
  nativeCodexExecutable?: string;
  /** Opt-in explícito para automação cujos hooks já foram verificados fora do Codex. */
  bypassHookTrust?: boolean;
  /** Opt-in humano para aceitar no pane exato o prompt de confiança do diretório. */
  trustProject?: boolean;
  /** Implementação do sandbox nativo do Windows para esta sessão; mantém o isolamento e não altera a configuração global. */
  windowsSandbox?: 'elevated' | 'unelevated';
  /** Usa o primeiro turno controlado como fallback quando o SessionStart local não registra a identidade. */
  bootstrapRegistration?: boolean;
  /** R5-10: true quando o humano escolheu os papéis (up --roles) — pedido explícito de substituição, único caminho que relança papel 'interrupted'. */
  explicitRoles?: boolean;
  /** R5-10 (revisão C/A4): com `explicitRoles`, o humano declara perdida uma sessão 'unknown' AMBÍGUA (inventário indisponível) e autoriza nova geração; auditado. */
  replaceUnknown?: boolean;
}

/**
 * R5-10 — por que um papel NÃO ficou pronto sem criar sessão:
 * - 'launch-timeout': lançamento anterior expirou (unknown por timeout, ou launching vencido) e o inventário não reconcilia;
 * - 'interrupted': sessão pausada/interrompida; nunca é despertada nem substituída sem pedido explícito;
 * - 'inventory': inventário Herdr indisponível, ambíguo, duplicado ou sem paneId — estado desconhecido persiste;
 * - 'launch-in-progress': há um lançamento recente ainda dentro do prazo (+ folga); não é substituído.
 */
export type LaunchReason = 'launch-timeout' | 'interrupted' | 'inventory' | 'launch-in-progress';

export interface LaunchResult {
  role: Role; paneId?: string; generationId: string; ready: boolean; reused?: boolean; error?: string;
  /** R5-10: presente quando ready=false por decisão conservadora (zero criação). */
  reason?: LaunchReason;
  /** R5-10: geração 'unknown'/'launching' vencida promovida de volta a 'ready' pelo inventário (sem nova geração). */
  reconciled?: boolean;
}

/**
 * Avaliação do inventário sobre a geração registrada (R4-15 — reuso conservador),
 * SEM efeitos:
 * - 'healthy': agente codex no MESMO pane registrado, pane no MESMO workspace e cwd relevante;
 * - 'launch': há evidência de que a sessão registrada não serve — `absent` é a
 *   PROVA POSITIVA de que o agente não existe mais (pane sem agente codex); cwd
 *   incompatível é 'launch' sem prova de morte;
 * - 'unknown': inventário INDISPONÍVEL ou AMBÍGUO — estado desconhecido,
 *   diagnóstico e ZERO criação; relançamento automático é recusado.
 */
type Inspection =
  | { kind: 'healthy' }
  | { kind: 'launch'; absent: boolean }
  | { kind: 'unknown'; error: string };

/** Resultado da decisão sobre a geração existente: parar (com resultado) ou seguir ao lançamento. */
type Resolution = { result: LaunchResult } | { supersedes?: string };

/**
 * C07/R10/R4-11/R4-15/R5-10 — abertura do time pelas interfaces reais do Herdr:
 * 1. decisão sobre a geração VIGENTE do papel ANTES de qualquer efeito (R5-10:
 *    a mais recente do projeto+papel por posição — ver latestGeneration —, em
 *    qualquer status, não só 'ready'):
 *    - ready: exige AGENTE correspondente no inventário por paneId EXATO (nunca
 *      name.includes(role)) + pane presente no MESMO workspace registrado + cwd
 *      relevante (dev: worktree da demanda; demais papéis: raiz principal);
 *    - unknown: o inventário é RECONSULTADO a cada up. Saudável + threadId
 *      registrado => reconcilia a identidade (volta a 'ready', sem nova geração);
 *      ausência comprovada => relançamento (up é a solicitação humana) e a
 *      antiga fecha só quando a nova for confirmada; indisponível/ambíguo =>
 *      continua unknown, diagnóstico e zero criação, em quantos up forem;
 *    - launching: recente (prazo + folga) => 'launch-in-progress', nunca
 *      substituído; vencido => ambíguo, reavaliado pelo inventário (sem
 *      threadId não há reuso: diagnóstico, salvo prova de ausência);
 *    - interrupted: sem seleção explícita de papéis => diagnóstico, zero criação;
 *      com up --roles => pedido de substituição, relança;
 *    - closed (mais recente): terminal — lança nova geração.
 *    Inventário indisponível/ambíguo NÃO confirma nem nega saúde: a geração é
 *    marcada/permanece 'unknown' e NENHUMA aba/agente/worktree é criado;
 * 2. worktree do dev a partir da BASE configurada (nunca HEAD implícito),
 *    com correlação exata de path/branch/base no GitAdapter;
 * 3. prepare (launching+token) -> tab com env de registro -> startAgent ->
 *    wait; pane escolhido de forma DETERMINÍSTICA (paneId devolvido pela
 *    criação da tab, ou único pane do workspace) — nunca "última pane global";
 * 4. prontidão somente com a COMBINAÇÃO: registro SessionStart (hook, fato
 *    persistido como threadId na geração 'launching') E readiness Herdr
 *    confirmada pelo launcher (confirmReady). Timeout atinge EXATAMENTE a
 *    geração lançada (eventByGeneration, causa 'launch-timeout') e nunca
 *    rebaixa geração substituta; qualquer lacuna vira parcial com diagnóstico;
 * 5. time parcial nunca inicia pipeline (decisão do CLI/start, aqui reportada).
 * A garantia de workspace é LAZY: só é resolvido quando algum papel de fato
 * precisa lançar — reuso total e estado desconhecido causam zero efeitos.
 * LIMITAÇÃO conhecida (revisão cruzada): a confirmação de saúde no reuse exige
 * um agente codex no MESMO pane registrado; se o usuário encerrar o agente e
 * iniciar outra sessão codex não relacionada no mesmo pane, o reuse confirma
 * saúde pelo pane (o threadId registrado pode não existir mais). Correlacionar
 * por thread exige consulta não disponível na instalação observada — mitigado
 * pelos hooks de fim de sessão e pelo prazo de registro; documentado de propósito.
 * A mesma limitação vale para a reconciliação de unknown (R5-10).
 * Operações Git passam pelo adaptador (testes usam falso; nenhum Git mutável
 * real na suite). Modelo/esforço seguem como opções do Codex (-m e
 * -c model_reasoning_effort=) conforme a instalação observada; validação live
 * continua pendente.
 */
export class TeamLauncher {
  constructor(
    private readonly herdr: HerdrAdapter,
    private readonly git: GitAdapter,
    private readonly registry: SessionRegistry,
  ) {}

  async launch(input: LaunchTeamInput): Promise<LaunchResult[]> {
    const timeout = input.registrationTimeoutMs ?? 60_000;
    // R4-15: workspace garantido de forma LAZY — só é resolvido quando um papel
    // realmente precisa lançar (reuso total ou unknown => zero efeito).
    let workspacePromise: Promise<HerdrWorkspace> | undefined;
    const workspace = (): Promise<HerdrWorkspace> => (workspacePromise ??= this.herdr.ensureWorkspace(input.projectId, input.projectRoot));
    const output: LaunchResult[] = [];
    for (const role of input.roles) {
      try {
        output.push(await this.launchOne(input, workspace, role, timeout));
      } catch (error) {
        output.push({ role, generationId: '', ready: false, error: (error as Error).message });
      }
    }
    return output;
  }

  /**
   * R4-15 — avaliação conservadora do inventário sobre a geração registrada.
   * Só devolve 'launch' quando há evidência positiva de que ela não serve;
   * inventário indisponível/ambíguo é 'unknown' (diagnóstico, zero criação).
   * Não muta estado: quem decide o que persistir é resolveExisting.
   */
  private async inspect(input: LaunchTeamInput, role: Role, existing: SessionRecord): Promise<Inspection> {
    // cwd relevante: dev é específico da demanda (worktree exato); demais papéis rodam na raiz principal.
    const expectedCwd = role === 'dev' && input.devWorktree ? input.devWorktree : input.projectRoot;
    if (normalizeCwd(existing.cwd) !== normalizeCwd(expectedCwd)) return { kind: 'launch', absent: false };
    // Sem paneId não há como correlacionar com o inventário: ambiguidade, nunca reuso às cegas.
    if (!existing.paneId) {
      return { kind: 'unknown', error: 'sessão registrada sem paneId; correlação com inventário impossível' };
    }
    // Inventário indisponível (exceção) = "não sei", distinto de vazio = "sem agentes".
    let agents: HerdrAgent[];
    try {
      agents = await this.herdr.listAgents();
    } catch (error) {
      return { kind: 'unknown', error: `inventário de agentes indisponível (${(error as Error).message})` };
    }
    // Correlação exata: agente listado no MESMO pane registrado; kind 'codex'
    // quando o Herdr informa. Sem name.includes como prova. Vazio = pane sem
    // agente (evidência de morte, nova geração justificada); múltiplos = ambíguo.
    const inPane = agents.filter(a => a.paneId === existing.paneId && (a.kind === undefined || a.kind === 'codex'));
    if (inPane.length === 0) return { kind: 'launch', absent: true };
    if (inPane.length > 1) {
      return { kind: 'unknown', error: `${inPane.length} agentes codex no pane ${existing.paneId}; inventário ambíguo` };
    }
    // O pane registrado deve existir no inventário e pertencer ao MESMO workspace.
    let panes: HerdrPane[];
    try {
      panes = await this.herdr.listPanes();
    } catch (error) {
      return { kind: 'unknown', error: `inventário de panes indisponível (${(error as Error).message})` };
    }
    const paneMatches = panes.filter(p => p.paneId === existing.paneId);
    if (paneMatches.length !== 1) {
      return { kind: 'unknown', error: `pane ${existing.paneId} ${paneMatches.length === 0 ? 'ausente' : 'duplicado'} no inventário; correlação ambígua` };
    }
    const pane = paneMatches[0];
    if (existing.workspaceId && pane.workspaceId && pane.workspaceId !== existing.workspaceId) {
      return { kind: 'unknown', error: `pane ${existing.paneId} pertence ao workspace ${pane.workspaceId}, registrado em ${existing.workspaceId}; inventário de outra aba não comprova liveness` };
    }
    return { kind: 'healthy' };
  }

  /**
   * R5-10/M5-F2 — decide o destino da geração vigente (ver doc da classe).
   * Devolve `result` quando o papel NÃO deve lançar (reuso, reconciliação ou
   * diagnóstico com zero criação) ou `supersedes` quando o lançamento segue.
   */
  private async resolveExisting(input: LaunchTeamInput, role: Role, existing: SessionRecord, timeoutMs: number): Promise<Resolution> {
    const gen = existing.generationId;
    const stop = (reason: LaunchReason, error: string): Resolution => ({
      result: { role, paneId: existing.paneId, generationId: gen, ready: false, reason, error: `papel ${role}: ${error}` },
    });

    if (existing.status === 'interrupted') {
      // Sessão pausada nunca é despertada nem substituída sozinha; só o humano, escolhendo o papel, pede substituição.
      if (input.explicitRoles) return {};
      return stop('interrupted', `geração ${gen} interrompida (pausada); nenhuma sessão foi criada — retome a sessão ou solicite a substituição com up --roles ${role}`);
    }

    if (existing.status === 'launching') {
      // Lançamento em andamento (dentro do prazo + folga) nunca é substituído: duplicaria abas.
      const windowMs = timeoutMs + (input.launchGraceMs ?? timeoutMs);
      const ageMs = Date.now() - Date.parse(existing.lastEventAt);
      if (ageMs <= windowMs) {
        return stop('launch-in-progress', `lançamento da geração ${gen} em andamento (${Math.max(0, Math.round(ageMs / 1000))}s de ${Math.round(windowMs / 1000)}s); nenhuma sessão foi criada — aguarde e execute up novamente`);
      }
    }

    const verdict = await this.inspect(input, role, existing);
    // 'ready' é a única que já carrega a identidade confirmada; as demais precisam de threadId (fato do hook).
    // Já 'unknown' persiste sozinha entre invocações: nada a gravar (evita evento de auditoria repetido a cada up).
    const persistUnknown = async (): Promise<void> => {
      if (existing.status !== 'unknown') await this.registry.invalidateByGeneration(gen, 'unknown');
    };

    if (verdict.kind === 'launch') {
      // Só a AUSÊNCIA comprovada deixa a antiga ser fechada (na confirmação da nova).
      return { supersedes: verdict.absent && existing.status !== 'ready' ? gen : undefined };
    }

    if (verdict.kind === 'unknown' && input.explicitRoles && input.replaceUnknown) {
      // Ação HUMANA explícita e auditada: sem prova de morte pelo inventário, mas o humano assumiu a responsabilidade.
      await this.registry.recordHumanReplacement(gen);
      return { supersedes: existing.status === 'unknown' || existing.status === 'launching' ? gen : undefined };
    }

    if (verdict.kind === 'unknown') {
      const persistNote = await this.persistWithRetry(async () => { await persistUnknown(); });
      const prior = launchTimedOut((await this.registry.state()).events, gen) ? ' (o lançamento anterior desta geração expirou)' : '';
      return stop('inventory', `${verdict.error}${prior}; sessão marcada 'unknown' (estado desconhecido) — relançamento automático recusado; confira o Herdr e execute up novamente (se a sessão estiver comprovadamente perdida, solicite a substituição explícita com up --roles ${role} --replace-unknown)${persistNote ? `; ${persistNote}` : ''}`);
    }

    // healthy
    if (existing.status === 'ready') {
      return { result: { role, paneId: existing.paneId, generationId: gen, ready: true, reused: true } };
    }
    if (existing.threadId) {
      try {
        await this.registry.reconcileHealthy(gen);
        return { result: { role, paneId: existing.paneId, generationId: gen, ready: true, reused: true, reconciled: true } };
      } catch (error) {
        return stop('inventory', `reconciliação da geração ${gen} recusada: ${(error as Error).message}`);
      }
    }
    // Agente vivo no pane mas sem SessionStart registrado: identidade não comprovada; lançar duplicaria a sessão.
    const persistNote2 = await this.persistWithRetry(async () => { await persistUnknown(); });
    return stop('launch-timeout', `geração ${gen} sem registro SessionStart e o agente segue no pane ${existing.paneId}; identidade não comprovada — sessão marcada 'unknown', nenhuma sessão foi criada; encerre a sessão órfã no Herdr e execute up novamente${persistNote2 ? `; ${persistNote2}` : ''}`);
  }

  private async launchOne(input: LaunchTeamInput, workspace: () => Promise<HerdrWorkspace>, role: Role, timeoutMs: number): Promise<LaunchResult> {
    // 1. Decisão sobre a geração vigente ANTES de criar worktree/workspace/tab.
    const current = await this.registry.state();
    const existing = latestGeneration(current.sessions, input.projectId, role);
    let supersedes: string | undefined;
    if (existing && existing.status !== 'closed') {
      const resolution = await this.resolveExisting(input, role, existing, timeoutMs);
      if ('result' in resolution) return resolution.result;
      supersedes = resolution.supersedes;
    }

    // 2. Worktree do dev (somente quando não reutilizado), a partir da base configurada.
    // Verificação V1-1: o cwd é calculado SEM efeito; o worktree só é criado DEPOIS de vencer a reserva (CAS) — o `up`
    // perdedor da corrida nunca executa `git worktree add`.
    let cwd = input.projectRoot;
    let worktreePending = false;
    if (role === 'dev' && input.devWorktree && input.demand) {
      if (!input.gitBase) throw new Error('base Git configurada (prBase) é obrigatória para o worktree do dev');
      cwd = input.devWorktree;
      worktreePending = true;
    } else if (role === 'dev' && input.devWorktree) {
      cwd = input.devWorktree;
    }

    // 3. Prepare + worktree + tab + agent start.
    const ws = await workspace();
    // Revisão C/A1: a guarda de lançamento concorrente é a MESMA transação que reserva a geração (sob o lock do estado).
    let launch;
    try {
      launch = await this.registry.prepare({
        projectId: input.projectId, role, cwd, paneId: undefined, workspaceId: ws.workspaceId,
        requestedModel: input.modelByRole?.[role]?.model, requestedEffort: input.modelByRole?.[role]?.effort,
        basedOnGeneration: existing?.generationId ?? null,
      });
    } catch (error) {
      if (error instanceof LaunchInProgressError) {
        return { role, generationId: error.generationId, ready: false, reason: 'launch-in-progress', error: `papel ${role}: ${error.message} — aguarde e execute up novamente` };
      }
      throw error;
    }
    if (worktreePending) {
      try {
        await this.git.ensureWorktree(input.projectRoot, input.devWorktree!, input.devBranch ?? `sdlc/${input.demand}`, input.gitBase!);
      } catch (error) {
        // A reserva já foi feita: fecha-a como unknown (causa auditada) para não deixar um 'launching' fantasma.
        const note = await this.persistWithRetry(() => this.registry.eventByGeneration(launch.generationId, 'unknown', 'worktree-failed'));
        return { role, generationId: launch.generationId, ready: false, error: `${(error as Error).message}${note ? `; ${note}` : ''}` };
      }
    }
    const pathParts = [
      ...(input.nativeCodexExecutable ? [dirname(input.nativeCodexExecutable)] : []),
      join(input.projectRoot, '.sdlc-codex', 'bin'),
      process.env.PATH ?? '',
    ];
    const tabEnv: Record<string, string> = {
      SDLC_CODEX_PROJECT_ID: input.projectId,
      SDLC_CODEX_PROJECT_ROOT: input.projectRoot,
      SDLC_CODEX_ROLE: role,
      SDLC_CODEX_GENERATION_ID: launch.generationId,
      SDLC_CODEX_LAUNCH_TOKEN: launch.token,
      PATH: pathParts.join(delimiter),
    };
    let paneId: string | undefined;
    let settled: boolean;
    try {
      const tab = await this.herdr.createTab(ws.workspaceId, `${input.projectId}-${role}`, cwd, tabEnv);
      paneId = await this.resolvePane(tab.paneId, ws.workspaceId);
      await this.registry.attachPane(launch.generationId, paneId);
      const agentName = agentNameFor(input.projectId, role);
      const spec = input.modelByRole?.[role];
      const agentArgs: string[] = [];
      if (input.bypassHookTrust) agentArgs.push('--dangerously-bypass-hook-trust');
      if (input.windowsSandbox) agentArgs.push('-c', `windows.sandbox="${input.windowsSandbox}"`);
      if (input.trustProject) {
        if (cwd.includes("'")) throw new Error('não é possível expressar confiança temporária para caminho contendo apóstrofo');
        // Override da tabela inteira evita o parser de chave pontilhada do Codex
        // dividir caminhos com pontos. Aspas literais TOML sobrevivem ao
        // transporte Herdr/Start-Process e fazem a camada local estar ativa
        // ANTES do SessionStart da primeira sessão.
        agentArgs.push('-c', `projects={'${cwd}'={trust_level='trusted'}}`);
      }
      if (spec?.model) agentArgs.push('-m', spec.model);
      if (spec?.effort) agentArgs.push('-c', `model_reasoning_effort=${spec.effort}`);
      agentArgs.push('-C', cwd);
      await this.herdr.startAgent(agentName, paneId, agentArgs, Math.min(timeoutMs, 300_000));
      if (input.trustProject) {
        if (!this.herdr.acceptProjectTrust) throw new Error('adaptador Herdr não suporta confirmação controlada de confiança do projeto');
        await this.herdr.acceptProjectTrust(paneId, Math.min(timeoutMs, 15_000));
      }
      settled = await this.herdr.waitAgent(agentName, ['idle', 'working', 'blocked', 'done'], Math.min(timeoutMs, 300_000));

      // Hooks locais podem ser descobertos somente depois da decisão de
      // confiança ou perder variáveis customizadas pela política de ambiente.
      // Dá ao SessionStart a primeira chance; se ele não registrar, cria um
      // turno mínimo, lê o UUID real do inventário Herdr e passa pela MESMA
      // validação transacional de registro (token/projeto/papel/geração).
      if (input.bootstrapRegistration && settled) {
        const hookDeadline = Date.now() + Math.min(2_000, Math.max(500, Math.floor(timeoutMs / 4)));
        let hookRegistered = false;
        while (Date.now() < hookDeadline) {
          const state = await this.registry.state();
          hookRegistered = !!state.sessions.find(s => s.generationId === launch.generationId && s.status === 'launching' && s.threadId);
          if (hookRegistered) break;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!hookRegistered) {
          if (!this.herdr.bootstrapAgentSession) throw new Error('adaptador Herdr não suporta bootstrap de identidade da sessão');
          const sessionId = await this.herdr.bootstrapAgentSession(
            agentName, paneId,
            `SDLC Codex bootstrap (${role}): responda apenas READY e aguarde instruções.`,
            Math.min(timeoutMs, 30_000),
          );
          await this.registry.register({
            event: 'SessionStart', session_id: sessionId, cwd,
            project_id: input.projectId, role, token: launch.token,
          });
        }
      }
    } catch (error) {
      const note = await this.persistWithRetry(() => this.registry.eventByGeneration(launch.generationId, 'unknown', 'launch-failed'));
      return {
        role, paneId, generationId: launch.generationId, ready: false,
        error: `${(error as Error).message}; lançamento encerrado como unknown${note ? `; ${note}` : ''}`,
      };
    }

    // 4. COMBINAÇÃO obrigatória: registro SessionStart (hook persistido como
    //    threadId na geração 'launching') E readiness Herdr. 'ready' só é
    //    persistido via confirmReady — nunca diretamente pelo hook — para não
    //    existir janela em que start aceite apenas o fato do registro.
    //    Leituras transitórias do estado (ex.: rename concorrente do runtime no
    //    Windows) não derrubam o lançamento: viram diagnóstico até o prazo.
    const deadline = Date.now() + timeoutMs;
    let registered = false;
    let lastProbeError: string | undefined;
    while (Date.now() < deadline) {
      try {
        const state = await this.registry.state();
        lastProbeError = undefined;
        registered = !!state.sessions.find(s =>
          s.projectId === input.projectId && s.role === role &&
          s.generationId === launch.generationId && s.status === 'launching' && s.threadId);
      } catch (error) {
        lastProbeError = (error as Error).message;
      }
      if (registered && settled) {
        try {
          // R5-10: a unknown antiga (com prova de ausência) só fecha aqui, na substituição confirmada.
          await this.registry.confirmReady(launch.generationId, supersedes);
          return { role, paneId, generationId: launch.generationId, ready: true };
        } catch (error) {
          return { role, paneId, generationId: launch.generationId, ready: false, error: `papel ${role}: confirmação de readiness recusada: ${(error as Error).message}` };
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    const probeNote = lastProbeError ? `; leitura do estado instável no fim do prazo: ${lastProbeError}` : '';
    const detail = !settled && !registered
      ? `agente não atingiu readiness e sem registro SessionStart em ${timeoutMs}ms`
      : !settled
        ? 'sessão registrada pelo hook mas agente sem readiness no Herdr'
        : `agente pronto no Herdr mas sem registro SessionStart em ${timeoutMs}ms`;
    // R4-11: timeout endereçado pela GERAÇÃO lançada; só atinge essa geração.
    // R5-10: a causa fica auditada para o próximo up diferenciar timeout de falha de inventário.
    // Revisão C/A3: a falha de persistência NÃO é engolida — reintenta e, esgotado, entra no diagnóstico. Se a falha for
    // PERMANENTE a geração fica 'launching' (o relato é a entrega, não a prevenção): o próximo up lerá 'launch-in-progress' até
    // o fim da janela prazo+folga e só então reavalia pelo inventário.
    const persistNote = await this.persistWithRetry(() => this.registry.eventByGeneration(launch.generationId, 'unknown', 'launch-timeout'));
    return { role, paneId, generationId: launch.generationId, ready: false, reason: 'launch-timeout', error: `papel ${role}: ${detail}${probeNote}; time parcial — pipeline não inicia${persistNote ? `; ${persistNote}` : ''}` };
  }

  /**
   * Revisão C/A3 — persistência que NÃO engole erro: até 4 tentativas com espera crescente (contenção transitória de
   * rename do runtime no Windows); esgotadas, devolve a nota de diagnóstico para o `error` do LaunchResult.
   */
  private async persistWithRetry(fn: () => Promise<void>): Promise<string | undefined> {
    let last: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { await fn(); return undefined; }
      catch (error) { last = error; if (attempt < 4) await new Promise(r => setTimeout(r, 50 * attempt)); }
    }
    return `falha ao persistir o estado da sessão após 4 tentativas (${last instanceof Error ? last.message : String(last)}); o estado pode estar desatualizado`;
  }

  /**
   * C07 — escolha DETERMINÍSTICA do pane: o paneId devolvido pela criação da
   * tab; senão, o ÚNICO pane listado no workspace. Inventário indisponível ou
   * ambíguo é diagnóstico — nunca "última pane global" nem token de saída.
   */
  private async resolvePane(tabPaneId: string | undefined, workspaceId: string): Promise<string> {
    if (tabPaneId) return tabPaneId;
    let panes: Array<{ paneId: string; workspaceId?: string }>;
    try {
      panes = await this.herdr.listPanes();
    } catch {
      throw new Error(`pane da tab não identificada: inventário de panes indisponível e a criação da tab não devolveu paneId`);
    }
    const candidates = panes.filter(p => p.workspaceId === workspaceId);
    if (candidates.length === 1) return candidates[0].paneId;
    throw new Error(`pane da tab não identificada de forma determinística (${candidates.length} panes no workspace; tab sem paneId) — recusado a adivinhar`);
  }
}
