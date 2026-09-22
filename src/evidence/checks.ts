import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Stage, Workflow } from '../contracts.js';
import type { CommandConfig, ProjectConfig } from '../project/config.js';
import type { ProcessRunner } from '../adapters/process.js';
import { getRequiredChecks, workflowStages } from '../pipeline/workflows.js';
import { isStage, isWorkflow } from '../contracts.js';

export type CheckStatus = 'approved' | 'failed' | 'interrupted' | 'missing' | 'contaminated';
export interface CheckResult {
  name: string;
  status: CheckStatus;
  exitCode: number | null;
  command: string[];
  logPath: string;
  /** sha256 do conteúdo do log — integridade verificável na importação. */
  logHash?: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCheckOptions {
  /** Nome do arquivo de log dentro de evidenceDir. ÚNICO por project/run/revisão/
   *  tentativa/check/evidenceId — o chamador é responsável por nunca reutilizar
   *  um nome (logs são imutáveis; retry grava novo arquivo e preserva o anterior). */
  logName?: string;
  timeoutMs?: number;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * R4-14 — executa UM check e grava seu log de forma durável.
 * - command.cwd RELATIVO é resolvido contra `executionCwd` (worktree da execução),
 *   NUNCA contra o cwd de quem chamou; caminho absoluto segue o contrato documentado.
 * - check ausente NUNCA vira pass: status 'missing' (o chamador decide como registrar).
 * - timeout é 'interrupted', exit 0 é 'approved', demais exits são 'failed'.
 */
export async function runCheck(
  name: string,
  command: CommandConfig | undefined,
  runner: ProcessRunner,
  executionCwd: string,
  evidenceDir: string,
  opts: RunCheckOptions = {},
): Promise<CheckResult> {
  await fs.mkdir(evidenceDir, { recursive: true });
  // Sem logName explícito, o nome ainda é único (suffixo aleatório): a imutabilidade
  // por 'wx' nunca falha por reexecução legítima do mesmo check.
  const logPath = join(evidenceDir, opts.logName ?? `${name}-${randomUUID().slice(0, 8)}.log`);
  if (!command) {
    const body = `check '${name}' não configurado\n`;
    await fs.writeFile(logPath, body);
    return { name, status: 'missing', exitCode: null, command: [], logPath, logHash: sha256(body), stdout: '', stderr: '', timedOut: false };
  }
  // R4-14: cwd relativo resolve contra o worktree da execução — jamais process.cwd().
  const cwd = command.cwd ? resolve(executionCwd, command.cwd) : executionCwd;
  const result = await runner.run(command.executable, command.args, { cwd, timeoutMs: opts.timeoutMs ?? 120_000 });
  const log = [
    `check: ${name}`,
    `command: ${[command.executable, ...command.args].join(' ')}`,
    `cwd: ${cwd}`,
    '--- stdout ---', result.stdout,
    '--- stderr ---', result.stderr,
    `exitCode: ${result.exitCode}`,
    `timedOut: ${result.timedOut}`,
    '',
  ].join('\n');
  // Imutabilidade: gravação com flag exclusiva — se o nome do log colidir (violação
  // do contrato do chamador), falha em vez de sobrescrever a tentativa anterior.
  await fs.writeFile(logPath, log, { flag: 'wx' }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`log de evidência já existe (nome reutilizado): ${logPath}; logs são imutáveis por project/run/revisão/tentativa/check/evidenceId`);
    }
    throw error;
  });
  return {
    name,
    status: result.timedOut ? 'interrupted' : result.exitCode === 0 ? 'approved' : 'failed',
    exitCode: result.exitCode,
    command: [command.executable, ...command.args],
    logPath,
    logHash: sha256(log),
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

export type CheckName = 'build' | 'lint' | 'unit' | 'e2e';
export interface StageCheckSelection {
  /** checks exigidos pelo método para o estágio E configurados — executados/avaliados. */
  required: string[];
  /** exigidos pelo método mas AUSENTES da config — ausência acidental: NUNCA viram pass;
   *  o gate reprova com diagnóstico e o comando check falha. */
  missing: string[];
  /** configurados mas sem papel neste estágio — não executados aqui. */
  skipped: string[];
  /** o método não exige checks mecânicos neste estágio (ex.: review-only) — diferente
   *  de ausência acidental. */
  notApplicable: boolean;
  /** R5-03: dispensa EXPLÍCITA e aprovada (manifesto coberto por hash) de um check que o
   *  método exige. `checks:{}` na configuração nunca produz dispensa. */
  exempt: Array<{ check: string; reason: string }>;
}

/** R5-03: dispensa aprovada de check canônico (vem do manifesto de requisitos aprovado). */
export interface CheckExemption { workflow: Workflow; stage: Stage; check: string; reason: string; }

/**
 * R5-03/M3-F1 — valida as dispensas contra a política do método: só é dispensável um
 * check que o método EXIGE naquele workflow/estágio (getRequiredChecks) e o estágio
 * pertence ao workflow; motivo obrigatório. Devolve mensagens de erro (vazio = válido).
 */
export function validateCheckExemptions(exemptions: CheckExemption[] | undefined): string[] {
  const errors: string[] = [];
  for (const [i, ex] of (exemptions ?? []).entries()) {
    const label = `checkExemptions[${i}]`;
    if (!ex || typeof ex !== 'object') { errors.push(`${label} deve ser objeto`); continue; }
    if (!isWorkflow(ex.workflow)) { errors.push(`${label}: workflow inválido`); continue; }
    if (!isStage(ex.stage) || !workflowStages[ex.workflow].includes(ex.stage)) { errors.push(`${label}: estágio ${String(ex.stage)} não pertence ao workflow ${ex.workflow}`); continue; }
    if (typeof ex.check !== 'string' || !getRequiredChecks(ex.workflow, ex.stage).includes(ex.check)) {
      errors.push(`${label}: dispensa de '${String(ex.check)}' incompatível — o método não exige esse check em ${ex.workflow}/${ex.stage}`);
    }
    if (typeof ex.reason !== 'string' || !ex.reason.trim()) errors.push(`${label}: motivo obrigatório`);
  }
  return errors;
}

/** Estágios que inspecionam código: quando 'lint' está configurado, ele se torna
 *  obrigatório neles (config build/lint/unit/e2e respeitada — antes, lint era ignorado). */
const LINT_STAGES: readonly Stage[] = ['build', 'review', 'pr', 'pr-review'];

/**
 * R4-14 — seleção compartilhada de checks, USADA POR check (cmdCheck), gate
 * (applyCompletion via productChecks) e relatório. Fonte do método: getRequiredChecks
 * (workflows); 'lint' entra apenas quando configurado e o estágio inspeciona código.
 */
export function requiredChecks(
  checks: Partial<Record<CheckName, CommandConfig>>,
  workflow: Workflow,
  stage: Stage,
  exemptions: CheckExemption[] = [],
): StageCheckSelection {
  const canonical = getRequiredChecks(workflow, stage);
  const names = [...canonical];
  if (!names.includes('lint') && checks.lint && LINT_STAGES.includes(stage)) names.push('lint');
  if (!canonical.length) {
    return { required: [], missing: [], skipped: Object.keys(checks), notApplicable: true, exempt: [] };
  }
  const required: string[] = [];
  const missing: string[] = [];
  const exempt: Array<{ check: string; reason: string }> = [];
  for (const name of names) {
    // R5-03: a obrigação vem do MÉTODO; só dispensa explícita aprovada a retira. A
    // presença/ausência do comando na config decide apenas executar vs. faltar.
    const ex = exemptions.find(e => e.workflow === workflow && e.stage === stage && e.check === name);
    if (ex) exempt.push({ check: name, reason: ex.reason });
    else if (checks[name as CheckName]) required.push(name);
    else missing.push(name);
  }
  return { required, missing, skipped: Object.keys(checks).filter(n => !names.includes(n)), notApplicable: false, exempt };
}

/** Conveniência: seleção a partir da config do projeto (+ dispensas aprovadas do manifesto). */
export function requiredChecksForConfig(config: Pick<ProjectConfig, 'checks'>, workflow: Workflow, stage: Stage, exemptions: CheckExemption[] = []): StageCheckSelection {
  return requiredChecks(config.checks, workflow, stage, exemptions);
}

// R5-04/R5-06: a captura do snapshot vive em ./snapshot.ts (resultado discriminado, inventário NUL, falha fechada).
export { captureCodeSnapshot, tryCaptureCodeSnapshot, SnapshotCaptureError } from './snapshot.js';
