#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { StateStore, StateConflictError, StateCorruptError } from './state/store.js';
import { adopt } from './project/adopt.js';
import { loadConfig, findProjectRoot, type ProjectConfig } from './project/config.js';
import { statusReport, validateEvidenceImport, validateRequirementsManifest, validateManifestAgainstPlan, type EvidenceGateContext, type PrObservation } from './evidence/report.js';
import { SnapshotCaptureError, captureCodeSnapshot } from './evidence/snapshot.js';
import { CodexTransport } from './adapters/codex.js';
import { NodeProcessRunner, resolveNativeCodexExecutable, type ProcessRunner, type ProcessResult } from './adapters/process.js';
import { HerdrProcessAdapter, type HerdrAdapter } from './adapters/herdr.js';
import { GitAdapter, GhAdapter } from './adapters/git.js';
import { MessageService, type RecoverOptions } from './messages/service.js';
import { SessionRegistry } from './sessions/registry.js';
import { TeamLauncher } from './sessions/launcher.js';
import { applyCompletion, startRun, validateCompletion } from './pipeline/engine.js';
import { workflowStages, stageOwner, nextStage } from './pipeline/workflows.js';
import { operationIdentityOf } from './pipeline/operation-identity.js';
import { appendPrIntent, blockingPrIntents, latestPrIntent, PrLedgerError, PR_INTENT_RESERVED, PR_INTENT_UPDATED } from './pipeline/pr-intents.js';
import { runCheck, requiredChecksForConfig, type CheckResult } from './evidence/checks.js';
import { handleHook } from './hooks/entry.js';
import { id, isRole, isStage, isWorkflow, type Actor, type CodeSnapshot, type PrIntent, type Role, type Run, type Runtime, type Stage, type StageCompletion, type Workflow, type Evidence, type Message, type PullRequestRef, type RequirementsManifest } from './contracts.js';
const ALL_STAGES: Stage[] = ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'];
function emptyAttempts(): Record<Stage, number> { return Object.fromEntries(ALL_STAGES.map(s => [s, 0])) as Record<Stage, number>; }
function emptyGapFailures(): Partial<Record<Stage, { gapId: string; count: number }>> { return Object.fromEntries(ALL_STAGES.map(s => [s, undefined])) as Partial<Record<Stage, { gapId: string; count: number }>>; }

export const HELP = `sdlc-codex — pipeline local por sessões Codex

Comandos:
  doctor [--project <path>] [--json]
    Diagnóstico SOMENTE LEITURA: nunca inicia sessões, não recupera nem remove
    locks, não repara estado e não envia nada. Cobre: versões/capacidades
    (node, codex --version, suporte a hooks via 'codex features list'
    informativo, 'codex queue --help', herdr --version), hooks locais
    (.codex/hooks.json do projeto), config do projeto (válida/inválida/
    identidade), raiz/worktree da demanda em execução, locks (presença e
    liveness lidos de owner.json, SEM remover), registro versus inventário
    Herdr, entregas 'uncertain' e runs (running/blocked/exhausted).
    Cada item tem status: healthy | warning | unavailable | unknown.
    Exit doctor: 0 = tudo saudável; 1 = aviso/unknown/unavailable (diagnóstico
    NÃO fatal); 2 = uso inválido. Com --json devolve { status, checks } com
    campo status por item e status geral.
  adopt --config <file> [--project <path>] [--apply] [--json]
  up <slug> [--workflow feature|hotfix|review-only] [--roles r1,r2 [--replace-unknown]] [--trust-project] [--bypass-hook-trust] [--windows-sandbox elevated|unelevated] [--project <path>] [--json]
    --replace-unknown (só com --roles): o humano declara PERDIDA uma sessão 'unknown' ambígua (inventário do Herdr
    indisponível) e autoriza nova geração; auditado. Sem a flag, unknown nunca é substituída sem prova de morte.
    --bypass-hook-trust: opt-in explícito para automação em que os hooks foram verificados fora do Codex; encaminha
    a flag oficial --dangerously-bypass-hook-trust sem alterar sandbox nem política de aprovação.
    --trust-project: opt-in explícito para selecionar "Yes, continue" somente quando o prompt exato de confiança
    aparecer no pane recém-criado. A decisão é persistida pelo próprio Codex para o caminho do projeto.
    --windows-sandbox: seleciona a implementação nativa somente para as sessões abertas por este comando.
    Use unelevated como fallback oficial quando o setup elevated falhar; o sandbox continua ativo.
  status [<slug>] [--project <path>] [--json]
  start <slug> --intent <path> --plan <path> --approval <path> [--workflow <workflow>] [--project <path>] [--json]
  send --to <role> --from <role> --type question|answer|notify --body-file <path> [--run <runId>] [--reply-to <id>] [--project <path>] [--json]
  receive <message-id> --role <role> --thread <uuid> --generation <id> [--checkpoint <path>] [--project <path>] [--json]
  finish-message <message-id> --role <role> --thread <uuid> --generation <id> [--checkpoint <path>] [--project <path>] [--json]
  check <slug> --stage <stage> [--project <path>] [--json]
  next <slug> <stage> pass|fail --revision <n> --operation-id <id> --evidence <path> [--gap <id>] [--blocked <reason>] [--commit <sha>] [--role <role>] [--thread <uuid>] [--generation <id>] [--project <path>] [--json]
  recover [<slug>] [--limit <n>] [--claim <message-id> --role <r> --thread <uuid> --generation <id>] [--project <path>] [--json]
  hook <evento> [--payload-file <path>] [--project <path>] [--json]
    Eventos de contexto (exit 0, additionalContext): SessionStart, SessionEnd,
    PreCompact, PostCompact, UserPromptSubmit, SubagentStart, SubagentStop,
    Stop, Notification, Interrupt.
    Interceptação de ferramenta: PreToolUse (matcher Bash|apply_patch) e
    PostToolUse. PreToolUse NEGA com exit 2 + razão no stderr e
    hookSpecificOutput.permissionDecision "deny" no JSON do stdout (formato que
    o Codex interpreta); protege caminhos (config protectedPaths + .sdlc-codex/
    .git), branch protegida (prBase) e git destrutivo. Falha ao localizar a
    configuração NEGA (falha fechada). Não é sandbox: depende do runtime honrar
    o hook; ferramentas fora do matcher (MCP/unified exec) não são interceptadas.

Códigos: 0 sucesso, 1 falha operacional (em doctor: avisos/unknown/indisponível — diagnóstico não fatal), 2 argumentos/configuração/uso inválidos, 3 conflito de estado, 4 recurso indisponível. Doctor em particular NUNCA inicia nem repara: apenas reporta (exit 0 ou 1; 2 = uso inválido). Up parcial: time incompleto impede o start da demanda (saída JSON partial:true). Hooks: exit 2 = decisão de política (deny), não erro.`;

export interface CliIo { stdout: (value: string) => void; stderr: (value: string) => void; }
/** Dependências injetáveis: testes usam falsos; produção usa adaptadores reais. */
export interface CliDeps {
  runner?: ProcessRunner;
  herdr?: HerdrAdapter;
  stdin?: () => Promise<string>;
  /** Testes podem fornecer o binário; produção o resolve pela instalação npm do Codex. */
  nativeCodexExecutable?: string;
}

export async function runCli(argv: string[], io: CliIo = { stdout: console.log, stderr: console.error }, deps: CliDeps = {}): Promise<number> {
  try {
    if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { io.stdout(HELP); return 0; }
    const json = argv.includes('--json');
    const command = argv[0];
    if (command === 'adopt') return await cmdAdopt(argv, io, json, deps);
    if (!['doctor', 'up', 'status', 'start', 'send', 'receive', 'finish-message', 'check', 'next', 'recover', 'hook'].includes(command)) {
      return fail(io, `comando desconhecido: ${command}`, 2);
    }
    // R07: resolve a raiz principal a partir de cwd/subdiretório/worktree.
    // Integração M5: Git somente leitura para worktree fora da árvore (fallback
    // para ascendência pura quando Git indisponível — contrato de findProjectRoot).
    const runner: ProcessRunner = deps.runner ?? new NodeProcessRunner();
    const project = resolve(value(argv, '--project') ?? await findProjectRoot(process.cwd(), { git: new GitAdapter(runner) }));
    if (command === 'hook') return await cmdHook(argv, io, json, project, deps);
    if (command === 'doctor') return await cmdDoctor(argv, io, json, project, deps);
    if (command === 'status') return await cmdStatus(argv, io, json, project);
    const stateRoot = join(project, '.sdlc-codex');
    const config = await mustConfig(stateRoot);
    const store = new StateStore(stateRoot, { projectId: config.projectId });
    if (command === 'up') return await cmdUp(argv, io, json, project, config, store, deps, runner);
    if (command === 'start') return await cmdStart(argv, io, json, project, config, store, runner);
    if (command === 'send') return await cmdSend(argv, io, json, project, store, runner);
    if (command === 'receive') return await cmdReceive(argv, io, json, project, store, runner);
    if (command === 'finish-message') return await cmdFinish(argv, io, json, project, store, runner);
    if (command === 'check') return await cmdCheck(argv, io, json, project, config, store, runner);
    if (command === 'next') return await cmdNext(argv, io, json, project, store, runner);
    if (command === 'recover') return await cmdRecover(argv, io, json, store, runner);
    return fail(io, `comando desconhecido: ${command}`, 2);
  } catch (error) {
    return mapError(io, error);
  }
}

// ---------- helpers ----------

function value(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(key);
  return index >= 0 ? argv[index + 1] : undefined;
}
function output(io: CliIo, json: boolean, valueToPrint: unknown): number {
  io.stdout(json || typeof valueToPrint !== 'string' ? JSON.stringify(valueToPrint, null, 2) : valueToPrint);
  return 0;
}
function fail(io: CliIo, message: string, code: number): number { io.stderr(message); return code; }
function mapError(io: CliIo, error: unknown): number {
  const message = (error as Error).message ?? String(error);
  if (error instanceof StateConflictError) return fail(io, message, 3);
  // Corrupção com recuperação pendente é falha operacional (1): pede recover explícito, nunca 2.
  if (error instanceof StateCorruptError) return fail(io, message, 1);
  // R5-04/R5-08: captura de snapshot inválida e ledger de PR inválido são falhas OPERACIONAIS
  // fechadas (1) com diagnóstico — nunca viram allow nem ausência opcional de gate.
  if (error instanceof SnapshotCaptureError) return fail(io, `snapshot indisponível (${error.code}): ${message}`, 1);
  if (error instanceof PrLedgerError) return fail(io, message, 1);
  // Identidade/reativação divergente ou ator obsoleto é rejeição de operação (3).
  if (/divergente|obsoleto/i.test(message)) return fail(io, message, 3);
  if (/não está pronto|desconhecid|indisponível|não ficou pronto|parcial|não está ready/i.test(message)) return fail(io, message, 4);
  if (/exige|inválid|desconhecido:|obrigatóri|não encontrad|JSON inválido|workflow|papel/i.test(message)) return fail(io, message, 2);
  return fail(io, message, 1);
}
async function mustConfig(stateRoot: string): Promise<ProjectConfig> {
  // R07: erro de configuração nunca é engolido.
  return loadConfig(join(stateRoot, 'config.json'));
}

/**
 * R5-05/M3-F2 — o manifesto de requisitos PERTENCE à aprovação: o registro de aprovação
 * (approval.json, produzido antes do start) traz `requirementsManifestPath` e
 * `requirementsManifestHash` (sha256 do ARQUIVO). O manifesto não escolhe plano:
 * planPath/planHash dele devem ser os do plano aprovado e cada ID deve constar no texto do
 * plano. O run persiste caminho+hash aprovados; `next`/`check` recarregam o arquivo e
 * recusam qualquer substituição depois do start (reaprovação é explícita).
 * Nenhum modo legado: config não escolhe mais o manifesto.
 */
interface LoadedManifest { manifest: RequirementsManifest; hash: string; }

async function readManifestFile(project: string, relPath: string): Promise<{ text: string; full: string }> {
  const full = resolveIn(project, relPath);
  const rel = relative(resolve(project), resolve(full));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`manifesto de requisitos fora do projeto: ${relPath}`);
  const text = await fs.readFile(full, 'utf8').catch(() => { throw new Error(`manifesto de requisitos não encontrado: ${full}`); });
  return { text, full };
}

function parseManifest(text: string, full: string): Partial<RequirementsManifest> {
  try { return JSON.parse(text) as Partial<RequirementsManifest>; }
  catch { throw new Error(`manifesto de requisitos com JSON inválido: ${full}`); }
}

/** No start: valida o manifesto contra o hash registrado na aprovação E contra o plano aprovado. */
async function loadManifestForApproval(
  project: string, approval: { requirementsManifestPath?: string; requirementsManifestHash?: string; planPath?: string; planHash?: string },
  planPath: string, planText: string,
): Promise<LoadedManifest & { path: string }> {
  if (!approval.requirementsManifestPath || !approval.requirementsManifestHash) {
    throw new Error('aprovação exige requirementsManifestPath e requirementsManifestHash (manifesto de requisitos coberto pela aprovação); execução sem manifesto não inicia');
  }
  const { text, full } = await readManifestFile(project, approval.requirementsManifestPath);
  const hash = sha256(text);
  if (hash !== approval.requirementsManifestHash.toLowerCase()) {
    throw new Error('manifesto de requisitos mudou após a aprovação (hash difere do registrado); nova aprovação necessária');
  }
  const parsed = parseManifest(text, full);
  const manifest = { ...parsed, manifestPath: approval.requirementsManifestPath } as RequirementsManifest;
  const errors = validateRequirementsManifest(manifest);
  if (!errors.length) {
    errors.push(...validateManifestAgainstPlan(manifest, { planPath, planHash: sha256(planText), planText },
      (a, b) => resolveIn(project, a).replace(/\\/g, '/').toLowerCase() === resolveIn(project, b).replace(/\\/g, '/').toLowerCase()));
  }
  if (errors.length) throw new Error(`manifesto de requisitos inválido: ${errors.join('; ')}`);
  return { manifest, hash, path: approval.requirementsManifestPath };
}

/** Em next/check: recarrega o manifesto APROVADO da execução; substituição no meio do fluxo é recusada. */
async function loadApprovedManifest(project: string, run: Run): Promise<LoadedManifest | undefined> {
  const ref = run.approval?.requirementsManifest;
  if (!ref) return undefined; // run legado: o motor recusa pass moderno
  const { text, full } = await readManifestFile(project, ref.path);
  const hash = sha256(text);
  if (hash !== ref.hash.toLowerCase()) {
    throw new Error('manifesto de requisitos divergente do aprovado no start (hash difere); substituição no meio do fluxo exige reaprovação');
  }
  const parsed = parseManifest(text, full);
  const manifest = { ...parsed, manifestPath: ref.path } as RequirementsManifest;
  const errors = validateRequirementsManifest(manifest);
  if (errors.length) throw new Error(`manifesto de requisitos inválido: ${errors.join('; ')}`);
  return { manifest, hash };
}

/** R5-05: identidade estável da configuração efetiva que governa os gates. */
function configHashOf(config: ProjectConfig): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, canon(x)]))
      : v;
  return sha256(JSON.stringify(canon({ prBase: config.prBase, checks: config.checks, protectedPaths: config.protectedPaths })));
}

function assertConfigUnchanged(run: Run, config: ProjectConfig): void {
  if (run.configHash && run.configHash !== configHashOf(config)) {
    throw new Error('configuração divergente da aprovada no start (checks/prBase/protectedPaths mudaram no meio do fluxo); reaprovação e novo start exigidos');
  }
}

function checkSlug(slug: string | undefined): string {
  if (!slug || !/^[\w][\w.-]*$/i.test(slug)) throw new Error(`slug inválido: ${slug ?? '(ausente)'}; use nome com letras, números, ponto, hífen`);
  return slug;
}
function checkRole(role: string | undefined): Role {
  if (!role || !isRole(role)) throw new Error(`papel inválido: ${role ?? '(ausente)'}`);
  return role;
}
function sha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
/** R07: caminhos relativos de operação resolvem contra o projeto, não contra o cwd. */
function resolveIn(project: string, p: string): string { return isAbsolute(p) ? p : join(project, p); }

// ---------- adopt / doctor / status (doctor+status são somente leitura) ----------

async function cmdAdopt(argv: string[], io: CliIo, json: boolean, deps: CliDeps): Promise<number> {
  const configPath = value(argv, '--config');
  if (!configPath) return fail(io, 'adopt exige --config <file>', 2);
  const runner: ProcessRunner = deps.runner ?? new NodeProcessRunner();
  const project = resolve(value(argv, '--project') ?? await findProjectRoot(process.cwd(), { git: new GitAdapter(runner) }));
  const result = await adopt(project, resolve(configPath), argv.includes('--apply'));
  return output(io, json, result);
}

// ---------- doctor (R4-17: diagnóstico SOMENTE LEITURA, 4 estados por item) ----------

type DoctorStatus = 'healthy' | 'warning' | 'unavailable' | 'unknown';
/** Ordem de gravidade para o status geral (exit 0 somente quando tudo é healthy). */
const DOCTOR_SEVERITY: Record<DoctorStatus, number> = { healthy: 0, unknown: 1, warning: 2, unavailable: 3 };
interface DoctorItem { status: DoctorStatus; [key: string]: unknown; }

function worstDoctorStatus(statuses: DoctorStatus[]): DoctorStatus {
  let worst: DoctorStatus = 'healthy';
  for (const s of statuses) if (DOCTOR_SEVERITY[s] > DOCTOR_SEVERITY[worst]) worst = s;
  return worst;
}

const PROBE_DEAD: ProcessResult = { exitCode: null, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };

/** Liveness de PID para concorrência de efeitos externos (M8/N1): existência
 *  confere via process.kill(pid, 0) — ESRCH confiável também no Windows. */
function pidLooksAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * R5-01/R5-02 — inspeção SOMENTE LEITURA da exclusão de estado: a autoridade é uma
 * primitiva do SO (handle exclusivo com liberação por morte do processo); StateStore.lockStatus()
 * apenas SONDA (connect) e lê a informação de diagnóstico — nunca adquire, nunca remove.
 * Artefatos inertes de crash (leftovers) são reportados; a limpeza é o recover explícito.
 */
async function inspectLockReadOnly(store: StateStore): Promise<DoctorItem> {
  const lock = await store.lockStatus();
  const info = lock.info ? { pid: lock.info.pid, acquiredAt: lock.info.acquiredAt } : undefined;
  if (lock.held === 'yes') return { status: 'healthy', present: true, held: 'yes', owner: info, leftovers: lock.leftovers, detail: 'lock detido por processo vivo (autoridade do SO) — região crítica legítima em andamento' };
  if (lock.held === 'unknown') return { status: 'unknown', present: false, held: 'unknown', owner: info, leftovers: lock.leftovers, detail: 'sonda de exclusão inconclusiva; tratado como ocupado (fail closed)' };
  if (lock.leftovers.length) {
    return { status: 'warning', present: false, held: 'no', owner: info, leftovers: lock.leftovers, detail: 'ninguém detém o lock; restam artefatos INERTES de crash (nunca autoridade); o próximo detentor os sobrescreve ou o recover explícito os remove — doctor NUNCA remove' };
  }
  return { status: 'healthy', present: false, held: 'no', leftovers: [], detail: 'ausente — nenhum lock' };
}

/**
 * M7-F3 (R4-17) — doctor completo e SOMENTE LEITURA. Distingue quatro estados
 * por item: healthy / warning / unavailable / unknown. Nunca inicia sessões,
 * não recupera nem remove locks, não repara estado, não envia mensagens e não
 * grava nada — a revisão do estado é idêntica antes/depois. Exit: 0 = tudo
 * saudável; 1 = qualquer aviso/unknown/unavailable (diagnóstico, NÃO fatal);
 * 2 = uso inválido. Com --json devolve { status, checks } estruturado.
 */
async function cmdDoctor(argv: string[], io: CliIo, json: boolean, project: string, deps: CliDeps): Promise<number> {
  if (argv[1] && !argv[1].startsWith('-')) return fail(io, `uso inválido: doctor não aceita argumentos posicionais ('${argv[1]}')`, 2);
  const runner = deps.runner ?? new NodeProcessRunner();
  const transport = new CodexTransport(runner);
  const herdr = deps.herdr ?? new HerdrProcessAdapter(runner);
  const stateRoot = join(project, '.sdlc-codex');
  const checks: Record<string, unknown> = { project };

  // 1. node: versão/capacidade (contrato do produto: Node.js 22+).
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.node = nodeMajor >= 22
    ? { status: 'healthy', version: process.version, detail: 'contrato >= 22 atendido' }
    : { status: 'warning', version: process.version, detail: `node ${process.version} abaixo do contrato (>= 22)` };

  // codex: versão e capacidade de queue (daemon é diagnóstico separado — um
  // aviso de daemon NUNCA é reportado como transporte morto, e queue disponível
  // não prova daemon saudável).
  const codexVersion = await transport.probe(['--version']).catch(() => PROBE_DEAD);
  const codexOk = codexVersion.exitCode === 0;
  checks.codex = {
    status: codexOk ? 'healthy' : 'unavailable', available: codexOk,
    version: codexVersion.stdout.trim() || codexVersion.stderr.trim() || undefined,
    ...(codexVersion.timedOut ? { detail: 'timeout na consulta de versão' } : {}),
  };
  if (!codexOk) {
    checks.codexHooks = { status: 'unknown', detail: 'codex indisponível; suporte a hooks não verificável (item informativo)' };
  } else {
    const features = await transport.probe(['features', 'list']).catch(() => PROBE_DEAD);
    if (features.exitCode !== 0) {
      checks.codexHooks = { status: 'unknown', detail: "'codex features list' indisponível; suporte a hooks não verificável (item informativo)" };
    } else {
      const supported = /hooks/i.test(features.stdout);
      checks.codexHooks = supported
        ? { status: 'healthy', supported, detail: 'feature hooks listada (informativo)' }
        : { status: 'warning', supported, detail: 'feature hooks NÃO listada; os hooks do projeto podem não disparar' };
    }
  }
  const queueHelp = await transport.probe(['queue', '--help']).catch(() => PROBE_DEAD);
  checks.queue = {
    status: queueHelp.exitCode === 0 ? 'healthy' : 'unavailable', available: queueHelp.exitCode === 0,
    detail: 'transporte queue por subprocesso; daemon é diagnóstico separado — queue disponível não prova daemon saudável e um aviso de daemon não diagnostica o transporte como morto',
  };
  const herdrVersion = await runner.run('herdr', ['--version'], { timeoutMs: 10_000 }).catch(() => PROBE_DEAD);
  const herdrOk = herdrVersion.exitCode === 0;
  checks.herdr = { status: herdrOk ? 'healthy' : 'unavailable', available: herdrOk, version: herdrVersion.stdout.trim() || undefined };

  // 2. Hooks locais do projeto: .codex/hooks.json (arquivo de config do Codex
  // no projeto) presente/ausente, válido/inválido e com entradas gerenciadas.
  const hooksFile = join(project, '.codex', 'hooks.json');
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(hooksFile, 'utf8'));
    const managed: string[] = [];
    const section = parsed && typeof parsed === 'object' ? (parsed as { hooks?: unknown }).hooks : undefined;
    if (section && typeof section === 'object') {
      for (const [event, matchers] of Object.entries(section as Record<string, unknown>)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers) {
          const entries = matcher && typeof matcher === 'object' ? (matcher as { hooks?: unknown }).hooks : undefined;
          if (Array.isArray(entries) && entries.some(e =>
            e && typeof e === 'object' && typeof (e as { command?: unknown }).command === 'string' &&
            (e as { command: string }).command.trim() === `sdlc-codex hook ${event}`)) {
            managed.push(event);
          }
        }
      }
    }
    checks.localHooks = managed.length
      ? { status: 'healthy', file: hooksFile, managedEvents: managed }
      : { status: 'warning', file: hooksFile, managedEvents: managed, detail: 'hooks.json válido mas sem entradas gerenciadas do produto; execute adopt --apply' };
  } catch (e) {
    checks.localHooks = (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'unknown', file: hooksFile, detail: 'hooks.json ausente; projeto não adotado ou hooks locais não instalados' }
      : { status: 'warning', file: hooksFile, detail: `hooks.json ilegível/inválido: ${(e as Error).message}` };
  }

  // 3. Config do projeto: válida / inválida / identidade (versus o estado).
  let config: ProjectConfig | undefined;
  try {
    config = await loadConfig(join(stateRoot, 'config.json'));
    checks.config = { status: 'healthy', valid: true, projectId: config.projectId };
  } catch (e) {
    const message = (e as Error).message;
    checks.config = /não encontrada/.test(message)
      ? { status: 'unknown', valid: false, detail: message }
      : { status: 'warning', valid: false, error: message };
  }

  // Runtime: leitura tolerante e SOMENTE leitura (nunca init, recover, migrate
  // com escrita — o backup pré-migração do store exige opção de projectId; aqui
  // usamos store sem projectId apenas para ler; migração v1 NÃO ocorre porque
  // readCandidate só migra ao detectar v1 — e nesse caso o backup é uma cópia,
  // o que violaria zero-mutação; então detectamos v1 sem chamar read()).
  const probeStore = new StateStore(stateRoot);
  let state: Runtime | undefined;
  let stateReadError: string | undefined;
  try {
    const rawState = await fs.readFile(probeStore.runtimePath, 'utf8').catch(() => undefined);
    if (rawState === undefined) {
      const backup = await fs.readFile(probeStore.backupPath, 'utf8').catch(() => undefined);
      stateReadError = backup !== undefined
        ? 'runtime principal ausente; backup válido presente; recuperação explícita necessária (recover) — doctor não recupera'
        : 'runtime.json e backup ausentes ou inválidos; projeto não inicializado';
    } else if (/"schemaVersion"\s*:\s*1\b/.test(rawState)) {
      stateReadError = 'runtime em schemaVersion 1 (legado); migração exigida — doctor não migra nem grava backup';
    } else {
      state = await probeStore.read();
    }
  } catch (e) {
    stateReadError = (e as Error).message;
  }
  if (state) {
    checks.runtime = { status: 'healthy', readable: true, revision: state.revision, projectId: state.projectId };
    checks.sessions = state.sessions.map(s => ({ role: s.role, status: s.status, generationId: s.generationId }));
  } else {
    checks.runtime = { status: /ausentes|não inicializado/.test(stateReadError ?? '') ? 'unknown' : 'warning', readable: false, error: stateReadError };
  }
  // Identidade: config válida versus estado legível.
  if (config && state && config.projectId !== state.projectId) {
    checks.config = { ...(checks.config as object), status: 'warning', identity: 'divergente', runtimeProjectId: state.projectId, detail: 'projectId da config diverge do estado persistido' };
  }

  // 4. Raiz/worktree: raiz resolvida e worktree da demanda quando houver run running.
  const rootExists = await fs.stat(project).then(() => true, () => false);
  const running = state?.runs.filter(r => r.status === 'running') ?? [];
  const worktrees: Array<{ slug: string; path: string; exists: boolean }> = [];
  for (const run of running) {
    if (run.worktree) worktrees.push({ slug: run.slug, path: run.worktree, exists: await fs.stat(run.worktree).then(() => true, () => false) });
  }
  const missingWorktrees = worktrees.filter(w => !w.exists);
  checks.root = {
    status: !rootExists || missingWorktrees.length ? 'warning' : 'healthy',
    path: project, exists: rootExists, worktrees,
    ...(missingWorktrees.length ? { detail: `worktree da demanda em execução ausente no disco: ${missingWorktrees.map(w => w.slug).join(', ')}` } : {}),
  };

  // 5. Lock de estado: sonda SOMENTE LEITURA da autoridade do SO + artefatos inertes;
  // NUNCA adquirir, remover nem recuperar aqui.
  const lockItem = await inspectLockReadOnly(probeStore);
  checks.locks = { ...lockItem };
  checks.lock = { present: lockItem.present === true, status: lockItem.status }; // compat: consumidores legados de doctor

  // 6. Registro versus inventário Herdr: divergência => warning; inventário
  // indisponível/ambíguo => unknown (nunca confirma saúde).
  const activeSessions = state?.sessions.filter(s => ['ready', 'launching'].includes(s.status)) ?? [];
  if (!state || activeSessions.length === 0) {
    checks.inventory = { status: 'healthy', registered: 0, detail: 'sem sessões ativas registradas; nada a confrontar com o inventário' };
  } else if (!herdrOk) {
    checks.inventory = { status: 'unknown', registered: activeSessions.length, detail: 'herdr indisponível; inventário não verificável — divergência não comprovável' };
  } else if (!activeSessions.every(s => typeof s.paneId === 'string' && s.paneId.length)) {
    checks.inventory = { status: 'unknown', registered: activeSessions.length, detail: 'sessões ativas sem paneId; confronto com inventário não conclusivo' };
  } else {
    try {
      const agents = await herdr.listAgents();
      const panes = new Set(agents.map(a => a.paneId).filter((p): p is string => typeof p === 'string' && p.length > 0));
      const missing = activeSessions.filter(s => !panes.has(s.paneId as string));
      checks.inventory = missing.length
        ? {
            status: 'warning', registered: activeSessions.length, inInventory: agents.length,
            missing: missing.map(s => ({ role: s.role, paneId: s.paneId })),
            detail: 'sessões registradas sem correspondente no inventário Herdr (aba fechada ou inventário defasado); relançamento cabe ao up',
          }
        : { status: 'healthy', registered: activeSessions.length, inInventory: agents.length };
    } catch (e) {
      checks.inventory = { status: 'unknown', registered: activeSessions.length, detail: `inventário Herdr indisponível: ${(e as Error).message}` };
    }
  }

  // 7. Entregas incertas: 'uncertain' pendentes de reconciliação (recover explícito).
  const uncertain = state?.deliveries.filter(d => d.status === 'uncertain') ?? [];
  checks.uncertainDeliveries = uncertain.length
    ? { status: 'warning', count: uncertain.length, detail: "entregas 'uncertain' pendentes de reconciliação; recover explícito — doctor não repara" }
    : { status: 'healthy', count: 0 };

  // 8. Runs: running/blocked/exhausted(thrash) e operações rejeitadas pendentes.
  const allRuns = state?.runs ?? [];
  const blockedRuns = allRuns.filter(r => r.status === 'blocked');
  const exhaustedRuns = allRuns.filter(r => r.status === 'exhausted' || r.status === 'thrash');
  const rejectedOps = state ? Object.values(state.operations).filter(o => !o.accepted && o.status === 'rejected').length : 0;
  checks.runs = {
    status: blockedRuns.length || exhaustedRuns.length ? 'warning' : 'healthy',
    running: running.map(r => ({ slug: r.slug, stage: r.stage, runId: r.runId })),
    blocked: blockedRuns.map(r => ({ slug: r.slug, stage: r.stage, reason: r.blockedReason })),
    exhausted: exhaustedRuns.map(r => ({ slug: r.slug, status: r.status })),
    rejectedOperations: rejectedOps,
    ...(blockedRuns.length ? { detail: 'execução bloqueada exige intervenção (limite de correção/escopo)' } : {}),
  };

  // Status geral = pior estado entre os itens; daemon é nota informativa legada.
  const itemStatuses = Object.values(checks).filter((c): c is DoctorItem =>
    !!c && typeof c === 'object' && typeof (c as DoctorItem).status === 'string').map(c => c.status);
  const overall = worstDoctorStatus(itemStatuses);
  checks.daemon = 'diagnóstico separado; disponibilidade de queue não depende do daemon e um aviso de daemon não diagnostica o transporte como morto';
  output(io, json, { project, status: overall, checks });
  // Exit doctor: 0 = saudável; 1 = aviso/unknown/unavailable (NÃO fatal). Nunca
  // inicia, repara ou recupera a partir daqui.
  return overall === 'healthy' ? 0 : 1;
}

async function cmdStatus(argv: string[], io: CliIo, json: boolean, project: string): Promise<number> {
  // R01: status nunca cria, recupera ou altera estado.
  const store = new StateStore(join(project, '.sdlc-codex'));
  const slug = argv[1] && !argv[1].startsWith('-') ? checkSlug(argv[1]) : undefined;
  const state = await store.read();
  return output(io, json, statusReport(state, slug));
}

// ---------- up ----------

async function cmdUp(argv: string[], io: CliIo, json: boolean, project: string, config: ProjectConfig, store: StateStore, deps: CliDeps, runner: ProcessRunner): Promise<number> {
  const slug = checkSlug(argv[1] && !argv[1].startsWith('-') ? argv[1] : undefined);
  const workflowOpt = value(argv, '--workflow') ?? 'feature';
  if (!isWorkflow(workflowOpt)) return fail(io, `workflow inválido: ${workflowOpt}`, 2);
  const workflow: Workflow = workflowOpt;
  const defaultRoles = workflowStages[workflow].map(s => stageOwner[s]).filter((r, i, all) => all.indexOf(r) === i);
  // O planner supervisiona todos os workflows e recebe cópias/notificações; sempre parte do time padrão.
  if (!defaultRoles.includes('planner')) defaultRoles.unshift('planner');
  const rolesOpt = value(argv, '--roles');
  const roles = rolesOpt ? rolesOpt.split(',').map(r => checkRole(r.trim())) : defaultRoles;
  const windowsSandboxOpt = value(argv, '--windows-sandbox');
  if (windowsSandboxOpt && windowsSandboxOpt !== 'elevated' && windowsSandboxOpt !== 'unelevated') {
    return fail(io, `sandbox Windows inválido: ${windowsSandboxOpt}; use elevated ou unelevated`, 2);
  }
  if (!rolesOpt && argv.includes('--replace-unknown')) return fail(io, '--replace-unknown exige --roles <papel> (o humano escolhe explicitamente qual sessão declara perdida)', 2);
  if (!roles.length) return fail(io, 'time vazio; informe --roles', 2);
  // Garante estado existente sem destruir: init só cria quando realmente novo;
  // corrupção com backup válido (ou dupla) é recusada com erro explícito.
  await store.init(config.projectId);
  const herdr = deps.herdr ?? new HerdrProcessAdapter(runner);
  const git = new GitAdapter(runner);
  const registry = new SessionRegistry(store);
  const demand = slug;
  const devWorktree = roles.includes('dev') ? join(project, '.sdlc-codex', 'worktrees', demand) : undefined;
  const launcher = new TeamLauncher(herdr, git, registry);
  const nativeCodexExecutable = process.platform === 'win32' && !deps.herdr
    ? deps.nativeCodexExecutable ?? await resolveNativeCodexExecutable('codex')
    : undefined;
  const result = await launcher.launch({
    projectId: config.projectId, projectRoot: project, roles, demand, devWorktree,
    // R5-10: `--roles` é a solicitação HUMANA explícita de relançar/substituir; sem ela, sessão
    // interrompida pelo usuário não é despertada nem substituída automaticamente.
    explicitRoles: !!rolesOpt,
    // R5-10 (revisão C/A4): ação humana explícita para unknown ambíguo; só vale junto de --roles.
    replaceUnknown: !!rolesOpt && argv.includes('--replace-unknown'),
    devBranch: `sdlc/${demand}`, gitBase: config.prBase,
    modelByRole: config.models as Partial<Record<Role, { model?: string; effort?: string }>>,
    nativeCodexExecutable,
    bypassHookTrust: argv.includes('--bypass-hook-trust'),
    trustProject: argv.includes('--trust-project'),
    windowsSandbox: windowsSandboxOpt as 'elevated' | 'unelevated' | undefined,
    bootstrapRegistration: true,
  });
  const partial = result.filter(r => !r.ready);
  if (partial.length) {
    io.stderr(`time parcial: ${partial.map(p => `${p.role} (${p.error})`).join('; ')}; pipeline não inicia`);
    return output(io, json, { slug, workflow, team: result, partial: true });
  }
  return output(io, json, { slug, workflow, team: result, partial: false });
}

// ---------- start ----------

interface ApprovalFile {
  intentPath: string; planPath: string; approvedAt: string; approvedBy: string; intentHash?: string; planHash?: string; planVersion?: string;
  /** R5-05: manifesto de requisitos coberto pela aprovação (caminho no projeto + sha256 do arquivo). */
  requirementsManifestPath?: string; requirementsManifestHash?: string;
}

async function cmdStart(argv: string[], io: CliIo, json: boolean, project: string, config: ProjectConfig, store: StateStore, runner: ProcessRunner): Promise<number> {
  const slug = checkSlug(argv[1]);
  const intentOpt = value(argv, '--intent');
  const planOpt = value(argv, '--plan');
  const approvalOpt = value(argv, '--approval');
  if (!intentOpt || !planOpt || !approvalOpt) return fail(io, 'start exige --intent, --plan e --approval', 2);
  const workflowOpt = value(argv, '--workflow') ?? 'feature';
  if (!isWorkflow(workflowOpt)) return fail(io, `workflow inválido: ${workflowOpt}`, 2);
  // R07: valida workflow, arquivos, data, time e aprovação vinculada aos artefatos/versão.
  const intentPath = resolve(project, intentOpt);
  const planPath = resolve(project, planOpt);
  const approvalPath = resolve(project, approvalOpt);
  const [intentText, planText, approvalRaw] = await Promise.all([
    fs.readFile(intentPath, 'utf8').catch(() => { throw new Error(`intent não encontrado: ${intentPath}`); }),
    fs.readFile(planPath, 'utf8').catch(() => { throw new Error(`plano não encontrado: ${planPath}`); }),
    fs.readFile(approvalPath, 'utf8').catch(() => { throw new Error(`aprovação não encontrada: ${approvalPath}`); }),
  ]);
  if (!intentText.trim()) return fail(io, 'intent vazio', 2);
  if (!planText.trim()) return fail(io, 'plano vazio', 2);
  let approval: ApprovalFile;
  try { approval = JSON.parse(approvalRaw) as ApprovalFile; }
  catch { return fail(io, 'aprovação com JSON inválido', 2); }
  if (!approval.approvedBy || !approval.approvedAt) return fail(io, 'aprovação exige approvedBy e approvedAt', 2);
  if (Number.isNaN(Date.parse(approval.approvedAt))) return fail(io, 'approvedAt com data inválida', 2);
  // C08: aprovação previamente vinculada — planVersion é obrigatória; vínculos
  // ausentes nunca são preenchidos para validar uma aprovação desvinculada.
  if (!approval.planVersion?.trim()) return fail(io, 'aprovação exige planVersion; aprovação desvinculada não inicia execução', 2);
  // C08 (revisão cruzada): os hashes dos artefatos devem constar no REGISTRO de
  // aprovação produzido antes do start; o run propaga esses vínculos — nunca os
  // recalcula dos arquivos atuais (isso tornaria mudança pós-aprovação invisível).
  if (!approval.intentHash || !approval.planHash) {
    return fail(io, 'aprovação exige intentHash e planHash registrados previamente; aprovação desvinculada não inicia execução', 2);
  }
  const norm = (p: string) => p.replace(/\\/g, '/');
  if (approval.intentPath && norm(resolve(project, approval.intentPath)) !== norm(intentPath)) {
    return fail(io, 'aprovação refere-se a outro intent; mudança de escopo invalida reutilização', 2);
  }
  if (approval.planPath && norm(resolve(project, approval.planPath)) !== norm(planPath)) {
    return fail(io, 'aprovação refere-se a outro plano; mudança de escopo invalida reutilização', 2);
  }
  if (approval.intentHash && approval.intentHash !== sha256(intentText)) {
    return fail(io, 'intent mudou após a aprovação; nova aprovação necessária', 2);
  }
  if (approval.planHash && approval.planHash !== sha256(planText)) {
    return fail(io, 'plano mudou após a aprovação; nova aprovação necessária', 2);
  }
  // R5-05/M3-F2: o manifesto de requisitos é coberto pela APROVAÇÃO (hash registrado antes
  // do start) e pertence ao plano aprovado; sem ele nenhuma execução nova inicia.
  let approvedManifest: Awaited<ReturnType<typeof loadManifestForApproval>>;
  try { approvedManifest = await loadManifestForApproval(project, approval, planPath, planText); }
  catch (error) { return fail(io, (error as Error).message, 2); }
  const requiredRoles = workflowStages[workflowOpt as Workflow].map(s => stageOwner[s]).filter((r, i, a) => a.indexOf(r) === i);
  const state = await store.init(config.projectId);
  if (state.projectId !== config.projectId) throw new Error('projectId do estado diverge da configuração');
  const missing = requiredRoles.filter(role => !state.sessions.some(s => s.role === role && s.projectId === config.projectId && s.status === 'ready' && s.threadId));
  if (missing.length) return fail(io, `time incompleto para ${workflowOpt}: ${missing.join(', ')}; abra com up antes de start`, 4);
  if (state.runs.some(r => r.status === 'running')) return fail(io, 'já existe uma execução ativa neste projeto', 3);
  const firstStage = workflowStages[workflowOpt as Workflow][0];
  const owner = stageOwner[firstStage];
  const ownerSession = state.sessions.find(s => s.role === owner && s.status === 'ready');
  const plannerSession = state.sessions.find(s => s.role === 'planner' && s.status === 'ready');
  const runId = id();
  const run: Run = {
    runId, slug, workflow: workflowOpt as Workflow, intentPath, planPath,
    branch: `sdlc/${slug}`, base: config.prBase,
    worktree: requiredRoles.includes('dev') ? join(project, '.sdlc-codex', 'worktrees', slug) : undefined,
    stage: firstStage, revision: 0, attempts: emptyAttempts(), gapFailures: emptyGapFailures(),
    status: 'running', owner,
    // C08: vínculos propagados do registro de aprovação (nunca recalculados).
    approval: {
      intentPath, planPath, approvedAt: approval.approvedAt, approvedBy: approval.approvedBy, intentHash: approval.intentHash, planHash: approval.planHash, planVersion: approval.planVersion,
      requirementsManifest: { path: approvedManifest.path, hash: approvedManifest.hash },
    },
    // R5-05: config efetiva no start; next/check recusam troca no meio do fluxo.
    configHash: configHashOf(config),
    history: [],
  };
  // R06: entrega inicial persistida atomicamente com a criação da execução.
  await store.mutate(current => {
    let next = startRun(structuredClone(current), structuredClone(run));
    const task: Message = {
      messageId: id(), projectId: next.projectId, runId, from: 'planner', to: owner,
      targetThreadId: ownerSession?.threadId ?? '', targetGenerationId: ownerSession?.generationId ?? '',
      type: 'task', stage: firstStage, revision: 0, body: `Executar estágio ${firstStage} para ${slug}`, createdAt: new Date().toISOString(),
    };
    next = {
      ...next,
      messages: [...next.messages, task],
      deliveries: [...next.deliveries, { deliveryId: id(), messageId: task.messageId, status: 'pending', updatedAt: new Date().toISOString() }],
    };
    if (owner !== 'planner' && plannerSession) {
      const copy: Message = {
        messageId: id(), projectId: next.projectId, runId, from: 'planner', to: 'planner',
        targetThreadId: plannerSession.threadId ?? '', targetGenerationId: plannerSession.generationId ?? '',
        type: 'notify', stage: firstStage, revision: 0, body: `Demanda ${slug} iniciada em ${firstStage} com ${owner}`, createdAt: new Date().toISOString(),
      };
      next = {
        ...next,
        messages: [...next.messages, copy],
        deliveries: [...next.deliveries, { deliveryId: id(), messageId: copy.messageId, status: 'pending', updatedAt: new Date().toISOString() }],
      };
    }
    return { state: next, result: undefined };
  });
  // C01: kickoff despachado pelo serviço central, fora do lock, sem recover manual.
  // Revisão B/B5: raízes documentais aprovadas ficam FORA da revisão de fechamento — o limite é dito no start.
  const docRoots = approvedManifest.manifest.documentRoots ?? [];
  if (docRoots.length) io.stderr(`aviso: as raízes documentais aprovadas (${docRoots.join(', ')}) ficam fora da comparação do fechamento e podem ser alteradas depois da revisão final; não aprove raízes que contenham código`);
  const service = new MessageService(store, new CodexTransport(runner));
  const dispatched = await service.dispatchPending();
  return output(io, json, { slug, runId, workflow: workflowOpt, stage: firstStage, owner, revision: 0, dispatched, ...(docRoots.length ? { documentRoots: docRoots } : {}) });
}

// ---------- send / receive / finish-message ----------

async function cmdSend(argv: string[], io: CliIo, json: boolean, project: string, store: StateStore, runner: ProcessRunner): Promise<number> {
  const to = checkRole(value(argv, '--to'));
  const from = checkRole(value(argv, '--from') ?? 'planner');
  const type = value(argv, '--type') ?? 'question';
  if (!['question', 'answer', 'notify'].includes(type)) return fail(io, `tipo inválido: ${type}; task é reservado ao motor`, 2);
  const bodyFile = value(argv, '--body-file');
  if (!bodyFile) return fail(io, 'send exige --body-file', 2);
  const body = (await fs.readFile(resolveIn(project, bodyFile), 'utf8').catch(() => { throw new Error(`corpo não encontrado: ${bodyFile}`); })).trim();
  if (!body) return fail(io, 'corpo vazio', 2);
  const service = new MessageService(store, new CodexTransport(runner));
  const sent = await service.send({
    from, to, type: type as Message['type'], body,
    runId: value(argv, '--run'), correlationId: value(argv, '--reply-to'),
  });
  return output(io, json, { messageId: sent.message.messageId, status: sent.delivery.status, to });
}

async function cmdReceive(argv: string[], io: CliIo, json: boolean, project: string, store: StateStore, runner: ProcessRunner): Promise<number> {
  const messageId = argv[1];
  if (!messageId) return fail(io, 'receive exige <message-id>', 2);
  const role = checkRole(value(argv, '--role'));
  const thread = value(argv, '--thread');
  const generation = value(argv, '--generation');
  if (!thread || !generation) return fail(io, 'receive exige --role, --thread e --generation (identidade vigente)', 2);
  const checkpointFile = value(argv, '--checkpoint');
  const checkpoint = checkpointFile ? await fs.readFile(resolveIn(project, checkpointFile), 'utf8').catch(() => { throw new Error(`checkpoint não encontrado: ${checkpointFile}`); }) : undefined;
  // C01: runner injetado; instâncias reais só na composição de produção.
  const service = new MessageService(store, new CodexTransport(runner));
  const result = await service.receive(messageId, { role, threadId: thread, generationId: generation, checkpoint });
  return output(io, json, { action: result.action, instruction: result.instruction, type: result.message.type, status: result.delivery.status });
}

async function cmdFinish(argv: string[], io: CliIo, json: boolean, project: string, store: StateStore, runner: ProcessRunner): Promise<number> {
  const messageId = argv[1];
  if (!messageId) return fail(io, 'finish-message exige <message-id>', 2);
  const role = checkRole(value(argv, '--role'));
  const thread = value(argv, '--thread');
  const generation = value(argv, '--generation');
  if (!thread || !generation) return fail(io, 'finish-message exige --role, --thread e --generation', 2);
  const checkpointFile = value(argv, '--checkpoint');
  const checkpoint = checkpointFile ? await fs.readFile(resolveIn(project, checkpointFile), 'utf8').catch(() => { throw new Error(`checkpoint não encontrado: ${checkpointFile}`); }) : undefined;
  const service = new MessageService(store, new CodexTransport(runner));
  await service.finishMessage(messageId, { role, threadId: thread, generationId: generation }, checkpoint);
  return output(io, json, { messageId, status: 'completed' });
}

// ---------- check ----------

/**
 * M4-F2/R4-14 — executa os checks efetivos do estágio (requiredChecksForConfig,
 * compartilhada com o gate e o relatório), grava logs DURÁVEIS (nome único por
 * project/run/revisão/tentativa/check/evidenceId — retry nunca sobrescreve a
 * tentativa anterior) e produz evidência mecânica com proveniência completa
 * (decisões M0-F2 nº3 e 5): projectId, runId, stage, revisão-alvo, producer,
 * check, exitCode, logPath + logHash, producedAt e codeSnapshot.
 * M4-F3: snapshot antes/depois — alteração da árvore DURANTE a execução
 * contamina o resultado (status 'contaminated', nunca pass).
 */
async function cmdCheck(argv: string[], io: CliIo, json: boolean, project: string, config: ProjectConfig, store: StateStore, runner: ProcessRunner): Promise<number> {
  const slug = checkSlug(argv[1]);
  const stageOpt = value(argv, '--stage');
  if (!stageOpt || !isStage(stageOpt)) return fail(io, `check exige --stage válido (${Object.keys(stageOwner).join(',')})`, 2);
  const stage: Stage = stageOpt;
  const state = await store.read();
  const run = state.runs.find(r => r.slug === slug && r.status === 'running');
  const workflow: Workflow = run?.workflow ?? 'feature';
  const cwd = run?.worktree ?? project;
  const evidenceDir = join(project, '.sdlc-codex', 'evidence', slug);
  // R5-05: config trocada no meio do fluxo invalida a seleção; dispensas vêm SOMENTE do
  // manifesto aprovado (nunca de `checks:{}`).
  if (run) assertConfigUnchanged(run, config);
  const approved = run ? await loadApprovedManifest(project, run) : undefined;
  const selection = requiredChecksForConfig(config, workflow, stage, approved?.manifest.checkExemptions);
  const threadOpt = value(argv, '--thread');
  const generationOpt = value(argv, '--generation');
  const producer = threadOpt && generationOpt
    ? { role: stageOwner[stage], threadId: threadOpt, generationId: generationOpt }
    : undefined;
  const revision = run?.revision ?? 0;
  const attempt = run?.attempts[stage] ?? 0;
  const evidenceList: Evidence[] = [];
  const checkOut: Array<{ name: string; status: string; evidenceId: string; logPath?: string }> = [];
  let allOk = true;
  const now = () => new Date().toISOString();
  let lastSnapshot: CodeSnapshot | undefined;
  for (const name of selection.required) {
    const evidenceId = id();
    // Log durável: slug/run implícitos pelo diretório; revisão/tentativa/check/
    // evidenceId no nome — mesmo slug em runs diferentes e retry nunca colidem.
    const logName = `${name}-r${revision}-a${attempt}-${evidenceId.slice(0, 8)}.log`;
    // R5-04: snapshot ANTES e DEPOIS são obrigatórios e devem ser equivalentes; falha de
    // captura (exit != 0, timeout, saída inválida, arquivo ilegível) propaga como erro
    // classificado — nunca vira "sem snapshot", nunca usa `after ?? before` e nunca grava
    // pass mecânico utilizável (nada é persistido quando uma captura falha).
    const before = await captureCodeSnapshot(runner, cwd);
    const result: CheckResult = await runCheck(name, config.checks[name as 'build' | 'lint' | 'unit' | 'e2e'], runner, cwd, evidenceDir, { logName });
    const after = await captureCodeSnapshot(runner, cwd);
    const contaminated = before.diffFingerprint !== after.diffFingerprint || before.commit !== after.commit;
    const passed = !contaminated && result.status === 'approved';
    allOk = allOk && passed;
    const at = now();
    lastSnapshot = after;
    evidenceList.push({
      id: evidenceId, requirementId: `${slug}:${stage}:check-${name}`,
      result: passed ? 'pass' : 'fail',
      procedure: result.command.length ? `${result.command.join(' ')} (exit ${result.exitCode})` : `check '${name}' não configurado`,
      logPath: result.logPath, timestamp: at, producedAt: at,
      commit: after.commit,
      codeSnapshot: after,
      verdict: passed ? 'pass' : 'fail',
      runId: run?.runId, stage, projectId: state.projectId, revision,
      producer, check: name, exitCode: result.exitCode ?? undefined, logHash: result.logHash,
    });
    checkOut.push({ name, status: contaminated ? 'contaminated' : result.status, evidenceId, logPath: result.logPath });
  }
  // Sem checks selecionados (review-only, dispensa aprovada) o snapshot ainda é OBRIGATÓRIO:
  // a rubrica humana o copia daqui (a importação nunca o preenche).
  lastSnapshot ??= await captureCodeSnapshot(runner, cwd);
  // Ausência acidental (check exigido pelo método mas não configurado e sem dispensa
  // aprovada) NUNCA vira pass: registra evidência reprovada e o comando falha com diagnóstico.
  for (const name of selection.missing) {
    allOk = false;
    const at = now();
    evidenceList.push({
      id: id(), requirementId: `${slug}:${stage}:check-${name}`, result: 'fail',
      procedure: `check '${name}' exigido pelo método mas ausente da configuração e sem dispensa explícita aprovada`,
      timestamp: at, producedAt: at, verdict: 'fail',
      runId: run?.runId, stage, projectId: state.projectId, revision,
    });
    checkOut.push({ name, status: 'missing', evidenceId: evidenceList[evidenceList.length - 1].id });
  }
  if (evidenceList.length) {
    await store.mutate(current => ({
      state: { ...current, evidence: [...current.evidence, ...evidenceList] },
      result: undefined,
    }));
  }
  const payload = { slug, stage, checks: checkOut, missing: selection.missing, notApplicable: selection.notApplicable, exempt: selection.exempt, snapshot: lastSnapshot };
  io.stdout(JSON.stringify(payload, null, 2));
  return allOk && selection.missing.length === 0 ? 0 : 1;
}

// ---------- next (R12: conclusão da task vinculada na mesma transação) ----------

/**
 * M6-F1 (R4-07/R4-08) — o run ativo é resolvido UMA vez (slug + status running)
 * e seu runId vale para preflight, replay, transação, evidências, mensagens e
 * efeito externo; nenhuma etapa posterior reconsulta por slug. Replay exige a
 * mesma identidade semântica (OperationIdentity): mesmo operationId com payload
 * divergente é CONFLITO sem gravação nem envio; replay idêntico devolve o
 * resultado anterior. Estado terminal rejeita operação nova, preservando o
 * replay de operação legitimamente concluída.
 *
 * M6-F2 (R4-04) — estágio pr: pré-validação PURA (validateCompletion, dry-run
 * sobre clone com as evidências importadas mescladas) ANTES de qualquer chamada
 * de rede; a intenção (PrIntent) é persistida sob lock e o lock é liberado
 * antes do gh. Reconciliação por repo/base/branch/commit na reexecução
 * (crash antes/depois do create é recuperável sem duplicação). Timeout após
 * possível aceitação => 'uncertain' (nunca retry cego). Se a transição for
 * rejeitada na revalidação pós-efeito, o resultado externo é preservado como
 * 'conflict' para recuperação explícita — nunca se desfaz publicação
 * automaticamente. Garantia honesta: sem exactly-once sobre API arbitrária.
 */
async function cmdNext(argv: string[], io: CliIo, json: boolean, project: string, store: StateStore, runner: ProcessRunner): Promise<number> {
  const slug = checkSlug(argv[1]);
  const stageOpt = argv[2];
  const verdict = argv[3];
  if (!stageOpt || !isStage(stageOpt)) return fail(io, 'next exige <stage> válido', 2);
  if (verdict !== 'pass' && verdict !== 'fail') return fail(io, 'next exige pass|fail', 2);
  const revision = Number(value(argv, '--revision'));
  const operationId = value(argv, '--operation-id');
  const evidencePath = value(argv, '--evidence');
  if (!Number.isInteger(revision) || revision < 0) return fail(io, '--revision deve ser inteiro não negativo', 2);
  if (!operationId) return fail(io, '--operation-id obrigatório (idempotência)', 2);
  if (!evidencePath) return fail(io, '--evidence <path> obrigatório', 2);
  const role = checkRole(value(argv, '--role'));
  const thread = value(argv, '--thread');
  const generation = value(argv, '--generation');
  if (!thread || !generation) return fail(io, 'next exige --role, --thread e --generation (proprietário autorizado)', 2);
  const gapId = value(argv, '--gap');
  const blocked = value(argv, '--blocked');
  const expectedCommit = value(argv, '--commit');
  let evidenceFile: unknown;
  let evidenceRaw = '';
  try { evidenceRaw = await fs.readFile(resolve(project, evidencePath), 'utf8'); evidenceFile = JSON.parse(evidenceRaw); }
  catch { return fail(io, `evidência não encontrada ou JSON inválido: ${evidencePath}`, 2); }
  const incoming: Evidence[] = Array.isArray(evidenceFile) ? evidenceFile as Evidence[] : [evidenceFile as Evidence];
  const git = new GitAdapter(runner);
  // M6-F1 — resolução única da execução ativa; fallback: execução mais recente do
  // slug SOMENTE para produzir a rejeição auditada de "operação após terminal".
  const before = await store.read();
  const run = before.runs.find(r => r.slug === slug && r.status === 'running')
    ?? [...before.runs].reverse().find(r => r.slug === slug);
  const actor: Actor = { role, threadId: thread, generationId: generation, projectId: before.projectId };
  // Identidade semântica do pedido (replay seguro): qualquer mudança de
  // run/estágio/revisão/ator/conteúdo produz payloadHash divergente.
  const identity = operationIdentityOf({
    projectId: before.projectId,
    runId: run?.runId ?? `(nenhuma execução para ${slug})`,
    stage: stageOpt as Stage,
    operationId,
    baseRevision: revision,
    actor,
    content: { verdict, gapId, blockedReason: blocked, expectedCommit, evidenceFileHash: sha256(evidenceRaw) },
  });
  // Idempotência antes de qualquer escrita ou efeito externo (replay não
  // revalida o ambiente — C12/revisão cruzada M5).
  const known = before.operations[operationId];
  if (known) {
    if ((known.runId !== undefined && known.runId !== identity.runId) ||
        (known.payloadHash !== undefined && known.payloadHash !== identity.payloadHash)) {
      return fail(io, `operationId ${operationId} já usado com identidade divergente (execução/payload); conflito — nada gravado, nada enviado`, 3);
    }
    // R5-11: operação legada (migração v1, sem runId/revisão) nunca é elegível a replay aceito.
    if (known.accepted && known.provenance === 'legacy') {
      return fail(io, `operationId ${operationId} é legado (sem runId/revisão; migração v1) e não é elegível a replay aceito; use um novo operationId — nada gravado, nada enviado`, 3);
    }
    if (!known.accepted) {
      io.stderr(known.error ?? 'operação recusada');
      return known.status === 'rejected' ? 3 : 1;
    }
    return output(io, json, { slug, runId: known.runId, stage: stageOpt, result: verdict, revision: known.revision, status: known.status, replay: true });
  }
  // C09: o commit esperado é SEMPRE o HEAD verificado no checkout da demanda
  // (worktree ?? projeto); --commit é apenas expectativa a conferir — nunca
  // contorna a consulta e nunca preenche evidência retroativamente.
  const checkoutCwd = run?.worktree ?? project;
  const headCommit = await git.currentCommit(checkoutCwd).catch(() => '');
  if (expectedCommit) {
    // Expectativa declarada pelo chamador: deve existir no checkout e ser o HEAD.
    const exists = await git.verifyCommit(checkoutCwd, expectedCommit).catch(() => false);
    if (!exists) return fail(io, `--commit não existe no checkout da demanda: ${expectedCommit}`, 2);
    if (headCommit && expectedCommit !== headCommit) {
      return fail(io, `--commit diverge do HEAD verificado em ${checkoutCwd} (${headCommit})`, 2);
    }
  }
  const stateRoot = join(project, '.sdlc-codex');
  const config = run ? await mustConfig(stateRoot) : undefined;
  // R5-05 — config e manifesto aprovados no start não podem ser substituídos no meio do fluxo.
  // Falha de integridade do AMBIENTE: nada é gravado (o mesmo operationId pode ser repetido após corrigir).
  let approved: LoadedManifest | undefined;
  if (run && run.status === 'running' && config) {
    try {
      assertConfigUnchanged(run, config);
      approved = await loadApprovedManifest(project, run);
    } catch (error) { return fail(io, (error as Error).message, 3); }
  }
  const selection = run && config ? requiredChecksForConfig(config, run.workflow, stageOpt as Stage, approved?.manifest.checkExemptions) : undefined;
  // Ids atribuídos ANTES da validação (a importação nunca reatribui proveniência; só gera id ausente).
  const prepared: Evidence[] = incoming.map(e => ({ ...e, id: e.id || id() }));
  const verified = new Set<string>();
  // M4-F1 + R5-05 — validação da importação ANTES de qualquer efeito externo (PR) ou
  // transição: a importação NUNCA reatribui runId/stage/projectId/revisão/produtor, nunca
  // reescreve timestamp antigo, nunca substitui procedimento; log deve existir e logHash
  // conferir. Também os logs dos checks EXECUTADOS pelo produto para este run/estágio/
  // revisão são verificados em disco (adulterado ≠ aprovado). Violação => rejeição
  // registrada (idempotência) SEM mesclar evidência, SEM transição, SEM entrega e SEM publicação.
  if (run && config) {
    const importErrors: string[] = [];
    const seenIds = new Set<string>();
    for (const e of prepared) {
      const label = e.id;
      if (seenIds.has(e.id)) importErrors.push(`evidência ${label}: id duplicado no arquivo`);
      seenIds.add(e.id);
      if (before.evidence.some(x => x.id === e.id)) {
        importErrors.push(`evidência ${label}: id já existe no estado`);
      }
      importErrors.push(...validateEvidenceImport(e, {
        run, stage: stageOpt as Stage, projectId: before.projectId, productChecks: selection?.required ?? [],
        actor: { role, threadId: thread, generationId: generation },
      }));
      if (e.logPath && typeof e.logHash === 'string') {
        const logFull = resolveIn(project, e.logPath);
        const content = await fs.readFile(logFull, 'utf8').catch(() => null);
        if (content === null) importErrors.push(`evidência ${label}: log ausente: ${e.logPath}`);
        else if (sha256(content) !== e.logHash.toLowerCase()) importErrors.push(`evidência ${label}: log adulterado (logHash não confere)`);
        else verified.add(e.id);
      }
    }
    if (run.status === 'running' && selection) {
      for (const e of before.evidence) {
        if (e.runId !== run.runId || e.stage !== stageOpt || e.revision !== run.revision || e.check === undefined || e.imported || e.result !== 'pass') continue;
        if (!selection.required.some(n => e.requirementId === `${slug}:${stageOpt}:check-${n}`)) continue;
        if (!e.logPath || typeof e.logHash !== 'string') { importErrors.push(`evidência ${e.id}: check do produto sem log/hash registrado`); continue; }
        const content = await fs.readFile(resolveIn(project, e.logPath), 'utf8').catch(() => null);
        if (content === null) importErrors.push(`evidência ${e.id}: log de check do produto ausente: ${e.logPath}`);
        else if (sha256(content) !== e.logHash.toLowerCase()) importErrors.push(`evidência ${e.id}: log de check do produto adulterado (logHash não confere)`);
        else verified.add(e.id);
      }
    }
    if (importErrors.length) {
      const detail = importErrors.join('; ');
      await store.mutate(current => ({
        state: {
          ...current,
          operations: {
            ...current.operations,
            [operationId]: { operationId, accepted: false, status: 'rejected', runId: run.runId, revision: run.revision, error: detail, payloadHash: identity.payloadHash },
          },
          revision: current.revision + 1,
          events: [...current.events, { at: new Date().toISOString(), kind: 'evidence-import-rejected', detail: `${slug}:${stageOpt}:${importErrors[0]}` }],
        },
        result: undefined as void,
      }));
      return fail(io, detail, 3);
    }
  }
  // Metadados de importação separados de produção: preserva producedAt/timestamp/
  // runId/stage/procedure originais; marca imported/importedAt sem reescrever nada.
  const importedAtNow = new Date().toISOString();
  const imported: Evidence[] = prepared.map(e => ({ ...e, imported: true, importedAt: e.importedAt ?? importedAtNow }));

  // R5-03/R5-04/R5-05/R5-07 — fatos verificados do gate. Tudo que é leitura/captura
  // acontece ANTES de qualquer efeito externo; falha = erro fechado, nunca ausência opcional.
  const gh = new GhAdapter(runner);
  const isFinalStage = !!run && !nextStage(run.workflow, stageOpt as Stage);
  const needsGate = !!run && !!config && run.status === 'running' && verdict === 'pass' && !!approved && !!selection;
  let observation: PrObservation | undefined;
  let commitRelation: EvidenceGateContext['commitRelation'];
  if (needsGate && run && run.workflow !== 'review-only' && (stageOpt === 'pr-review' || isFinalStage) && run.pullRequest) {
    // Consulta por identidade ESTÁVEL (URL registrada), não por branch: a PR original nunca é
    // trocada em silêncio. Falha de leitura (timeout/auth/resposta incompleta) impede o pass.
    try { observation = await gh.viewPr(run.pullRequest.url, checkoutCwd); }
    catch (error) { return fail(io, `consulta somente-leitura da PR indisponível (${(error as Error).message}); nada foi gravado — repita quando o gh responder`, 1); }
  }
  if (needsGate && run && approved && run.workflow !== 'review-only' && isFinalStage && stageOpt !== 'pr-review' && run.approvedSnapshot && headCommit) {
    if (run.approvedSnapshot.commit === headCommit) commitRelation = 'same';
    else {
      const roots = approved.manifest.documentRoots ?? [];
      if (!roots.length) commitRelation = 'code-changed';
      else {
        const changed = await git.changedPaths(checkoutCwd, run.approvedSnapshot.commit, headCommit);
        const underRoot = (p: string) => roots.some(r => { const a = p.replace(/\\/g, '/').toLowerCase(); const b = r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); return a === b || a.startsWith(`${b}/`); });
        // Verificação V2-02: diff VAZIO entre commits distintos não prova "só documentação" (Array.every([]) é true; um repositório
        // com diff.ignoreSubmodules=all já escondeu código) — sem NENHUM caminho listado, fecha-se falha-fechado (nova revisão).
        commitRelation = changed.length > 0 && changed.every(underRoot) ? 'docs-only-advance' : 'code-changed';
      }
    }
  }
  const gateFacts = async (): Promise<{ gate: EvidenceGateContext; snapshot: CodeSnapshot } | undefined> => {
    if (!needsGate || !approved || !selection) return undefined;
    const snapshot = await captureCodeSnapshot(runner, checkoutCwd);
    const roots = approved.manifest.documentRoots ?? [];
    const code = roots.length ? await captureCodeSnapshot(runner, checkoutCwd, { excludeRoots: ['.sdlc-codex', ...roots] }) : snapshot;
    return {
      snapshot,
      gate: {
        manifest: approved.manifest, manifestHash: approved.hash,
        currentSnapshot: { commit: snapshot.commit, diffFingerprint: snapshot.diffFingerprint },
        currentCodeSnapshot: { commit: code.commit, diffFingerprint: code.diffFingerprint },
        checks: { required: selection.required, missing: selection.missing, exempt: selection.exempt },
        verifiedLogs: [...verified], pullRequest: observation, commitRelation,
      },
    };
  };
  // Falha de captura aqui propaga como SnapshotCaptureError (exit 1) ANTES de qualquer reserva/publicação.
  const preFacts = await gateFacts();
  const gate = preFacts?.gate;
  // M6-F2 (R4-04) — protocolo de efeito externo do estágio pr.
  let pullRequest: PullRequestRef | undefined;
  let prIntent: PrIntent | undefined;
  let prEffected = false;
  let finalGate = gate;
  if (stageOpt === 'pr' && verdict === 'pass') {
    if (!run) return fail(io, 'estágio pr exige execução ativa para o slug', 2);
    if (!headCommit) return fail(io, 'estágio pr exige HEAD verificado no checkout da demanda', 2);
    if (!run.branch || !run.base) return fail(io, 'execução sem branch/base configuradas', 2);
    // PRÉ-VALIDAÇÃO PURA em dry-run (zero gravação, zero rede): o pedido inválido
    // gera ZERO chamadas ao gh — o defeito R4-04 exatamente observado pela revisão.
    const withImported: Runtime = { ...before, evidence: [...before.evidence, ...imported.map(e => structuredClone(e))] };
    const dryCompletion: StageCompletion = {
      operationId, runId: run.runId, stage: stageOpt as Stage, expectedRevision: revision, actor,
      result: verdict, evidenceIds: imported.map(e => e.id),
      gapId, blockedReason: blocked, expectedCommit: headCommit || undefined,
    };
    const preflight = validateCompletion(withImported, dryCompletion, gate);
    if (!preflight.ok) {
      await store.mutate(current => ({
        state: {
          ...current,
          operations: {
            ...current.operations,
            [operationId]: { operationId, accepted: false, status: 'rejected', runId: run.runId, revision: run.revision, error: preflight.error, payloadHash: identity.payloadHash },
          },
          revision: current.revision + 1,
          events: [...current.events, { at: new Date().toISOString(), kind: 'transition-rejected', detail: `${slug}:${stageOpt}:${preflight.error}` }],
        },
        result: undefined as void,
      }));
      return fail(io, preflight.error, 3);
    }
    const repo = await git.remoteUrl(checkoutCwd).catch(() => `local:${checkoutCwd}`);
    prIntent = {
      intentId: operationId, operationId, runId: run.runId, repo,
      base: run.base, branch: run.branch, headCommit,
      snapshot: preFacts!.snapshot,
      status: 'reserved', createdAt: new Date().toISOString(),
    };
    // Reconciliação na reexecução: crash antes/depois do create é recuperável
    // SEM duplicação, chaveada por repo/base/branch/commit.
    const prior = latestPrIntent(before, operationId);
    // Revisão B/B7: o operationId pertence a UM commit; HEAD novo exige operationId novo (não vira erro de ledger).
    if (prior && prior.headCommit !== headCommit) {
      return fail(io, `o HEAD mudou desde a reserva desta operação (${prior.headCommit} → ${headCommit}); use um NOVO operationId — nada reservado nem criado`, 3);
    }
    if (prior && (prior.status === 'executed' || prior.status === 'confirmed')) {
      // Efeito já realizado por execução anterior desta MESMA operação: reutiliza.
      if (!prior.result?.url) return fail(io, `intenção de PR '${prior.status}' sem URL registrada; reconcilie explicitamente`, 1);
      pullRequest = {
        url: prior.result.url, base: prior.base, branch: prior.branch, commit: headCommit,
        number: prior.result.number, checkedAt: prior.result.checkedAt ?? new Date().toISOString(),
      };
      prEffected = true;
    } else if (prior?.status === 'uncertain') {
      // Timeout após possível aceitação: reconciliação POR LEITURA apenas
      // (findOpenPr); nunca create cego.
      const found = await gh.findOpenPr(prior.branch, prior.base, checkoutCwd).catch(() => undefined);
      if (found && found.commit === headCommit) {
        pullRequest = found;
        prEffected = true;
        await store.mutate(current => ({
          state: appendPrIntent(current, { ...prior, status: 'confirmed', result: { url: found.url, number: found.number, checkedAt: found.checkedAt } }, PR_INTENT_UPDATED),
          result: undefined as void,
        }));
      } else {
        return fail(io, `intenção de PR anterior 'uncertain' não reconciliada por leitura (PR não localizada para ${prior.branch}→${prior.base}@${headCommit}); verifique o repositório antes de reexecutar`, 1);
      }
    } else if (prior?.status === 'conflict') {
      return fail(io, `intenção de PR anterior em 'conflict' (${prior.result?.detail ?? 'sem detalhe'}); recuperação explícita humana necessária antes de reexecutar`, 1);
    } else {
      // R5-08/M4-F1 — OUTRAS operações da execução com intenção não `confirmed`
      // (reserved/executed/uncertain/conflict) bloqueiam novo efeito. Só uma leitura
      // somente-leitura que COMPROVE o efeito (PR aberta correspondente) as reconcilia
      // como `confirmed`; senão o efeito externo é desconhecido e nada é criado.
      const stillBlocking = await reconcileBlockingIntents(store, gh, checkoutCwd, blockingPrIntents(before, run.runId, operationId));
      if (stillBlocking) {
        return fail(io, `intenção de PR ${stillBlocking.operationId} em '${stillBlocking.status}' com efeito externo não comprovado por leitura; nenhuma PR será criada — verifique o repositório e reconcilie antes de repetir`, 3);
      }
      // R5-07/M4-F3 — leitura ANTES de reservar: a segunda passagem reutiliza a PR
      // existente (mesma branch/base) e só EXIGE que o head remoto seja o HEAD atual;
      // PR desatualizada é diagnóstico (push pendente), nunca 'uncertain' nem create.
      let found: PullRequestRef | undefined;
      try { found = await gh.findOpenPr(run.branch, run.base, checkoutCwd); }
      catch (error) { return fail(io, `consulta somente-leitura de PR falhou (${(error as Error).message}); nada reservado nem criado`, 1); }
      if (found && found.commit !== headCommit) {
        return fail(io, `PR existente ${found.url} tem head ${found.commit || '(desconhecido)'} diferente do HEAD verificado ${headCommit}; faça push da branch de trabalho e repita — nada reservado nem criado`, 3);
      }
      // Reserva sob lock e libera o lock ANTES da chamada de rede.
      try {
        await store.mutate(current => {
          if (current.operations[operationId]) throw new Error(`operação ${operationId} registrada concorrentemente; efeito externo abortado antes da rede`);
          const r = current.runs.find(x => x.runId === run.runId);
          if (!r || r.status !== 'running' || r.stage !== 'pr' || r.revision !== revision) {
            throw new Error(`execução ${slug} mudou de estágio/revisão após a pré-validação; efeito externo abortado antes da rede`);
          }
          const conflicting = blockingPrIntents(current, run.runId, operationId)[0];
          if (conflicting) throw new Error(`intenção de PR ${conflicting.operationId} ainda ativa ('${conflicting.status}') nesta execução; no máximo uma publicação por execução`);
          // Revisão cruzada M8/N1 — mesmo operationId: a reserva é serializada
          // pelo lock do store, então uma intenção 'reserved'/'executed'/'uncertain'
          // do MESMO operationId só pode vir de outro processo executando a mesma
          // operação OU de uma tentativa anterior que sofreu crash. Distinção por
          // liveness do reservador (pid registrado na reserva): dono VIVO =>
          // concorrência real => abortar antes da rede (o perdedor não cria uma
          // segunda PR); dono MORTO => crash => re-reservar e reconciliar por
          // leitura (findOpenPr reutiliza a PR existente, zero create duplicado).
          const own = latestPrIntent(current, operationId) as (PrIntent & { reservedBy?: { pid: number; processStartMs: number } }) | undefined;
          if (own && ['reserved', 'executed', 'uncertain'].includes(own.status) && own.reservedBy && pidLooksAlive(own.reservedBy.pid)) {
            throw new Error(`operação ${operationId} em andamento por outro processo (pid ${own.reservedBy.pid}; intenção '${own.status}'); nenhuma rede acionada — reexecute após a conclusão dele`);
          }
          return { state: appendPrIntent(current, { ...prIntent!, reservedBy: { pid: process.pid, processStartMs: Date.now() - Math.round(process.uptime() * 1000) } } as PrIntent, PR_INTENT_RESERVED), result: undefined as void };
        });
      } catch (error) {
        if (error instanceof PrLedgerError) throw error;
        return fail(io, (error as Error).message, 3);
      }
      // Revisão B/B6 + verificação V2-01: relê DEPOIS de vencer a reserva — uma PR criada por outro processo entre a leitura anterior e
      // a reserva é reutilizada em vez de duplicada. É leitura PURA, fora do try do efeito: falha de leitura ou PR desatualizada NÃO vira
      // 'conflict'/'uncertain' (nada foi criado); a reserva é LIBERADA (reservedBy.pid=0 => recuperável na reexecução, inclusive no
      // mesmo processo) e o operador recebe o diagnóstico certo.
      const releaseReservation = async (): Promise<void> => {
        await store.mutate(current => ({
          state: appendPrIntent(current, { ...prIntent!, reservedBy: { pid: 0, processStartMs: 0 } } as PrIntent, PR_INTENT_RESERVED),
          result: undefined as void,
        }));
      };
      if (!found) {
        try { found = await gh.findOpenPr(run.branch, run.base, checkoutCwd); }
        catch (error) {
          await releaseReservation();
          return fail(io, `releitura somente-leitura da PR falhou após a reserva (${(error as Error).message}); nada foi criado e a reserva foi liberada — reexecute a mesma operação`, 1);
        }
        if (found && found.commit !== headCommit) {
          await releaseReservation();
          return fail(io, `PR existente ${found.url} tem head ${found.commit || '(desconhecido)'} diferente do HEAD verificado ${headCommit} (apareceu após a reserva); faça push da branch de trabalho e repita — nada criado, reserva liberada`, 3);
        }
      }
      try {
        const effected = found ?? await gh.createPr(run.branch, run.base, `sdlc: ${slug}`, `Pipeline sdlc-codex — demanda ${slug} em ${headCommit}`, checkoutCwd);
        if (!effected.commit || effected.commit !== headCommit) {
          // Resposta ambígua ou head divergente: a PR pode existir — incerteza,
          // nunca retry cego.
          await store.mutate(current => ({
            state: appendPrIntent(current, { ...prIntent!, status: 'uncertain', result: { checkedAt: new Date().toISOString(), detail: `resposta ${effected.commit ? 'com head divergente' : 'sem commit'} ('${effected.commit || ''}'; esperado ${headCommit})` } }, PR_INTENT_UPDATED),
            result: undefined as void,
          }));
          return fail(io, 'efeito de PR incerto (resposta ambígua ou head divergente); reconcilie explicitamente antes de reexecutar', 1);
        }
        pullRequest = effected;
        prEffected = true;
        await store.mutate(current => ({
          state: appendPrIntent(current, { ...prIntent!, status: 'executed', result: { url: effected.url, number: effected.number, checkedAt: effected.checkedAt, detail: JSON.stringify({ commit: effected.commit, reused: found !== undefined }) } }, PR_INTENT_UPDATED),
          result: undefined as void,
        }));
      } catch (error) {
        if (error instanceof PrLedgerError) throw error;
        const message = (error as Error).message;
        const uncertain = /timeout/i.test(message);
        await store.mutate(current => ({
          state: appendPrIntent(current, { ...prIntent!, status: uncertain ? 'uncertain' : 'conflict', result: { checkedAt: new Date().toISOString(), detail: message } }, PR_INTENT_UPDATED),
          result: undefined as void,
        }));
        return fail(io, uncertain
          ? `operação de PR incerta (timeout após possível aceitação); reconcilie explicitamente — retry cego é proibido: ${message}`
          : `operação de PR falhou: ${message}`, 1);
      }
    }
    // R5-04 — snapshot PÓS-efeito também é obrigatório. Falha aqui: o recibo ('executed' + URL)
    // já está persistido; NÃO se declara conclusão e NÃO se cria de novo — a reexecução da
    // mesma operação reutiliza a PR e refaz a captura.
    try { finalGate = (await gateFacts())?.gate; }
    catch (error) {
      return fail(io, `snapshot pós-efeito indisponível (${(error as Error).message}); PR ${pullRequest?.url ?? '(sem URL)'} preservada com intenção 'executed'; reexecute a MESMA operação para reconciliar — nada foi declarado concluído`, 1);
    }
  }
  // Transação com REVALIDAÇÃO (o estado pode ter mudado durante o efeito) e
  // identidade única: a run é reencontrada PELO runId resolvido no preflight —
  // nunca pelo primeiro slug histórico (R4-07).
  await store.mutate(current => {
    if (current.operations[operationId]) {
      // Revisão cruzada M8/N1: registrar o operationId entre o pré-flight e este
      // mutate significa execução concorrente da MESMA operação. No-op silencioso
      // com exit 0 fazia o perdedor reportar sucesso como se tivesse concluído —
      // com efeito externo (PR) possivelmente duplicado. Falha fechada explícita.
      throw new Error(`operação ${operationId} registrada por outro processo durante o efeito externo; verifique a PR e recupere explicitamente (nada foi declarado concluído por este processo)`);
    }
    const target = current.runs.find(r => r.runId === run?.runId);
    if (!target) throw new Error(`execução desconhecida para slug ${slug}`);
    // Mescla evidências importadas COM proveniência preservada (M4-F1): os campos
    // de produção (runId/stage/timestamp/producedAt/procedure/commit/snapshot)
    // vêm do arquivo validado — a ingestão nunca os reatribui.
    const withIds = imported.map(e => structuredClone(e)) as Evidence[];
    let next = structuredClone(current);
    next = { ...next, evidence: [...next.evidence, ...withIds] };
    const completion: StageCompletion = {
      operationId, runId: target.runId, stage: stageOpt as Stage, expectedRevision: revision,
      actor,
      result: verdict as 'pass' | 'fail', evidenceIds: withIds.map(e => e.id),
      gapId, blockedReason: blocked, expectedCommit: headCommit || undefined,
      pullRequest,
    };
    const t = applyCompletion(next, completion, finalGate, { payloadHash: identity.payloadHash });
    if (!t.result.accepted) {
      // Registra a rejeição (idempotência de operação) SEM mesclar evidência e SEM transição.
      next = {
        ...current,
        operations: t.state.operations,
        revision: current.revision + 1,
        events: [...current.events, { at: new Date().toISOString(), kind: 'transition-rejected', detail: `${slug}:${stageOpt}:${t.result.error}` }],
      };
      // M6-F2 — efeito externo já ocorrido e transição rejeitada na revalidação:
      // NÃO declarar done nem desfazer publicação automaticamente; o resultado
      // externo fica preservado como 'conflict' para recuperação explícita.
      if (prEffected && prIntent) {
        next = appendPrIntent(next, {
          ...prIntent, status: 'conflict',
          result: { ...(prIntent.result ?? {}), url: pullRequest?.url, number: pullRequest?.number, checkedAt: new Date().toISOString(), detail: `transição rejeitada após efeito externo: ${t.result.error}; publicação preservada — recuperação explícita` },
        }, PR_INTENT_UPDATED);
      }
      return { state: next, result: undefined as void };
    }
    next = t.state;
    if (prEffected && prIntent) next = appendPrIntent(next, { ...prIntent, status: 'confirmed', result: { url: pullRequest?.url, number: pullRequest?.number, checkedAt: pullRequest?.checkedAt } }, PR_INTENT_UPDATED);
    // Conclusão da task vinculada na MESMA gravação da transição (R12).
    const taskMsg = next.messages.find(m =>
      m.runId === target.runId && m.type === 'task' && m.stage === stageOpt && m.revision === revision &&
      next.deliveries.some(d => d.messageId === m.messageId && d.status !== 'completed'));
    if (taskMsg) next = MessageService.completeLinkedTask(next, taskMsg.messageId, completion.actor);
    return { state: next, result: undefined as void };
  });
  const state = await store.read();
  const accepted = state.operations[operationId];
  if (!accepted?.accepted) {
    io.stderr(accepted?.error ?? 'operação recusada');
    return accepted?.status === 'rejected' ? 3 : 1;
  }
  // C01: despacho centralizado no serviço, fora do lock, após next bem-sucedido.
  const service = new MessageService(store, new CodexTransport(runner));
  const dispatched = await service.dispatchPending();
  return output(io, json, { slug, runId: accepted.runId, stage: stageOpt, result: verdict, revision: accepted.revision, status: accepted.status, dispatched });
}

/**
 * R5-08/M4-F1 — reconcilia por LEITURA as intenções não `confirmed` de OUTRAS operações da
 * execução. Uma intenção só vira `confirmed` quando a PR aberta correspondente (mesma
 * base/branch) é observada; qualquer dúvida (reserva pendente, ausência, falha de leitura)
 * mantém o bloqueio — nunca autoriza nova publicação. Devolve a primeira ainda bloqueante.
 */
/** owner/nome de um remoto ou URL de PR do GitHub (ssh ou https); undefined quando não reconhecível. */
function repoSlug(value: string): string | undefined {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[/\s]|$)/i.exec(value);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

async function reconcileBlockingIntents(store: StateStore, gh: GhAdapter, cwd: string, blockers: PrIntent[]): Promise<PrIntent | undefined> {
  for (const intent of blockers) {
    if (intent.status === 'reserved') return intent; // reserva sem desfecho: efeito desconhecido
    let observed: PrObservation | undefined;
    try {
      if (intent.result?.url) observed = await gh.viewPr(intent.result.url, cwd);
      else {
        const f = await gh.findOpenPr(intent.branch, intent.base, cwd);
        observed = f ? { url: f.url, number: f.number, state: 'OPEN', base: f.base, branch: f.branch, headSha: f.commit, observedAt: f.checkedAt } : undefined;
      }
    } catch { return intent; }
    // Revisão B/B3: além de aberta, base e branch, o HEAD remoto deve ser o commit da intenção e o repositório da PR o da
    // intenção. Sem URL registrada não há identidade estável: a confirmação é INFERIDA por branch/base/commit e fica dito.
    const sameRepo = (() => { const a = repoSlug(intent.repo); const b = observed ? repoSlug(observed.url) : undefined; return !a || !b || a === b; })();
    if (observed && observed.state === 'OPEN' && observed.base === intent.base && observed.branch === intent.branch && observed.headSha === intent.headCommit && sameRepo) {
      await store.mutate(current => ({
        state: appendPrIntent(current, {
          ...intent, status: 'confirmed',
          result: {
            url: observed!.url, number: observed!.number, checkedAt: observed!.observedAt,
            detail: intent.result?.url
              ? 'reconciliada por leitura (PR aberta pela URL registrada; base/branch/head conferidos)'
              : 'reconciliada por leitura com identidade INFERIDA por branch/base/commit (a intenção não registrou URL)',
          },
        }, PR_INTENT_UPDATED),
        result: undefined as void,
      }));
      continue;
    }
    return intent;
  }
  return undefined;
}

// ---------- recover / hook ----------

async function cmdRecover(argv: string[], io: CliIo, json: boolean, store: StateStore, runner: ProcessRunner): Promise<number> {
  const limitOpt = value(argv, '--limit');
  const limit = limitOpt ? Number(limitOpt) : 100;
  if (!Number.isInteger(limit) || limit <= 0) return fail(io, '--limit deve ser inteiro positivo', 2);
  // C11: recuperação pública explícita de claim interrompido, com identidade.
  const claim = value(argv, '--claim');
  const roleOpt = value(argv, '--role');
  if (claim && !roleOpt) return fail(io, 'recover --claim exige --role (identidade do ator)', 2);
  let opts: RecoverOptions | undefined;
  if (claim) {
    opts = { releaseClaimFor: claim, role: checkRole(roleOpt) };
    const threadOpt = value(argv, '--thread');
    if (threadOpt) opts.threadId = threadOpt;
    const generationOpt = value(argv, '--generation');
    if (generationOpt) opts.generationId = generationOpt;
  }
  const service = new MessageService(store, new CodexTransport(runner));
  const result = await service.recover(limit, opts);
  return output(io, json, result);
}

async function cmdHook(argv: string[], io: CliIo, json: boolean, project: string, deps: CliDeps): Promise<number> {
  const event = argv[1];
  if (!event) return fail(io, 'hook exige <evento>; veja --help para os eventos suportados', 2);
  let raw: string;
  const payloadFile = value(argv, '--payload-file');
  if (payloadFile) {
    raw = await fs.readFile(resolveIn(project, payloadFile), 'utf8').catch(() => { throw new Error(`payload não encontrado: ${payloadFile}`); });
  } else if (deps.stdin) {
    raw = await deps.stdin();
  } else {
    raw = await readStdin();
  }
  if (!raw.trim()) return fail(io, 'hook exige JSON no stdin ou --payload-file', 2);
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { return fail(io, 'payload de hook com JSON inválido', 2); }
  const store = new StateStore(join(project, '.sdlc-codex'));
  const registry = new SessionRegistry(store);
  const merged = { ...(payload as Record<string, unknown>), type: (payload as Record<string, unknown>).type ?? event };
  // R4-09: a decisão calculada pelo handler é PRESERVADA — deny sai como exit 2
  // + stderr e permissionDecision "deny" no JSON do stdout (formato wire que o
  // Codex interpreta), nunca como contexto com exit 0.
  const result = await handleHook(registry, merged);
  io.stdout(result.json);
  if (result.stderr) io.stderr(result.stderr);
  return result.exitCode;
}

function readStdin(): Promise<string> {
  return new Promise(resolvePromise => {
    if (process.stdin.isTTY) { resolvePromise(''); return; }
    let data = '';
    let finished = false;
    let timer: NodeJS.Timeout;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    timer = setTimeout(finish, 5000);
  });
}

if (process.argv[1]?.endsWith('cli.js')) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
