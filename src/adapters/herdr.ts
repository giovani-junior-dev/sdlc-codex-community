import type { ProcessRunner, ProcessResult } from './process.js';

export interface HerdrWorkspace { workspaceId: string; projectId: string; path: string; raw?: unknown; }
export interface HerdrPane { paneId: string; workspaceId?: string; role?: string; ready: boolean; raw?: unknown; }
export interface HerdrAgent { name: string; paneId?: string; kind?: string; state?: string; sessionId?: string; raw?: unknown; }

/**
 * R09 — adaptador pelas interfaces REAIS do Herdr instalado
 * (herdr 0.7.5-preview, `herdr agent start --help`, `herdr workspace/tab/pane/agent --help`):
 * - workspace: `workspace list` / `workspace create --cwd <PATH> --label <TEXT> [--env K=V]`
 * - tab: `tab create --workspace <ID> --cwd <PATH> --label <TEXT> [--env K=V]` / `tab list`
 * - pane: `pane list` / `pane split [--pane ID|--current] --cwd --env` / `pane get`
 * - agent: `agent start <NAME> --kind codex --pane <ID> [--timeout <MS>] [-- AGENT_ARG...]`
 * - readiness: `agent wait <TARGET> [--until idle|working|blocked|done|unknown] [--timeout MS]`
 * - inventário: `agent list` (nunca título de terminal como UUID).
 * `listPanes`/`listAgents` LANÇAM quando o inventário está indisponível —
 * vazio significa "sem agentes", exceção significa "não sei"; o launcher trata
 * esses casos de forma distinta (diagnóstico, nunca confirmação de saúde).
 * Não existem `workspace ensure`, `pane wait-ready` nem `inventory` — removidos.
 */
export interface HerdrAdapter {
  ensureWorkspace(projectId: string, path: string): Promise<HerdrWorkspace>;
  /** Cria a tab; `paneId` é extraído da resposta quando o Herdr o devolve. */
  createTab(workspaceId: string, label: string, cwd: string, env: Record<string, string>): Promise<{ tabId: string; paneId?: string; raw?: unknown }>;
  /** Lança exceção quando o inventário está INDISPONÍVEL (distinto de vazio). */
  listPanes(): Promise<HerdrPane[]>;
  startAgent(name: string, paneId: string, agentArgs?: string[], timeoutMs?: number): Promise<void>;
  /** Confirma somente o prompt exato de confiança do diretório, após opt-in humano no comando `up`. */
  acceptProjectTrust?(paneId: string, timeoutMs: number): Promise<boolean>;
  /** Cria o primeiro turno controlado e devolve o UUID real reportado pelo Herdr. */
  bootstrapAgentSession?(name: string, paneId: string, prompt: string, timeoutMs: number): Promise<string>;
  waitAgent(target: string, until: string[], timeoutMs: number): Promise<boolean>;
  /** Lança exceção quando o inventário está INDISPONÍVEL (distinto de vazio). */
  listAgents(): Promise<HerdrAgent[]>;
}

function envArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
  return args;
}

function tryJson(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Herdr 0.7.5 envolve respostas em { id: "cli:<op>", result: ... }.
 * O campo id é correlação da chamada e nunca identifica workspace/tab/pane. */
function resultOf(value: unknown): unknown {
  const object = asObject(value);
  return object && 'result' in object ? object.result : value;
}

function arrayOf(value: unknown, key: string): unknown[] | undefined {
  const result = resultOf(value);
  if (Array.isArray(result)) return result;
  const object = asObject(result);
  return object && Array.isArray(object[key]) ? object[key] as unknown[] : undefined;
}

function pickId(obj: unknown, keys: string[]): string | undefined {
  if (obj && typeof obj === 'object') {
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.length) return v;
    }
  }
  return undefined;
}

export class HerdrProcessAdapter implements HerdrAdapter {
  constructor(private readonly runner: ProcessRunner, private readonly executable = 'herdr') {}

  private async runOrThrow(args: string[], cwd?: string): Promise<ProcessResult> {
    const r = await this.runner.run(this.executable, args, cwd ? { cwd } : {});
    if (r.exitCode !== 0) throw new Error(`herdr ${args.slice(0, 2).join(' ')} falhou: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    return r;
  }

  async ensureWorkspace(projectId: string, path: string): Promise<HerdrWorkspace> {
    const list = await this.runner.run(this.executable, ['workspace', 'list']);
    if (list.exitCode === 0) {
      const parsed = tryJson(list.stdout);
      const items = arrayOf(parsed, 'workspaces') ?? [];
      for (const item of items) {
        const id = pickId(item, ['workspaceId', 'workspace_id', 'id']);
        const itemPath = (item as Record<string, unknown>)?.cwd ?? (item as Record<string, unknown>)?.path;
        const label = (item as Record<string, unknown>)?.label ?? (item as Record<string, unknown>)?.name;
        if (id && (itemPath === path || label === projectId)) {
          return { workspaceId: id, projectId, path: typeof itemPath === 'string' ? itemPath : path, raw: item };
        }
      }
    }
    const created = await this.runOrThrow(['workspace', 'create', '--cwd', path, '--label', projectId]);
    const parsed = tryJson(created.stdout);
    const result = resultOf(parsed);
    const resultObject = asObject(result);
    const workspace = resultObject?.workspace;
    const rootPane = resultObject?.root_pane;
    const id = pickId(workspace, ['workspaceId', 'workspace_id', 'id'])
      ?? pickId(rootPane, ['workspaceId', 'workspace_id'])
      ?? pickId(result, ['workspaceId', 'workspace_id', 'id']);
    if (!id) throw new Error('herdr workspace create devolveu resposta sem workspace_id');
    return { workspaceId: id, projectId, path, raw: parsed ?? created.stdout };
  }

  async createTab(workspaceId: string, label: string, cwd: string, env: Record<string, string>): Promise<{ tabId: string; paneId?: string; raw?: unknown }> {
    const r = await this.runOrThrow(['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label, ...envArgs(env)]);
    const parsed = tryJson(r.stdout);
    const result = resultOf(parsed);
    const object = asObject(result);
    const tab = object?.tab;
    const rootPane = object?.root_pane ?? object?.pane;
    const tabId = pickId(tab, ['tabId', 'tab_id', 'id']) ?? pickId(result, ['tabId', 'tab_id', 'id']);
    if (!tabId) throw new Error('herdr tab create devolveu resposta sem tab_id');
    const paneId = pickId(rootPane, ['paneId', 'pane_id', 'id']) ?? pickId(result, ['paneId', 'pane_id']);
    return { tabId, paneId, raw: parsed ?? r.stdout };
  }

  async listPanes(): Promise<HerdrPane[]> {
    const r = await this.runOrThrow(['pane', 'list']);
    const parsed = tryJson(r.stdout);
    const panes = arrayOf(parsed, 'panes');
    if (!panes) throw new Error('herdr pane list devolveu JSON inesperado');
    return panes.map((item): HerdrPane => ({
      paneId: pickId(item, ['paneId', 'pane_id', 'id']) ?? '',
      workspaceId: pickId(item, ['workspaceId', 'workspace_id', 'tabId', 'tab_id']),
      ready: true, raw: item,
    })).filter(p => p.paneId.length > 0);
  }

  async startAgent(name: string, paneId: string, agentArgs: string[] = [], timeoutMs = 60_000): Promise<void> {
    const args = ['agent', 'start', name, '--kind', 'codex', '--pane', paneId, '--timeout', String(timeoutMs)];
    if (agentArgs.length) args.push('--', ...agentArgs);
    await this.runOrThrow(args);
  }

  async acceptProjectTrust(paneId: string, timeoutMs: number): Promise<boolean> {
    const prompt = 'Do you trust the contents of this directory?';
    const observed = await this.runner.run(this.executable, [
      'pane', 'wait-output', paneId, '--match', prompt, '--source', 'recent-unwrapped', '--lines', '120', '--timeout', String(timeoutMs), '--raw',
    ]);
    if (observed.exitCode !== 0) return false;
    await this.runOrThrow(['pane', 'send-keys', paneId, 'Enter']);
    return true;
  }

  async bootstrapAgentSession(name: string, paneId: string, prompt: string, timeoutMs: number): Promise<string> {
    await this.runOrThrow(['pane', 'send-text', paneId, prompt]);
    // O backend de terminal aplica texto e teclas em eventos separados. Sem a
    // pequena barreira observada no Herdr 0.7.5, Enter pode chegar antes do texto.
    await new Promise(resolve => setTimeout(resolve, 200));
    await this.runOrThrow(['pane', 'send-keys', paneId, 'Enter']);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.runOrThrow(['agent', 'get', name]);
      const parsed = resultOf(tryJson(result.stdout));
      const agent = asObject(asObject(parsed)?.agent ?? parsed);
      const session = asObject(agent?.agent_session);
      const sessionId = pickId(session, ['value', 'id', 'session_id']);
      if (sessionId) return sessionId;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Herdr não reportou UUID da sessão ${name} após o bootstrap em ${timeoutMs}ms`);
  }

  async waitAgent(target: string, until: string[], timeoutMs: number): Promise<boolean> {
    const args = ['agent', 'wait', target];
    for (const u of until) args.push('--until', u);
    args.push('--timeout', String(timeoutMs));
    const r = await this.runner.run(this.executable, args);
    return r.exitCode === 0;
  }

  async listAgents(): Promise<HerdrAgent[]> {
    const r = await this.runOrThrow(['agent', 'list']);
    const parsed = tryJson(r.stdout);
    const agents = arrayOf(parsed, 'agents');
    if (!agents) throw new Error('herdr agent list devolveu JSON inesperado');
    return agents.map((item): HerdrAgent => ({
      name: pickId(item, ['name', 'id']) ?? '',
      paneId: pickId(item, ['paneId', 'pane_id', 'pane']),
      kind: typeof (item as Record<string, unknown>)?.kind === 'string' ? (item as Record<string, unknown>).kind as string
        : typeof (item as Record<string, unknown>)?.agent === 'string' ? (item as Record<string, unknown>).agent as string : undefined,
      state: typeof (item as Record<string, unknown>)?.state === 'string' ? (item as Record<string, unknown>).state as string
        : typeof (item as Record<string, unknown>)?.agent_status === 'string' ? (item as Record<string, unknown>).agent_status as string : undefined,
      sessionId: pickId(asObject((item as Record<string, unknown>)?.agent_session), ['value', 'id', 'session_id']),
      raw: item,
    })).filter(a => a.name.length > 0);
  }
}
