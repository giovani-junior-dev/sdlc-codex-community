import { emptyRuntime, isRole, type Runtime } from '../contracts.js';
import { join } from 'node:path';
import { SessionRegistry } from '../sessions/registry.js';
import { findProjectRoot, loadConfig } from '../project/config.js';
import { roleContext } from './context.js';
import { checkPolicy, isInside } from './policy.js';

/**
 * C06/S04/R4-09 — entrada dos hooks adaptada ao protocolo wire do Codex
 * (observado em codex-cli 0.155.1: enum HookEvents e structs
 * *HookSpecificOutputWire no binário; feature flag `hooks` = stable).
 *
 * Eventos de CONTEXTO (persona/retomada, exit 0, additionalContext):
 *   SessionStart, SessionEnd, PreCompact, PostCompact, UserPromptSubmit,
 *   SubagentStart, SubagentStop, Stop, Notification, Interrupt.
 * Eventos de INTERCEPTAÇÃO de ferramenta:
 *   PreToolUse  → decisão REAL: stdout JSON com hookSpecificOutput
 *                 { permissionDecision: "allow"|"deny", permissionDecisionReason }
 *                 e, no deny, exit 2 + razão no stderr (mecanismo de bloqueio
 *                 por exit code do runtime). A CLI PRESERVA essa decisão.
 *   PostToolUse → auditoria informativa (a ferramenta já executou; bloquear aqui
 *                 esconderia o resultado, não protegeria ação — não afirmamos
 *                 proteção inexistente).
 *
 * LIMITES REAIS: a política depende do runtime honrar o hook. Não é sandbox —
 * um agente determinado pode tentar contornar, e ferramentas fora do matcher
 * `Bash|apply_patch` (MCP, unified exec) NÃO são interceptadas por padrão.
 * Bloqueio rígido externo (sandbox do Codex) é pendência de aceite, não
 * implementado aqui.
 */
export interface HookInput {
  hook_event_name?: string;
  type?: string; event?: string; session_id?: string; session?: { id?: string };
  cwd?: string; working_directory?: string; directory?: string;
  project_id?: string; projectId?: string; role?: string;
  token?: string; launch_token?: string;
  trigger?: string; // PreCompact/PostCompact
  tool_name?: string; tool?: string;
  command?: string; file_path?: string;
  tool_input?: { command?: string; file_path?: string };
}

/** Eventos de contexto/retomada: devolvem persona (+ política informativa), sem interceptar. */
const CONTEXT_EVENTS = new Set([
  'PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop',
  'SubagentStart', 'SubagentStop', 'Notification', 'Interrupt',
]);

export const SUPPORTED_EVENTS = [
  'SessionStart', 'SessionEnd',
  'PreToolUse', 'PostToolUse',
  ...CONTEXT_EVENTS,
] as const;

export interface HookOutput {
  /** JSON puro emitido no stdout — formato wire que o Codex interpreta. */
  json: string;
  /** 0 = allow/ok; 2 = bloqueio (deny de PreToolUse; stderr carrega a razão). */
  exitCode: 0 | 2;
  /** Razão do bloqueio, escrita no stderr (mecanismo exit-2 do runtime). */
  stderr?: string;
}

/** Envelope wire: { hookSpecificOutput: { hookEventName, ...campos do evento } }. */
function wire(event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Estado tolerante a store não inicializado (hook não pode explodir por ausência de runtime.json). */
async function safeState(registry: SessionRegistry): Promise<Runtime> {
  try { return await registry.state(); }
  catch { return emptyRuntime(''); }
}

interface PolicyEnv { protectedPaths: string[]; protectedBranches: string[]; projectRoot: string; worktreesDir: string; }

/**
 * R4-09 — resolve a configuração do projeto PRINCIPAL a partir do cwd do
 * payload (worktree/subdiretório sobem até o checkout com .sdlc-codex).
 * Falha PROPAGA (o chamador decide: PreToolUse nega — falha fechada; eventos
 * de contexto apenas informam). Nunca relaxa a política silenciosamente.
 */
async function policyEnvFrom(cwd: string | undefined, expectedProjectId?: string): Promise<PolicyEnv> {
  const start = cwd && cwd.trim() ? cwd : process.cwd();
  // Integração M5: o launcher exporta SDLC_CODEX_PROJECT_ROOT no env da tab —
  // preferir sobre a derivação por cwd (worktree do dev não tem .sdlc-codex e o
  // catch silencioso relaxaria a política de branches protegidos).
  const fromEnv = process.env.SDLC_CODEX_PROJECT_ROOT;
  const projectRoot = fromEnv && fromEnv.trim() ? fromEnv : await findProjectRoot(start);
  const config = await loadConfig(join(projectRoot, '.sdlc-codex', 'config.json'));
  // Revisão C/A6 + V1-3: o env NÃO é confiado às cegas. A raiz informada deve ser a do MESMO projeto de referência:
  // o projectId do estado do hook OU, quando o estado está ausente/ilegível (verificação V1), o projectId da configuração da
  // raiz derivada do cwd da ação. Sem nenhuma referência, só se confia no env se o cwd da ação está DENTRO dessa raiz — do
  // contrário nega (a guarda nunca desliga em silêncio).
  if (fromEnv && fromEnv.trim()) {
    let expected = expectedProjectId;
    if (!expected) {
      try {
        const derived = await findProjectRoot(start);
        if (derived !== projectRoot) expected = (await loadConfig(join(derived, '.sdlc-codex', 'config.json'))).projectId;
      } catch { /* sem referência derivável: cai na checagem de contenção abaixo */ }
    }
    if (expected && config.projectId !== expected) {
      throw new Error(`projectId da configuração em ${projectRoot} (${config.projectId}) diverge do projeto de referência (${expected}); SDLC_CODEX_PROJECT_ROOT não confiável`);
    }
    if (!expected && !isInside(start, projectRoot)) {
      throw new Error(`SDLC_CODEX_PROJECT_ROOT (${projectRoot}) não verificável: sem projectId de referência (estado ausente/ilegível) e o cwd da ação está fora dessa raiz; política falha fechada`);
    }
  } else if (expectedProjectId && config.projectId !== expectedProjectId) {
    throw new Error(`projectId da configuração em ${projectRoot} (${config.projectId}) diverge do projeto da sessão (${expectedProjectId})`);
  }
  return {
    protectedPaths: [...new Set(['.sdlc-codex', '.git', ...config.protectedPaths])],
    protectedBranches: config.prBase ? [config.prBase] : [],
    projectRoot,
    // R5-09: área de trabalho do dev (worktrees do produto) — exceção ligada ao projeto ao
    // `.sdlc-codex` protegido; os operacionais (runtime.json, state.lock*, config, evidence) seguem protegidos.
    worktreesDir: join(projectRoot, '.sdlc-codex', 'worktrees'),
  };
}

/**
 * R5-09 — raízes de worktree EXTERNAS à árvore principal em que a ação roda (dentro da
 * árvore, o policy deriva a raiz de worktreesDir). Nunca relaxa por cwd externo: sem
 * registro da sessão, o próprio cwd vira raiz e os protegidos lógicos valem nele.
 */
function externalWorkRoots(env: PolicyEnv, cwd: string | undefined, sessionCwd: string | undefined): string[] {
  if (!cwd || isInside(cwd, env.projectRoot)) return [];
  return [cwd, ...(sessionCwd && isInside(cwd, sessionCwd) ? [sessionCwd] : [])];
}

/** Política única dos dois caminhos (PreToolUse e evento de contexto): ação no cwd, configuração na raiz. */
function verdictFor(
  env: PolicyEnv,
  facts: ReturnType<typeof toolFacts> & { action: 'write' | 'git' },
  cwd: string | undefined,
  sessionCwd: string | undefined,
): { allowed: boolean; reason?: string } {
  return checkPolicy({
    action: facts.action, tool: facts.tool, command: facts.command, path: facts.path,
    protectedPaths: env.protectedPaths,
    protectedBranches: env.protectedBranches,
    baseDir: cwd ?? env.projectRoot,
    projectRoot: env.projectRoot,
    worktreesDir: env.worktreesDir,
    workRoots: externalWorkRoots(env, cwd, sessionCwd),
  });
}

/** Extrai ferramenta/comando/caminho do payload (tool_name/tool_input do wire do Codex). */
function toolFacts(value: HookInput & Record<string, unknown>):
  { tool?: string; command?: string; path?: string; action?: 'write' | 'git' } {
  const tool = typeof value.tool_name === 'string' ? value.tool_name
    : typeof value.tool === 'string' ? value.tool : undefined;
  const input = isObject(value.tool_input) ? value.tool_input : undefined;
  // R5-09: `command` em vetor de strings (argv do shell) vira texto; outro tipo é ignorado e,
  // numa ferramenta de patch, o policy nega por falta de conteúdo (nunca allow).
  const asText = (raw: unknown): string | undefined => typeof raw === 'string' ? raw
    : Array.isArray(raw) && raw.every(part => typeof part === 'string') ? raw.join('\n') : undefined;
  const command = asText(value.command) ?? asText(input?.command);
  const path = typeof value.file_path === 'string' ? value.file_path
    : typeof input?.file_path === 'string' ? input.file_path : undefined;
  const isPatch = tool === 'apply_patch' || (command ?? '').includes('apply_patch');
  const action = isPatch ? 'write' as const
    : /^\s*git\b/i.test(command ?? '') ? 'git' as const
      : path ? 'write' as const
        : undefined;
  return { tool, command, path, action };
}

/** cwd registrado da sessão do payload (worktree do dev), quando conhecida. */
function sessionCwdOf(state: Runtime, value: HookInput): string | undefined {
  const sid = String(value.session_id ?? value.session?.id ?? '');
  return sid ? state.sessions.find(s => s.threadId === sid)?.cwd : undefined;
}

/** Papel efetivo do payload (campo ou ambiente do lançamento). */
function payloadRole(value: HookInput): string | undefined {
  return value.role ?? env('SDLC_CODEX_ROLE');
}

/**
 * R4-09 — valida identidade de papel/sessão para eventos de interceptação:
 * - session_id presente e registro legível: a sessão DEVE existir neste projeto
 *   (senão deny — sessão não registrada; falha fechado);
 * - papel informado no payload deve coincidir com o papel da sessão registrada
 *   (senão deny — identidade divergente).
 */
async function identityDeny(
  registry: SessionRegistry,
  value: HookInput,
): Promise<string | undefined> {
  const sid = String(value.session_id ?? value.session?.id ?? '');
  const roleValue = payloadRole(value);
  const state = await safeState(registry);
  if (sid) {
    const session = state.sessions.find(s => s.threadId === sid);
    if (state.sessions.length > 0 && !session) {
      return `sessão ${sid} não registrada neste projeto; política falha fechada`;
    }
    if (session && roleValue && isRole(roleValue) && session.role !== roleValue) {
      return `identidade divergente: papel da sessão (${session.role}) difere do informado (${roleValue})`;
    }
  }
  if (roleValue && !isRole(roleValue)) {
    return `papel inválido no payload: ${roleValue}`;
  }
  return undefined;
}

/** PreToolUse/PostToolUse: interceptação real (PreToolUse) ou auditoria (PostToolUse). */
async function handleToolEvent(
  registry: SessionRegistry,
  value: HookInput & Record<string, unknown>,
  event: 'PreToolUse' | 'PostToolUse',
): Promise<HookOutput> {
  const blocking = event === 'PreToolUse';
  const roleValue = payloadRole(value);
  const cwdValue = typeof value.cwd === 'string' ? value.cwd : undefined;
  const state = await safeState(registry);
  const ctx = roleValue && isRole(roleValue) ? roleContext(state, roleValue) : undefined;
  const withCtx = (fields: Record<string, unknown>): Record<string, unknown> =>
    ctx ? { ...fields, additionalContext: ctx } : fields;

  const deny = (reason: string): HookOutput => blocking
    ? { json: wire(event, withCtx({ permissionDecision: 'deny', permissionDecisionReason: reason })), exitCode: 2, stderr: reason }
    : // PostToolUse não bloqueia ação (já executou): auditoria no contexto apenas.
      { json: wire(event, withCtx({})), exitCode: 0 };

  const identError = await identityDeny(registry, value);
  if (identError) return deny(identError);

  let env: PolicyEnv;
  try {
    env = await policyEnvFrom(cwdValue, state.projectId || undefined);
  } catch (error) {
    return deny(`configuração do projeto não localizada a partir de ${cwdValue ?? process.cwd()}: ${(error as Error).message}; política falha fechada`);
  }

  const { tool, command, path, action } = toolFacts(value);
  if (!tool && !command && !path) {
    // Contexto sem ferramenta: nenhuma decisão de ferramenta a tomar.
    return { json: wire(event, withCtx({})), exitCode: 0 };
  }
  if (!action) {
    return blocking
      ? { json: wire(event, withCtx({ permissionDecision: 'allow' })), exitCode: 0 }
      : { json: wire(event, withCtx({})), exitCode: 0 };
  }
  let verdict: { allowed: boolean; reason?: string };
  try {
    verdict = verdictFor(env, { tool, command, path, action }, cwdValue, sessionCwdOf(state, value));
  } catch (error) {
    // R5-09: erro ao avaliar NUNCA vira allow (exit 1 do processo não bloqueia no runtime).
    return deny(`falha ao avaliar a política: ${(error as Error).message}; política falha fechada`);
  }
  if (!verdict.allowed) return deny(verdict.reason ?? 'política negativa');
  const audit = `Política ${event}: allow${tool ? ` (${tool})` : ''}.`;
  return {
    json: wire(event, withCtx({
      permissionDecision: 'allow',
      ...(ctx ? { additionalContext: `${ctx}\n${audit}` } : {}),
    })),
    exitCode: 0,
  };
}

/** Eventos de contexto: persona + política INFORMATIVA (sem bloqueio real). */
async function handleContextEvent(
  registry: SessionRegistry,
  value: HookInput & Record<string, unknown>,
  event: string,
): Promise<HookOutput> {
  const state = await safeState(registry);
  const roleValue = payloadRole(value);
  const cwdValue = typeof value.cwd === 'string' ? value.cwd : undefined;
  const ctx = roleValue && isRole(roleValue) ? roleContext(state, roleValue) : undefined;

  let policyNote: string | undefined;
  try {
    const env = await policyEnvFrom(cwdValue, state.projectId || undefined);
    const { tool, command, path, action } = toolFacts(value);
    if (tool || command || path) {
      if (action) {
        const verdict = verdictFor(env, { tool, command, path, action }, cwdValue, sessionCwdOf(state, value));
        policyNote = verdict.allowed
          ? `Política (informativa): allow.`
          : `Política (informativa): NEGADA — ${verdict.reason}. Ação correspondente será bloqueada no PreToolUse.`;
      }
    }
  } catch (error) {
    policyNote = `Política: configuração não localizada (${(error as Error).message}); nenhuma decisão tomada neste evento.`;
  }

  const additionalContext = [ctx, policyNote].filter(Boolean).join('\n');
  return { json: wire(event, additionalContext ? { additionalContext } : {}), exitCode: 0 };
}

export async function handleHook(registry: SessionRegistry, input: unknown): Promise<HookOutput> {
  if (!input || typeof input !== 'object') throw new Error('payload de hook inválido');
  const value = input as HookInput & Record<string, unknown>;
  const event = String(value.hook_event_name ?? value.type ?? value.event ?? '');
  if (event === 'SessionEnd') {
    const sid = String(value.session_id ?? value.session?.id ?? '');
    if (!sid) throw new Error('SessionEnd sem session_id');
    await registry.event(sid, 'closed');
    return { json: wire('SessionEnd', {}), exitCode: 0 };
  }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    return handleToolEvent(registry, value, event);
  }
  if (CONTEXT_EVENTS.has(event)) {
    return handleContextEvent(registry, value, event);
  }
  if (event !== 'SessionStart') {
    throw new Error(`evento de hook não suportado: ${event || '(ausente)'}; suportados: ${SUPPORTED_EVENTS.join(', ')}`);
  }
  const record = await registry.register({
    event,
    session_id: String(value.session_id ?? value.session?.id ?? ''),
    cwd: String(value.cwd ?? value.working_directory ?? value.directory ?? ''),
    project_id: value.project_id ?? value.projectId ?? env('SDLC_CODEX_PROJECT_ID'),
    role: value.role ?? env('SDLC_CODEX_ROLE'),
    token: value.token ?? value.launch_token ?? env('SDLC_CODEX_LAUNCH_TOKEN'),
  });
  const state = await registry.state();
  const ctx = roleContext(state, record.role);
  return { json: wire('SessionStart', { additionalContext: ctx }), exitCode: 0 };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}
