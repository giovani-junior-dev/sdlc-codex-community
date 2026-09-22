import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCli } from '../../src/cli.js';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import { captureCodeSnapshot } from '../../src/evidence/snapshot.js';
import type { HerdrAdapter } from '../../src/adapters/herdr.js';
import type { Evidence, Message, Role, Run, SessionRecord, Stage, Workflow } from '../../src/contracts.js';

/**
 * R5 (M6) — fixtures compartilhadas dos testes de FLUXO pela CLI pública (feature/claim/variantes,
 * pr-effect, evidence-import, run-identity). Regra: o baseline verde é o fluxo COMPLETO do contrato
 * da rodada 5 — aprovação com manifesto (hash coberto pelo registro), check executado pelo produto
 * (snapshot antes/depois), rubrica humana com proveniência completa e snapshot copiado do `check`,
 * `gh pr view` respondido. Falsos SOMENTE nas bordas externas (codex queue, gh, git, tool de check);
 * arquivos, logs e estado são reais. Nenhuma fixture pré-autoriza o gate que o teste exercita:
 * as rejeições removem/alteram EXATAMENTE um fato do fluxo válido.
 */

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const HEAD = 'abc123';

export function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, value: { stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) } };
}

export type ChecksConfig = Record<string, { executable: string; args: string[] }>;
export const FULL_CHECKS: ChecksConfig = {
  build: { executable: 'tool', args: ['build'] }, lint: { executable: 'tool', args: ['lint'] },
  unit: { executable: 'tool', args: ['unit'] }, e2e: { executable: 'tool', args: ['e2e'] },
};

export function stageOwnerOf(stage: Stage): Role {
  return ({ build: 'dev', review: 'reviewer', e2e: 'tester-e2e', pr: 'dev', 'pr-review': 'reviewer', document: 'document' } as Record<Stage, Role>)[stage];
}

// ---------- bordas externas falsas ----------

export type QueueMode = 'enqueued' | 'uncertain' | 'failed';
export interface Envelope {
  messageId: string; projectId: string; from: string; type: string; body: string;
  runId?: string; stage?: string; revision?: number; correlationId?: string;
}
export interface QueueRec { threadId: string; args: string[]; raw: string; envelope: Envelope; }
export interface PrRow { url: string; headRefName: string; baseRefName: string; headRefOid: string; number: number; state: string; }
/** 'timeout-after-accept': a PR É criada mas a resposta estoura o prazo; 'timeout-no-effect': estoura sem criar;
 *  'fail': o gh recusa (exit 1, "autorização revogada") sem criar. */
export type CreateMode = 'ok' | 'timeout-after-accept' | 'timeout-no-effect' | 'fail';

/**
 * R4-13/R5 — falsos que simulam as BORDAS EXTERNAS. O queue fake CAPTURA os envelopes; o gh fake
 * responde `pr list` (só abertas), `pr view` (por URL/número) e `pr create` (contando); o git fake tem
 * HEAD/status/diff mutáveis (o snapshot de src/evidence/snapshot.ts usa rev-parse/status/diff).
 */
export class FlowHarness {
  readonly envelopes: QueueRec[] = [];
  queueMode: QueueMode = 'enqueued';
  git: { head: string; status: string; diff: string } = { head: HEAD, status: '', diff: '' };
  prs: PrRow[] = [];
  ghCreateCalls = 0;
  ghListCalls = 0;
  ghViewCalls = 0;
  ghCreateMode: CreateMode = 'ok';
  /** head devolvido pela PR criada (default = HEAD): simula resposta com head divergente. */
  ghCreateHead: string | undefined;
  nextPr = 7;
  readonly runner = new FakeProcessRunner((exe, args) => this.handle(exe, args));

  private handle(exe: string, args: string[]) {
    const base = { stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (exe === 'codex' && args[0] === 'queue') {
      const threadId = args[args.indexOf('--thread') + 1];
      const raw = args[args.indexOf('--message') + 1];
      this.envelopes.push({ threadId, args: [...args], raw, envelope: JSON.parse(raw) as Envelope });
      if (this.queueMode === 'enqueued') {
        return { ...base, exitCode: 0, stdout: JSON.stringify({ status: 'accepted', threadId, nativeMessageId: `native-${this.envelopes.length}` }) };
      }
      if (this.queueMode === 'uncertain') return { ...base, exitCode: 0, stdout: 'ok' }; // exit 0 sem receipt => uncertain
      return { ...base, exitCode: 1, stdout: '' };
    }
    if (exe === 'gh' && args[0] === 'pr') {
      if (args[1] === 'list') {
        this.ghListCalls++;
        const head = args[args.indexOf('--head') + 1];
        const b = args[args.indexOf('--base') + 1];
        return { ...base, exitCode: 0, stdout: JSON.stringify(this.prs.filter(p => p.headRefName === head && p.baseRefName === b && p.state === 'OPEN')) };
      }
      if (args[1] === 'view') {
        this.ghViewCalls++;
        const pr = this.prs.find(p => p.url === args[2] || String(p.number) === args[2]);
        if (!pr) return { ...base, exitCode: 1, stdout: '', stderr: 'no pull requests found' };
        return { ...base, exitCode: 0, stdout: JSON.stringify({ url: pr.url, number: pr.number, state: pr.state, headRefName: pr.headRefName, baseRefName: pr.baseRefName, headRefOid: pr.headRefOid }) };
      }
      this.ghCreateCalls++;
      if (this.ghCreateMode === 'timeout-no-effect') return { ...base, exitCode: null, stdout: '', timedOut: true };
      if (this.ghCreateMode === 'fail') return { ...base, exitCode: 1, stdout: '', stderr: 'autorização revogada' };
      const head = args[args.indexOf('--head') + 1];
      const b = args[args.indexOf('--base') + 1];
      const url = `https://github.com/acme/feat/pull/${this.nextPr}`;
      this.prs.push({ url, headRefName: head, baseRefName: b, headRefOid: this.ghCreateHead ?? this.git.head, number: this.nextPr, state: 'OPEN' });
      this.nextPr++;
      if (this.ghCreateMode === 'timeout-after-accept') return { ...base, exitCode: null, stdout: '', timedOut: true };
      return { ...base, exitCode: 0, stdout: `${url}\n` };
    }
    if (exe === 'git') {
      if (args[0] === 'rev-parse') return { ...base, exitCode: 0, stdout: `${this.git.head}\n` };
      if (args[0] === 'cat-file') return { ...base, exitCode: 0, stdout: '' };
      if (args[0] === 'status') return { ...base, exitCode: 0, stdout: this.git.status };
      if (args[0] === 'diff') return { ...base, exitCode: 0, stdout: this.git.diff };
      if (args[0] === 'worktree') return { ...base, exitCode: 0, stdout: '' };
      if (args[0] === 'show-ref') return { ...base, exitCode: 1, stdout: '' };
      if (args[0] === 'remote') return { ...base, exitCode: 0, stdout: 'git@github.com:acme/feat.git\n' };
      if (args[0] === 'merge-base') return { ...base, exitCode: 0, stdout: '' };
      return { ...base, exitCode: 0, stdout: '' };
    }
    if (exe === 'tool') return { ...base, exitCode: 0, stdout: 'ok' };
    return { ...base, exitCode: 0, stdout: '' };
  }
  queueSends(): number { return this.envelopes.length; }
  ghCalls(): number { return this.runner.calls.filter(c => c.executable === 'gh').length; }
  toolCalls() { return this.runner.calls.filter(c => c.executable === 'tool'); }
}

/** Herdr de teste: a nova aba "registra o hook" (SessionStart) a partir do env, com thread único por
 *  lançamento — o launcher só promove a 'ready' após COMBINAÇÃO hook + readiness (M5-F1). */
export class InstantHerdr implements HerdrAdapter {
  private counter = 0;
  constructor(private readonly root: string, private readonly projectId: string) {}
  private registry(): SessionRegistry {
    return new SessionRegistry(new StateStore(join(this.root, '.sdlc-codex'), { projectId: this.projectId }));
  }
  async ensureWorkspace(projectId: string, path: string) { return { workspaceId: 'w', projectId, path }; }
  async createTab(_workspaceId: string, _label: string, cwd: string, env: Record<string, string>) {
    const role = env.SDLC_CODEX_ROLE as Role;
    const thread = `thread-${role}-${++this.counter}`;
    await this.registry().register({
      event: 'SessionStart', session_id: thread, cwd,
      project_id: env.SDLC_CODEX_PROJECT_ID, role,
      token: env.SDLC_CODEX_LAUNCH_TOKEN,
    });
    return { tabId: `tab-${this.counter}` };
  }
  async listPanes() { return [{ paneId: 'pane-1', ready: true, workspaceId: 'w' }]; }
  async startAgent() { return; }
  async waitAgent() { return true; }
  async listAgents() { return []; }
}

// ---------- aprovação com manifesto (R5-05) ----------

export interface ManifestEntry { id: string; stage: Stage | 'any'; mandatory: boolean; }
export const DEFAULT_ENTRIES: ManifestEntry[] = [
  { id: 'REQ-1', stage: 'any', mandatory: true },
  { id: 'REQ-2', stage: 'review', mandatory: true },
  { id: 'REQ-3', stage: 'e2e', mandatory: true },
];
export interface ApprovalOpts {
  entries?: ManifestEntry[];
  /** texto do plano; default lista todos os IDs do manifesto (cada ID deve constar no plano). */
  planText?: string;
  /** manifesto cru (sobrepõe o gerado); o hash registrado na aprovação é o do texto escrito. */
  manifestText?: string;
}

/** intent + plano + manifesto + registro de aprovação COM `requirementsManifestPath/Hash` (arquivo). */
export async function writeApproval(root: string, o: ApprovalOpts = {}): Promise<{ intent: string; plan: string; manifest: string }> {
  const entries = o.entries ?? DEFAULT_ENTRIES;
  const intent = '# intent\nobjetivo aprovado\n';
  const plan = o.planText ?? `# plano\n${entries.map(e => `${e.id}: requisito`).join('\n')}\n`;
  const manifest = o.manifestText ?? JSON.stringify({ schemaVersion: 1, planPath: 'plan.md', planHash: sha256(plan), entries });
  await writeFile(join(root, 'intent.md'), intent);
  await writeFile(join(root, 'plan.md'), plan);
  await writeFile(join(root, 'requirements.json'), manifest);
  await writeFile(join(root, 'approval.json'), JSON.stringify({
    intentPath: 'intent.md', planPath: 'plan.md', approvedBy: 'humano',
    approvedAt: '2026-09-19T00:00:00Z', planVersion: 'plano-v1',
    intentHash: sha256(intent), planHash: sha256(plan),
    requirementsManifestPath: 'requirements.json', requirementsManifestHash: sha256(manifest),
  }));
  return { intent, plan, manifest };
}

export async function adoptProject(root: string, config: Record<string, unknown>, runner: FakeProcessRunner): Promise<void> {
  const cfg = join(root, 'incoming.json');
  await writeFile(cfg, JSON.stringify(config));
  const x = io();
  assert.equal(await runCli(['adopt', '--config', cfg, '--project', root, '--apply'], x.value, { runner }), 0, x.err.join('\n'));
}

// ---------- rubrica humana com proveniência completa ----------

export interface RubricInput {
  root: string; slug: string; stage: Stage; ids: string[]; projectId: string;
  run: { runId: string; revision: number };
  sess: { role: Role; threadId?: string; generationId: string };
  /** `snapshot` do payload de `check` (a importação nunca o preenche). */
  snapshot: unknown;
  commit?: string;
  result?: 'pass' | 'fail';
  timestamp?: string;
  /** id da evidência: default `ev-<stage>-<REQ>-<n>`. */
  idOf?: (reqId: string, n: number) => string;
  logText?: string;
}
let rubricSeq = 0;

/** Escreve o log real e devolve os itens de evidência (SEM gravar o arquivo de evidências). */
export async function rubricItems(o: RubricInput): Promise<Evidence[]> {
  const n = ++rubricSeq;
  const logName = `rubric-${o.stage}-${n}.log`;
  const text = o.logText ?? `rubrica humana ${o.stage} ${o.ids.join(',')}\n`;
  await mkdir(join(o.root, 'logs'), { recursive: true });
  await writeFile(join(o.root, 'logs', logName), text);
  const result = o.result ?? 'pass';
  const ts = o.timestamp ?? '2026-09-19T02:00:00Z';
  return o.ids.map(id => ({
    id: o.idOf ? o.idOf(id, n) : `ev-${o.stage}-${id}-${n}`, requirementId: `${o.slug}:${o.stage}:${id}`, result, verdict: result,
    procedure: `rubrica humana do estágio ${o.stage}`,
    logPath: `logs/${logName}`, logHash: sha256(text), timestamp: ts, producedAt: ts,
    file: 'src/a.ts', line: 1, commit: o.commit ?? HEAD,
    runId: o.run.runId, stage: o.stage, projectId: o.projectId, revision: o.run.revision,
    producer: { role: o.sess.role, threadId: o.sess.threadId as string, generationId: o.sess.generationId },
    ...(o.snapshot ? { codeSnapshot: o.snapshot as Evidence['codeSnapshot'] } : {}),
  }));
}

export async function writeItems(root: string, name: string, items: unknown[]): Promise<string> {
  await writeFile(join(root, name), JSON.stringify(items));
  return name;
}

export async function writeRubricFile(o: RubricInput): Promise<string> {
  const items = await rubricItems(o);
  return writeItems(o.root, `ev-rubric-${o.stage}-${rubricSeq}.json`, items);
}

// ---------- projeto de fluxo (adopt → up → start → check → next) ----------

export interface ProjectOpts {
  projectId: string;
  slug?: string;
  workflow?: Workflow;
  checks?: ChecksConfig;
  approval?: ApprovalOpts;
  name?: string;
}

/** Projeto temporário com adopt feito e bordas falsas; helpers pelos comandos PÚBLICOS. */
export class FlowProject {
  readonly harness = new FlowHarness();
  opN = 0;
  private constructor(readonly root: string, readonly projectId: string, readonly slug: string, readonly workflow: Workflow, readonly opts: ProjectOpts) {}
  private herdr!: HerdrAdapter;
  get deps() { return { runner: this.harness.runner, herdr: this.herdr }; }

  static async create(o: ProjectOpts): Promise<FlowProject> {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-flow-'));
    const p = new FlowProject(root, o.projectId, o.slug ?? 'feat-1', o.workflow ?? 'feature', o);
    p.herdr = new InstantHerdr(root, o.projectId);
    await adoptProject(root, {
      schemaVersion: 1, projectId: o.projectId, projectName: o.name ?? 'Flow', prBase: 'main',
      checks: o.checks ?? FULL_CHECKS, models: {}, protectedPaths: ['.git'],
    }, p.harness.runner);
    return p;
  }

  store() { return new StateStore(join(this.root, '.sdlc-codex'), { projectId: this.projectId }); }
  state() { return this.store().read(); }
  worktree(slug = this.slug) { return join(this.root, '.sdlc-codex', 'worktrees', slug); }
  /** Run ativo do slug (R4-07): o running; sem ele, o mais recente (auditoria de terminal). */
  async run(slug = this.slug): Promise<Run> {
    const runs = (await this.state()).runs.filter(r => r.slug === slug);
    return runs.find(r => r.status === 'running') ?? runs[runs.length - 1];
  }
  async actor(role: Role): Promise<SessionRecord> {
    const s = (await this.state()).sessions.find(x => x.role === role && x.status === 'ready');
    assert.ok(s?.threadId, `sessão ${role} pronta`);
    return s;
  }
  approve(o: ApprovalOpts = this.opts.approval ?? {}) { return writeApproval(this.root, o); }

  async up(slug = this.slug, workflow: Workflow = this.workflow, roles?: string): Promise<Array<{ role: Role; ready: boolean; generationId: string }>> {
    const x = io();
    const argv = ['up', slug, ...(roles ? ['--roles', roles] : ['--workflow', workflow]), '--project', this.root, '--json'];
    assert.equal(await runCli(argv, x.value, this.deps), 0, x.err.join('\n'));
    const out = JSON.parse(x.out[0]) as { partial: boolean; team: Array<{ role: Role; ready: boolean; generationId: string }> };
    assert.equal(out.partial, false, `time completo para ${workflow}`);
    return out.team;
  }

  async start(slug = this.slug, workflow: Workflow = this.workflow): Promise<{ code: number; out: string; err: string }> {
    const x = io();
    const code = await runCli(['start', slug, '--intent', 'intent.md', '--plan', 'plan.md', '--approval', 'approval.json', '--workflow', workflow, '--project', this.root, '--json'], x.value, this.deps);
    return { code, out: x.out.join(''), err: x.err.join('') };
  }

  /** aprovação completa + up + start bem-sucedido; devolve o runId. */
  async boot(slug = this.slug, workflow: Workflow = this.workflow): Promise<string> {
    await this.approve();
    await this.up(slug, workflow);
    const r = await this.start(slug, workflow);
    assert.equal(r.code, 0, `start: ${r.err}`);
    return (JSON.parse(r.out) as { runId: string }).runId;
  }

  /** `check` público (checks reais do produto); devolve o payload (inclui `snapshot`). */
  async check(stage: Stage, sess?: SessionRecord, slug = this.slug): Promise<{ code: number; payload: { checks: Array<{ name: string; status: string; evidenceId: string; logPath?: string }>; snapshot: unknown }; err: string; raw: string }> {
    const s = sess ?? await this.actor(stageOwnerOf(stage));
    const x = io();
    const code = await runCli(['check', slug, '--stage', stage, '--thread', s.threadId!, '--generation', s.generationId, '--project', this.root, '--json'], x.value, this.deps);
    let payload = { checks: [], snapshot: undefined } as { checks: Array<{ name: string; status: string; evidenceId: string; logPath?: string }>; snapshot: unknown };
    try { payload = JSON.parse(x.out.join('')); } catch { /* saída não-JSON em erro */ }
    return { code, payload, err: x.err.join('\n'), raw: x.out.join('') };
  }

  /** snapshot atual da árvore (o que o produto calcula) SEM gravar evidência. */
  async snapshotNow(slug = this.slug): Promise<unknown> {
    return captureCodeSnapshot(this.harness.runner, (await this.run(slug)).worktree ?? this.root);
  }

  ids(stage: Stage): string[] {
    const entries = this.opts.approval?.entries ?? DEFAULT_ENTRIES;
    return entries.filter(e => e.mandatory && (e.stage === 'any' || e.stage === stage)).map(e => e.id);
  }

  async rubric(stage: Stage, ids: string[], snapshot: unknown, o: { sess?: SessionRecord; slug?: string; result?: 'pass' | 'fail'; commit?: string; timestamp?: string; idOf?: RubricInput['idOf']; logText?: string } = {}): Promise<string> {
    const slug = o.slug ?? this.slug;
    return writeRubricFile({
      root: this.root, slug, stage, ids, projectId: this.projectId, run: await this.run(slug),
      sess: o.sess ?? await this.actor(stageOwnerOf(stage)), snapshot,
      commit: o.commit ?? this.harness.git.head, result: o.result, timestamp: o.timestamp, idOf: o.idOf, logText: o.logText,
    });
  }

  async next(stage: Stage, verdict: 'pass' | 'fail', evidenceFile: string, o: { sess?: SessionRecord; slug?: string; opId?: string; revision?: number; extra?: string[] } = {}): Promise<{ code: number; out: string; err: string; oid: string }> {
    const slug = o.slug ?? this.slug;
    const r = await this.run(slug);
    const s = o.sess ?? await this.actor(stageOwnerOf(stage));
    const oid = o.opId ?? `op-${++this.opN}`;
    const y = io();
    const code = await runCli(['next', slug, stage, verdict, '--revision', String(o.revision ?? r.revision), '--operation-id', oid,
      '--evidence', evidenceFile, '--role', s.role, '--thread', s.threadId!, '--generation', s.generationId,
      '--project', this.root, '--json', ...(o.extra ?? [])], y.value, this.deps);
    return { code, out: y.out.join(''), err: y.err.join(''), oid };
  }

  /** estágio COMPLETO e válido: check do produto → rubrica (snapshot copiado do check) → next pass. */
  async pass(stage: Stage, o: { sess?: SessionRecord; slug?: string; opId?: string; ids?: string[] } = {}) {
    const sess = o.sess ?? await this.actor(stageOwnerOf(stage));
    const c = await this.check(stage, sess, o.slug);
    assert.equal(c.code, 0, `check ${stage}: ${c.err} ${c.raw}`);
    // checks reais do produto aprovados com log; seleção vazia acidental seria 'missing'/fail, nunca pass.
    assert.ok(c.payload.checks.every(k => k.status === 'approved' && k.logPath), `checks reais aprovados em ${stage}: ${JSON.stringify(c.payload.checks)}`);
    const file = await this.rubric(stage, o.ids ?? this.ids(stage), c.payload.snapshot, { sess, slug: o.slug });
    return this.next(stage, 'pass', file, { sess, slug: o.slug, opId: o.opId });
  }

  async receiveTask(stage: Stage, sess: SessionRecord, slug = this.slug): Promise<Message> {
    const r = await this.run(slug);
    const msg = (await this.state()).messages.find(m =>
      m.runId === r.runId && m.type === 'task' && m.stage === stage && m.revision === r.revision && m.to === sess.role);
    assert.ok(msg, `task de ${stage} na revisão ${r.revision}`);
    const y = io();
    assert.equal(await runCli(['receive', msg.messageId, '--role', sess.role, '--thread', sess.threadId!, '--generation', sess.generationId, '--project', this.root, '--json'], y.value, this.deps), 0, y.err.join('\n'));
    assert.equal((JSON.parse(y.out[0]) as { action: string }).action, 'execute');
    return msg;
  }

  /** "nada mudou": estágio/revisão/evidência/mensagens/entregas/operações da execução. */
  async fingerprint(slug = this.slug): Promise<{ stage: Stage; revision: number; status: string; evidence: number; messages: number; deliveries: number; ops: number }> {
    const s = await this.state();
    const r = s.runs.filter(x => x.slug === slug).at(-1)!;
    return { stage: r.stage, revision: r.revision, status: r.status, evidence: s.evidence.length, messages: s.messages.length, deliveries: s.deliveries.length, ops: Object.keys(s.operations).length };
  }

  /** Semeia o estágio de forma DIRETA (fixture): só posiciona a execução; não autoriza nenhum gate. */
  async seedStage(stage: Stage): Promise<void> {
    await this.store().mutate(s => ({
      state: { ...s, runs: s.runs.map(r => r.slug === this.slug && r.status === 'running' ? { ...r, stage, owner: stageOwnerOf(stage), revision: r.revision + 1 } : r) },
      result: undefined,
    }));
  }
}
