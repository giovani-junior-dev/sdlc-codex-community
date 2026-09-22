/**
 * C13/S14 — Harness executável do piloto live (tarefa 13).
 * R4-16 (M7-F2) — guardas endurecidas:
 *   - Alvo e raiz temporária são CANONICALIZADOS (resolve + realpath, que
 *     resolve junctions/symlinks) e o pertencimento é comparado por
 *     COMPONENTES de caminho — nunca por prefixo textual cru. `..` é
 *     neutralizado pela canonicalização; marcador sozinho NÃO autoriza
 *     diretório fora da raiz permitida.
 *   - O resultado de `up` é validado ESTRUTURADO (partial=false + readiness +
 *     identidade generationId de todos os papéis necessários). Exit0 isolado
 *     NÃO significa time completo.
 *   - O relatório separa etapas automatizadas, manuais e não executadas;
 *     evidência manual exige anexos verificáveis (arquivo existente e não
 *     vazio) — passo manual vazio nunca vira pass.
 *   - Todas as guardas rodam ANTES de qualquer efeito externo.
 *
 * Separado da suíte padrão: só é exercido via `npm run test:live` com
 * `SDLC_LIVE=1`. A suíte padrão testa apenas as GUARDAS e o MECANISMO com
 * falsos (tests/unit/live-harness.test.ts) — nunca efeitos externos.
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { NodeProcessRunner, type ProcessRunner } from '../../src/adapters/process.js';
import { CodexTransport } from '../../src/adapters/codex.js';

export class LiveGuardError extends Error {}

export interface LiveEnv {
  live: string | undefined;
  target: string | undefined;
  /** Diretório temporário esperado do alvo (segurança: recusa alvos fora dele). */
  expectedTmpPrefix: string;
}

export interface ProbeDeps { runner?: ProcessRunner; }

const DISPOSABLE_MARKER = '.sdlc-live-fixture';

/** Time completo do workflow feature: planner + donos dos estágios (workflows.ts). */
export const FEATURE_TEAM_ROLES = ['planner', 'dev', 'reviewer', 'tester-e2e', 'document'] as const;

/**
 * R4-16 — validação ESTRUTURADA do resultado de `up`. Exit0 isolado não
 * significa time completo: exige partial=false E, para cada papel
 * necessário, presença no time, readiness (ready=true) e identidade
 * (generationId não vazio). Lança LiveGuardError com motivo específico.
 */
export interface UpTeamEntry { role: string; paneId?: string; generationId?: string; ready?: boolean; reused?: boolean; error?: string; }
export interface UpResult { slug: string; workflow: string; team: UpTeamEntry[]; partial: boolean; }

export function validateUpResult(raw: unknown, requiredRoles: readonly string[] = FEATURE_TEAM_ROLES): UpResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LiveGuardError('resultado de up ilegível (JSON inexistente ou inválido); exit0 sem payload estruturado não comprova time completo');
  }
  const result = raw as UpResult;
  if (result.partial !== false) {
    throw new LiveGuardError('up reportou time parcial (partial≠false); exit0 isolado não significa time completo');
  }
  if (!Array.isArray(result.team)) throw new LiveGuardError('resultado de up sem lista de time estruturada');
  for (const role of requiredRoles) {
    const entry = result.team.find(t => t && t.role === role);
    if (!entry) throw new LiveGuardError(`papel ${role} ausente no time reportado por up`);
    if (entry.ready !== true) throw new LiveGuardError(`papel ${role} sem readiness (ready≠true): ${entry.error ?? 'sem detalhe'}`);
    if (!entry.generationId) throw new LiveGuardError(`papel ${role} sem identidade (generationId vazio)`);
  }
  return result;
}

// ---------- canonicalização de caminho (R4-16) ----------

/**
 * Canonicaliza por resolve (neutraliza `..`/`.` lexicamente) + realpath
 * (resolve junctions/symlinks do SO). Caminho inexistente cai no resolve
 * puro — a existência é checada depois, com mensagem própria.
 */
async function canonicalizePath(p: string): Promise<string> {
  const resolved = resolve(p);
  let cursor = resolved;
  const missing: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      const canonical = missing.length ? join(real, ...missing) : real;
      return canonical.startsWith('\\\\?\\') ? canonical.slice(4) : canonical;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolved;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** Componentes normalizados do caminho para comparação de pertencimento.
 *  Normaliza `..`/`.` lexicamente — a resolução de junction/symlink fica a
 *  cargo da canonicalização (realpath) feita antes na guarda. */
function pathComponents(p: string): string[] {
  const norm = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase();
  const out: string[] = [];
  for (const c of norm.split('/')) {
    if (!c || c === '.') continue;
    if (c === '..') { out.pop(); continue; }
    out.push(c);
  }
  return out;
}

/** Pertencimento por COMPONENTES: prefixo textual é insuficiente (sdlc-x ≠ sdlc-x-evil). */
export function isPathWithin(target: string, root: string): boolean {
  const tc = pathComponents(target);
  const rc = pathComponents(root);
  return rc.length <= tc.length && rc.every((c, i) => tc[i] === c);
}

/**
 * Guardas preventivas — rodam ANTES de qualquer efeito externo. Falha de
 * qualquer guarda aborta com LiveGuardError; nenhum comando externo é
 * executado antes desta função completar as checagens de caminho (as
 * sondas de versão abaixo SÃO a validação e são somente leitura:
 * `--version`).
 */
export async function validateLiveEnv(env: LiveEnv, deps: ProbeDeps = {}): Promise<{ target: string; codexVersion: string; herdrVersion: string }> {
  if (env.live !== '1') throw new LiveGuardError('SDLC_LIVE=1 é obrigatório (opt-in explícito)');
  if (!env.target) throw new LiveGuardError('SDLC_LIVE_TARGET=<diretório descartável> é obrigatório');
  const target = env.target;
  if (!isAbsolute(target)) throw new LiveGuardError(`alvo deve ser caminho absoluto: ${target}`);
  // R4-16: canonicaliza AMBOS os lados (resolve+realpath resolve `..`, junction e
  // symlink) e compara por componentes. Marcador sozinho não autoriza alvo fora
  // da raiz; o marcador é checado DEPOIS do pertencimento.
  const canonicalRoot = await canonicalizePath(env.expectedTmpPrefix);
  const canonicalTarget = await canonicalizePath(target);
  if (!isPathWithin(canonicalTarget, canonicalRoot)) {
    throw new LiveGuardError(`alvo ${target} fora do diretório temporário descartável (${env.expectedTmpPrefix}) — recusado`);
  }
  let stat;
  try { stat = await fs.stat(canonicalTarget); }
  catch { throw new LiveGuardError(`alvo ${target} não existe; crie o fixture descartável antes`); }
  if (!stat.isDirectory()) throw new LiveGuardError(`alvo ${target} não é diretório`);
  try { await fs.stat(join(canonicalTarget, DISPOSABLE_MARKER)); }
  catch { throw new LiveGuardError(`alvo sem marcador ${DISPOSABLE_MARKER} — somente o fixture descartável é aceito`); }

  const runner = deps.runner ?? new NodeProcessRunner();
  const codex = await new CodexTransport(runner).probe(['--version']).catch(() => undefined);
  if (!codex || codex.exitCode !== 0) throw new LiveGuardError('codex indisponível (codex --version falhou)');
  const herdr = await runner.run('herdr', ['--version'], { timeoutMs: 15_000 }).catch(() => undefined);
  if (!herdr || herdr.exitCode !== 0) throw new LiveGuardError('herdr indisponível (herdr --version falhou)');
  return { target: canonicalTarget, codexVersion: codex.stdout.trim(), herdrVersion: herdr.stdout.trim() };
}

// ---------- coleta de evidências e relatório honesto ----------

export type StepKind = 'automated' | 'manual';

export interface EvidenceEntry {
  step: string;
  kind: StepKind;
  command: string;
  /** null = passo manual (operador), sem código de saída. */
  exitCode: number | null;
  summary: string;
  at: string;
  /** Evidência manual: anexos verificáveis exigidos para contar como executada. */
  attachments?: string[];
  executed?: boolean;
  problems?: string[];
}

export interface PilotReport {
  generatedAt: string;
  automated: EvidenceEntry[];
  manual: EvidenceEntry[];
  /** Passos manuais SEM evidência verificável — listados, nunca pass. */
  notExecuted: string[];
  /** Validações live futuras, pendentes de autorização/ambiente (R4-16). */
  future: string[];
}

/** Coleta de evidências do piloto: cada passo registra comando, resultado e asserções. */
export class LiveEvidence {
  readonly entries: EvidenceEntry[] = [];
  record(step: string, command: string, exitCode: number | null, summary: string): void {
    this.entries.push({ step, kind: 'automated', command, exitCode, summary, at: new Date().toISOString() });
  }
  recordManual(step: string, description: string, attachments: string[] = []): void {
    this.entries.push({ step, kind: 'manual', command: '(operador humano)', exitCode: null, summary: description, at: new Date().toISOString(), attachments });
  }
  assert(step: string, condition: unknown, detail: string): void {
    if (!condition) throw new LiveGuardError(`asserção do piloto falhou em '${step}': ${detail}`);
  }
  /**
   * R4-16 — passo manual só conta como executado com anexos verificáveis
   * (arquivo existente e não vazio). Passo manual vazio permanece em
   * 'notExecuted' e NUNCA vira pass.
   */
  async verifyManualAttachments(): Promise<void> {
    for (const entry of this.entries) {
      if (entry.kind !== 'manual') continue;
      const problems: string[] = [];
      if (!entry.attachments?.length) problems.push('sem anexos verificáveis');
      for (const att of entry.attachments ?? []) {
        try {
          const st = await fs.stat(att);
          if (!st.isFile() || st.size === 0) problems.push(`${att}: vazio ou não-arquivo`);
        } catch {
          problems.push(`${att}: inacessível`);
        }
      }
      entry.problems = problems;
      entry.executed = problems.length === 0;
    }
  }
  report(): PilotReport {
    const manual = this.entries.filter(e => e.kind === 'manual');
    return {
      generatedAt: new Date().toISOString(),
      automated: this.entries.filter(e => e.kind === 'automated'),
      manual,
      notExecuted: manual.filter(e => !e.executed).map(e => e.step),
      future: [...FUTURE_LIVE],
    };
  }
  async write(reportPath: string): Promise<void> {
    await fs.mkdir(dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(this.report(), null, 2), 'utf8');
  }
}

/** Validações live futuras — NÃO executadas nesta sessão (sem opt-in/autorização). */
export const FUTURE_LIVE = [
  'Piloto de 60 minutos com consumo/tokens medidos e intervenções registradas em docs/validation/pilot-<data>.md.',
  'Dois projetos atendidos em paralelo pelo mesmo time de papéis.',
  'PR real autorizada explicitamente pelo usuário contra a base configurada.',
] as const;

export interface LiveStep { name: string; run: (ctx: { target: string; evidence: LiveEvidence }) => Promise<void>; }
export interface StepDeps { runner?: import('../../src/adapters/process.js').ProcessRunner; herdr?: import('../../src/adapters/herdr.js').HerdrAdapter; }
export interface LivePilotOptions {
  trustProject?: boolean;
  bypassHookTrust?: boolean;
  windowsSandbox?: 'elevated' | 'unelevated';
}

/**
 * Etapas AUTOMATIZADAS do piloto — executadas por runLivePilot somente depois das
 * guardas. Cada etapa opera exclusivamente no alvo descartável. Os passos usam a
 * composição pública (runCli); deps permite falsos nos testes de mecanismo —
 * em live real é omitido e a composição usa os adaptadores reais.
 */
export function automatedSteps(deps: StepDeps = {}, options: LivePilotOptions = {}): LiveStep[] {
  const ioSink = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) } };
  };
  return [
    {
      name: 'adopt-no-alvo',
      run: async ({ target, evidence }) => {
        const { runCli } = await import('../../src/cli.js');
        const sink = ioSink();
        const code = await runCli(['adopt', '--config', join(target, 'project-config.json'), '--project', target, '--apply', '--json'], sink.io, deps);
        evidence.record('adopt', 'sdlc-codex adopt --config <alvo> --apply', code, sink.out.join(' ').slice(0, 400));
        evidence.assert('adopt', code === 0, `adopt no alvo deve sair 0 (saiu ${code}): ${sink.err.join(' ').slice(0, 200)}`);
      },
    },
    {
      name: 'up-feature',
      run: async ({ target, evidence }) => {
        const { runCli } = await import('../../src/cli.js');
        const sink = ioSink();
        const args = ['up', 'pilot', '--workflow', 'feature'];
        if (options.trustProject) args.push('--trust-project');
        if (options.bypassHookTrust) args.push('--bypass-hook-trust');
        if (options.windowsSandbox) args.push('--windows-sandbox', options.windowsSandbox);
        args.push('--project', target, '--json');
        const code = await runCli(args, sink.io, deps);
        const stderrSummary = sink.err.join(' ').slice(0, 400);
        evidence.record('up', 'sdlc-codex up pilot --workflow feature', code, (stderrSummary || sink.out.join(' ')).slice(0, 400));
        evidence.assert('up', code === 0, `up deve sair 0 (saiu ${code}): ${stderrSummary.slice(0, 200)}`);
        // R4-16: exit0 isolado não basta — valida o payload estruturado.
        let parsed: unknown;
        try { parsed = JSON.parse(sink.out.join('\n')); } catch { parsed = undefined; }
        validateUpResult(parsed, FEATURE_TEAM_ROLES);
        const team = (parsed as UpResult).team.map(t => `${t.role}:${t.ready ? 'ready' : 'FALHA'}`).join(', ');
        evidence.record('up-team', 'validação estruturada do time', 0, `partial=false; papéis verificados: ${team}`);
      },
    },
  ];
}

/** Roteiro MANUAL — etapas que exigem operador; nunca executadas automaticamente.
 *  Cada item só sai de 'notExecuted' quando o operador anexar evidências
 *  verificáveis (verifyManualAttachments). */
export const MANUAL_STEPS = [
  'Aprovar intent/plano com o usuário e registrar approval.json com planVersion (C08) e o manifesto de requisitos coberto por hash (requirementsManifestPath/requirementsManifestHash — R5-05).',
  'Executar start e confirmar o kickoff na TUI do dev (receipt enqueued).',
  'Conduzir build → review (induzir uma falha real e correção) → e2e → pr → pr-review (reprovar uma vez e exercer a SEGUNDA passagem de pr com novo operationId, reutilizando a PR — R5-07/08) → document.',
  'Com PR real de teste: fechar a PR e confirmar que next pr-review/document NÃO conclui; reabrir e confirmar a observação por gh pr view (R5-07).',
  'Tentar editar AGENTS.md e um caminho protegido a partir de um subdiretório e confirmar o deny do hook PreToolUse real (R5-09).',
  'Repetir up com o inventário do Herdr indisponível e confirmar zero abas novas e sessão unknown persistente (R5-10).',
  'Trocar pergunta dev→planner e resposta com checkpoint no meio do fluxo.',
  'Encerrar um participante, relançar com up --roles e recuperar a entrega/claim.',
  'Induzir falha entre transição e envio; confirmar recover sem dupla transição.',
  'Rodar segundo projeto em paralelo e manter o piloto ativo por pelo menos 60 minutos.',
  'Registrar consumo/tokens medidos e intervenções humanas em docs/validation/pilot-<data>.md.',
] as const;

/**
 * Ponto de entrada do piloto. Falha de validação LANÇA LiveGuardError ANTES de
 * qualquer efeito externo. Não executar sem autorização explícita do usuário.
 */
export async function runLivePilot(
  env: LiveEnv,
  deps: ProbeDeps & StepDeps = {},
  options: LivePilotOptions = {},
): Promise<{ reportPath: string; evidence: LiveEvidence }> {
  const validation = await validateLiveEnv(env, deps);
  const evidence = new LiveEvidence();
  evidence.record('validate', 'guardas preventivas (opt-in, alvo descartável, versões)', 0,
    `codex=${validation.codexVersion} herdr=${validation.herdrVersion}`);
  for (const step of automatedSteps(deps, options)) {
    await step.run({ target: validation.target, evidence });
  }
  for (const [i, manual] of MANUAL_STEPS.entries()) {
    evidence.recordManual(`manual-${i + 1}`, manual);
  }
  await evidence.verifyManualAttachments();
  const reportPath = join(validation.target, 'pilot-evidence.json');
  await evidence.write(reportPath);
  return { reportPath, evidence };
}
