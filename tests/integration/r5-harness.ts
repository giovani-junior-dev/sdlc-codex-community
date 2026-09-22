import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCli } from '../../src/cli.js';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import { captureCodeSnapshot } from '../../src/evidence/snapshot.js';
import type { HerdrAdapter } from '../../src/adapters/herdr.js';
import type { Evidence, Role, Run, SessionRecord, Stage, Workflow } from '../../src/contracts.js';

/**
 * R5 — harness compartilhado das regressões da rodada 5.
 *
 * Regra de projeto: o helper de SUCESSO gera aprovação + manifesto (coberto por hash
 * no registro de aprovação) + check executado pelo produto + log durável + snapshot +
 * rubrica com proveniência completa; os helpers de FALHA removem EXATAMENTE UM fato
 * (opção `omit`). Nenhum default permissivo: o baseline verde é o fluxo completo.
 * Falsos somente nas bordas externas (git/gh/codex/tool); arquivos e logs são reais.
 */

export const PROJECT_ID = '11111111-2222-3333-4444-555555555590';
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, value: { stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) } };
}

const ALL_CHECKS = {
  build: { executable: 'tool', args: ['build'] }, lint: { executable: 'tool', args: ['lint'] },
  unit: { executable: 'tool', args: ['unit'] }, e2e: { executable: 'tool', args: ['e2e'] },
};

export interface PrRow { url: string; headRefName: string; baseRefName: string; headRefOid: string; number: number; state: string; }

/** Bordas externas falsas: codex queue, gh, git (somente leitura), tool de check. */
export class Edges {
  git = { head: 'abc123', statusZ: '', lsFiles: '', diff: '', diffCode: '', changedNames: '', changedNamesNoRenames: undefined as string | undefined };
  /** comandos git que devem falhar (exit 1) ou estourar timeout. */
  gitFail = new Set<string>();
  gitTimeout = new Set<string>();
  /** contador de chamadas por subcomando e "falha a partir da N-ésima chamada" (before ok / after falha). */
  gitCalls: Record<string, number> = {};
  gitFailFrom: Record<string, number> = {};
  /** comandos git que passam a falhar DEPOIS do primeiro `gh pr create` (falha pós-efeito). */
  gitFailAfterCreate = new Set<string>();
  prs: PrRow[] = [];
  ghCreateCalls = 0;
  ghViewCalls = 0;
  ghListCalls = 0;
  /** falha (exit 1) na N-ésima chamada de `gh pr list` e gancho executado no início de cada chamada (a PR pode "aparecer" entre duas leituras). */
  ghListFailAt = new Set<number>();
  ghListHook: ((callIndex: number) => void) | undefined;
  ghViewMode: 'ok' | 'fail' | 'timeout' | 'incomplete' = 'ok';
  ghCreateHead: string | undefined;
  /** 'timeout-after-accept': a PR É criada mas a resposta estoura o prazo; 'timeout-no-effect': estoura sem criar. */
  ghCreateMode: 'ok' | 'timeout-after-accept' | 'timeout-no-effect' = 'ok';
  toolFailFor = new Set<string>();
  queueSends = 0;
  private prCounter = 7;
  readonly runner = new FakeProcessRunner((exe, args) => this.handle(exe, args));

  private handle(exe: string, args: string[]) {
    const base = { stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (exe === 'codex' && args[0] === 'queue') {
      this.queueSends++;
      const threadId = args[args.indexOf('--thread') + 1];
      return { ...base, exitCode: 0, stdout: JSON.stringify({ status: 'accepted', threadId, nativeMessageId: `native-${this.queueSends}` }) };
    }
    if (exe === 'gh' && args[0] === 'pr') {
      if (args[1] === 'list') {
        this.ghListCalls++;
        this.ghListHook?.(this.ghListCalls);
        if (this.ghListFailAt.has(this.ghListCalls)) return { ...base, exitCode: 1, stdout: '', stderr: 'HTTP 502: bad gateway (injetado)' };
        const head = args[args.indexOf('--head') + 1];
        const b = args[args.indexOf('--base') + 1];
        return { ...base, exitCode: 0, stdout: JSON.stringify(this.prs.filter(p => p.headRefName === head && p.baseRefName === b && p.state === 'OPEN')) };
      }
      if (args[1] === 'view') {
        this.ghViewCalls++;
        if (this.ghViewMode === 'timeout') return { ...base, exitCode: null, stdout: '', timedOut: true };
        if (this.ghViewMode === 'fail') return { ...base, exitCode: 1, stdout: '', stderr: 'HTTP 502: bad gateway' };
        const ref = args[2];
        const pr = this.prs.find(p => p.url === ref || String(p.number) === ref);
        if (!pr) return { ...base, exitCode: 1, stdout: '', stderr: 'no pull requests found' };
        const body: Record<string, unknown> = { url: pr.url, number: pr.number, state: pr.state, headRefName: pr.headRefName, baseRefName: pr.baseRefName, headRefOid: pr.headRefOid };
        if (this.ghViewMode === 'incomplete') delete body.headRefOid;
        return { ...base, exitCode: 0, stdout: JSON.stringify(body) };
      }
      this.ghCreateCalls++;
      if (this.ghCreateMode === 'timeout-no-effect') return { ...base, exitCode: null, stdout: '', timedOut: true };
      const head = args[args.indexOf('--head') + 1];
      const b = args[args.indexOf('--base') + 1];
      const url = `https://github.com/acme/feat/pull/${this.prCounter}`;
      this.prs.push({ url, headRefName: head, baseRefName: b, headRefOid: this.ghCreateHead ?? this.git.head, number: this.prCounter, state: 'OPEN' });
      this.prCounter++;
      if (this.ghCreateMode === 'timeout-after-accept') return { ...base, exitCode: null, stdout: '', timedOut: true };
      return { ...base, exitCode: 0, stdout: `${url}\n` };
    }
    if (exe === 'git') {
      const sub = args[0];
      this.gitCalls[sub] = (this.gitCalls[sub] ?? 0) + 1;
      if (this.gitTimeout.has(sub)) return { ...base, exitCode: null, stdout: '', timedOut: true };
      const from = this.gitFailFrom[sub];
      if (this.gitFail.has(sub) || (from !== undefined && this.gitCalls[sub] >= from) ||
          (this.ghCreateCalls > 0 && this.gitFailAfterCreate.has(sub))) return { ...base, exitCode: 1, stdout: '', stderr: `fatal: ${sub} falhou (fake)` };
      if (sub === 'rev-parse') return { ...base, exitCode: 0, stdout: `${this.git.head}\n` };
      if (sub === 'status') return { ...base, exitCode: 0, stdout: this.git.statusZ };
      if (sub === 'ls-files') return { ...base, exitCode: 0, stdout: this.git.lsFiles };
      // changedNames = saída do git com detecção de rename LIGADA (padrão); changedNamesNoRenames = com --no-renames (revisão B/B1)
      if (sub === 'diff' && args.includes('--name-only')) return { ...base, exitCode: 0, stdout: args.includes('--no-renames') && this.git.changedNamesNoRenames !== undefined ? this.git.changedNamesNoRenames : this.git.changedNames };
      // pathspec de exclusão das raízes documentais aprovadas: o Git real omitiria o diff documental
      if (sub === 'diff') return { ...base, exitCode: 0, stdout: args.some(a => a.startsWith(':(exclude') && a.includes('docs/features')) ? this.git.diffCode : this.git.diff };
      if (sub === 'show-ref') return { ...base, exitCode: 1, stdout: '' };
      if (sub === 'remote') return { ...base, exitCode: 0, stdout: 'git@github.com:acme/feat.git\n' };
      return { ...base, exitCode: 0, stdout: '' };
    }
    if (exe === 'tool') {
      if (this.toolFailFor.has(args[0])) return { ...base, exitCode: 1, stdout: '', stderr: `${args[0]} falhou (fake)` };
      return { ...base, exitCode: 0, stdout: 'ok' };
    }
    return { ...base, exitCode: 0, stdout: '' };
  }
}

/** Herdr de teste: a aba nova "registra o hook" a partir do env; nunca abre nada real. */
class InstantHerdr implements HerdrAdapter {
  private counter = 0;
  constructor(private readonly root: string) {}
  private registry(): SessionRegistry {
    return new SessionRegistry(new StateStore(join(this.root, '.sdlc-codex'), { projectId: PROJECT_ID }));
  }
  async ensureWorkspace(projectId: string, path: string) { return { workspaceId: 'w', projectId, path }; }
  async createTab(_w: string, _label: string, cwd: string, env: Record<string, string>) {
    const role = env.SDLC_CODEX_ROLE as Role;
    await this.registry().register({
      event: 'SessionStart', session_id: `thread-${role}-${++this.counter}`, cwd,
      project_id: env.SDLC_CODEX_PROJECT_ID, role, token: env.SDLC_CODEX_LAUNCH_TOKEN,
    });
    return { tabId: `tab-${this.counter}` };
  }
  async listPanes() { return [{ paneId: 'pane-1', ready: true, workspaceId: 'w' }]; }
  async startAgent() { return; }
  async waitAgent() { return true; }
  async listAgents() { return []; }
}

export interface WorldOptions {
  workflow?: Workflow;
  /** 'all' = build/lint/unit/e2e; 'none' = checks:{}; ou objeto explícito. */
  checks?: 'all' | 'none' | Record<string, { executable: string; args: string[] }>;
  /** requisitos do plano/manifesto (padrão REQ-1 any, REQ-2 review, REQ-3 e2e). */
  entries?: Array<{ id: string; stage: Stage | 'any'; mandatory: boolean }>;
  checkExemptions?: Array<{ workflow: Workflow; stage: Stage; check: string; reason: string }>;
  documentRoots?: string[];
  /** remove o manifesto do registro de aprovação (não escreve os campos). */
  omitManifest?: boolean;
}

export type Omit1 = 'check' | 'log' | 'projectId' | 'revision' | 'producer' | 'snapshot' | 'runId' | 'logHash';

export class World {
  readonly edges = new Edges();
  slug = 'feat-1';
  opN = 0;
  rubricN = 0;
  private constructor(readonly root: string, readonly opts: WorldOptions) {}

  get deps() { return { runner: this.edges.runner, herdr: new InstantHerdr(this.root) as HerdrAdapter }; }
  get workflow(): Workflow { return this.opts.workflow ?? 'feature'; }
  store() { return new StateStore(join(this.root, '.sdlc-codex'), { projectId: PROJECT_ID }); }
  async state() { return this.store().read(); }
  async run(): Promise<Run> { return (await this.state()).runs.find(r => r.slug === this.slug)!; }
  async actor(role: Role): Promise<SessionRecord> {
    const s = (await this.state()).sessions.find(x => x.role === role && x.status === 'ready');
    assert.ok(s?.threadId, `sessão ${role} pronta`);
    return s;
  }
  worktree() { return join(this.root, '.sdlc-codex', 'worktrees', this.slug); }

  static async create(opts: WorldOptions = {}): Promise<World> {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-r5-'));
    const w = new World(root, opts);
    const checks = opts.checks === 'none' ? {} : opts.checks === undefined || opts.checks === 'all' ? ALL_CHECKS : opts.checks;
    const cfg = join(root, 'incoming.json');
    await writeFile(cfg, JSON.stringify({
      schemaVersion: 1, projectId: PROJECT_ID, projectName: 'R5', prBase: 'main', checks, models: {}, protectedPaths: ['.git'],
    }));
    const x = io();
    assert.equal(await runCli(['adopt', '--config', cfg, '--project', root, '--apply'], x.value, { runner: w.edges.runner }), 0, x.err.join('\n'));
    return w;
  }

  /** Aprovação COMPLETA: intent, plano com os IDs, manifesto e hash do manifesto no registro. */
  async writeApproval(overrides: { manifestText?: string; planText?: string } = {}): Promise<void> {
    const root = this.root;
    const entries = this.opts.entries ?? [
      { id: 'REQ-1', stage: 'any', mandatory: true },
      { id: 'REQ-2', stage: 'review', mandatory: true },
      { id: 'REQ-3', stage: 'e2e', mandatory: true },
    ];
    const intent = '# intent\nobjetivo aprovado\n';
    const plan = overrides.planText ?? `# plano\n${entries.map(e => `${e.id}: requisito`).join('\n')}\n`;
    await writeFile(join(root, 'intent.md'), intent);
    await writeFile(join(root, 'plan.md'), plan);
    const manifest = overrides.manifestText ?? JSON.stringify({
      schemaVersion: 1, planPath: 'plan.md', planHash: sha256(plan), entries,
      ...(this.opts.checkExemptions ? { checkExemptions: this.opts.checkExemptions } : {}),
      ...(this.opts.documentRoots ? { documentRoots: this.opts.documentRoots } : {}),
    });
    await writeFile(join(root, 'requirements.json'), manifest);
    await writeFile(join(root, 'approval.json'), JSON.stringify({
      intentPath: 'intent.md', planPath: 'plan.md', approvedBy: 'humano', approvedAt: '2026-09-19T00:00:00Z', planVersion: 'plano-v1',
      intentHash: sha256(intent), planHash: sha256(plan),
      ...(this.opts.omitManifest ? {} : { requirementsManifestPath: 'requirements.json', requirementsManifestHash: sha256(manifest) }),
    }));
  }

  async up(): Promise<void> {
    const x = io();
    assert.equal(await runCli(['up', this.slug, '--workflow', this.workflow, '--project', this.root, '--json'], x.value, this.deps), 0, x.err.join('\n'));
  }

  async start(): Promise<{ code: number; out: string; err: string }> {
    const x = io();
    const code = await runCli(['start', this.slug, '--intent', 'intent.md', '--plan', 'plan.md', '--approval', 'approval.json', '--workflow', this.workflow, '--project', this.root, '--json'], x.value, this.deps);
    return { code, out: x.out.join(''), err: x.err.join('') };
  }

  /** adopt + aprovação completa + up + start bem-sucedido. */
  async boot(): Promise<void> {
    await this.writeApproval();
    await this.up();
    const r = await this.start();
    assert.equal(r.code, 0, `start: ${r.err}`);
  }

  /** Executa `check` e devolve o payload JSON (checks + snapshot quando o produto o informa). */
  async check(stage: Stage): Promise<{ code: number; payload: Record<string, unknown>; err: string }> {
    const sess = await this.actor(stageOwnerOf(stage));
    const x = io();
    const code = await runCli(['check', this.slug, '--stage', stage, '--thread', sess.threadId!, '--generation', sess.generationId, '--project', this.root, '--json'], x.value, this.deps);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(x.out.join('')) as Record<string, unknown>; } catch { /* saída não-JSON em erro */ }
    return { code, payload, err: x.err.join('\n') };
  }

  /** Snapshot atual da árvore (o mesmo que o produto calcula) SEM gravar evidência mecânica. */
  async snapshotNow(): Promise<unknown> { return captureCodeSnapshot(this.edges.runner, (await this.run()).worktree ?? this.root); }

  /** Rubrica humana COMPLETA (proveniência, log real com hash, snapshot); `omit` remove exatamente um fato. */
  async rubric(stage: Stage, ids: string[], snapshot: unknown, omit?: Omit1, result: 'pass' | 'fail' = 'pass'): Promise<string> {
    const r = await this.run();
    const sess = await this.actor(stageOwnerOf(stage));
    const n = ++this.rubricN;
    const name = `ev-rubric-${stage}-${n}.json`;
    const logName = `rubric-${stage}-${n}.log`;
    const text = `rubrica humana ${stage} ${ids.join(',')}\n`;
    await mkdir(join(this.root, 'logs'), { recursive: true });
    if (omit !== 'log') await writeFile(join(this.root, 'logs', logName), text);
    const items = ids.map(id => {
      const e: Record<string, unknown> = {
        id: `ev-${stage}-${id}-${n}`, requirementId: `${this.slug}:${stage}:${id}`, result, verdict: result,
        procedure: `rubrica humana do estágio ${stage}`,
        logPath: `logs/${logName}`, logHash: sha256(text), timestamp: '2026-09-19T02:00:00Z', producedAt: '2026-09-19T02:00:00Z',
        file: 'src/a.ts', line: 1, commit: this.edges.git.head,
        runId: r.runId, stage, projectId: PROJECT_ID, revision: r.revision,
        producer: { role: sess.role, threadId: sess.threadId, generationId: sess.generationId },
        ...(snapshot ? { codeSnapshot: snapshot } : {}),
      };
      if (omit === 'projectId') delete e.projectId;
      if (omit === 'revision') delete e.revision;
      if (omit === 'producer') delete e.producer;
      if (omit === 'snapshot') delete e.codeSnapshot;
      if (omit === 'runId') delete e.runId;
      if (omit === 'logHash') delete e.logHash;
      return e as unknown as Evidence;
    });
    await writeFile(join(this.root, name), JSON.stringify(items));
    return name;
  }

  async next(stage: Stage, verdict: 'pass' | 'fail', evidenceFile: string, extra: string[] = [], opId?: string): Promise<{ code: number; out: string; err: string; oid: string }> {
    const r = await this.run();
    const sess = await this.actor(stageOwnerOf(stage));
    const oid = opId ?? `op-${++this.opN}`;
    const y = io();
    const code = await runCli(['next', this.slug, stage, verdict, '--revision', String(r.revision), '--operation-id', oid,
      '--evidence', evidenceFile, '--role', sess.role, '--thread', sess.threadId!, '--generation', sess.generationId,
      '--project', this.root, '--json', ...extra], y.value, this.deps);
    return { code, out: y.out.join(''), err: y.err.join(''), oid };
  }

  /** Requisitos de rubrica do estágio (manifesto padrão). */
  rubricIds(stage: Stage): string[] {
    const entries = this.opts.entries ?? [{ id: 'REQ-1', stage: 'any', mandatory: true }, { id: 'REQ-2', stage: 'review', mandatory: true }, { id: 'REQ-3', stage: 'e2e', mandatory: true }];
    return entries.filter(e => e.mandatory && (e.stage === 'any' || e.stage === stage)).map(e => e.id);
  }

  /** Estágio COMPLETO e válido: check do produto → rubrica → next pass. */
  async pass(stage: Stage, o: { skipCheck?: boolean; omit?: Omit1; opId?: string; snapshot?: unknown } = {}): Promise<{ code: number; out: string; err: string; oid: string }> {
    let snapshot: unknown = o.snapshot;
    if (o.skipCheck && snapshot === undefined) snapshot = await this.snapshotNow();
    if (!o.skipCheck) {
      const c = await this.check(stage);
      assert.equal(c.code, 0, `check ${stage}: ${c.err} ${JSON.stringify(c.payload)}`);
      snapshot = c.payload.snapshot;
    }
    const file = await this.rubric(stage, this.rubricIds(stage), snapshot, o.omit);
    return this.next(stage, 'pass', file, [], o.opId);
  }

  /** Estado da execução no reflexo do runtime — para asserts de "nada mudou". */
  async fingerprintState(): Promise<{ stage: Stage; revision: number; status: string; evidence: number; messages: number; deliveries: number; ops: number }> {
    const s = await this.state();
    const r = s.runs.find(x => x.slug === this.slug)!;
    return { stage: r.stage, revision: r.revision, status: r.status, evidence: s.evidence.length, messages: s.messages.length, deliveries: s.deliveries.length, ops: Object.keys(s.operations).length };
  }

  /** Semeia o estágio de forma DIRETA (fixture): só posiciona a execução; não autoriza nenhum gate. */
  async seedStage(stage: Stage): Promise<void> {
    await this.store().mutate(s => ({
      state: { ...s, runs: s.runs.map(r => r.slug === this.slug ? { ...r, stage, owner: stageOwnerOf(stage), revision: r.revision + 1 } : r) },
      result: undefined,
    }));
  }

  async readFileJson(p: string): Promise<unknown> { return JSON.parse(await readFile(join(this.root, p), 'utf8')); }
}

export function stageOwnerOf(stage: Stage): Role {
  return ({ build: 'dev', review: 'reviewer', e2e: 'tester-e2e', pr: 'dev', 'pr-review': 'reviewer', document: 'document' } as Record<Stage, Role>)[stage];
}
