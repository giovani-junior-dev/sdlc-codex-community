import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry, latestGeneration } from '../../src/sessions/registry.js';
import { TeamLauncher } from '../../src/sessions/launcher.js';
import type { LaunchResult } from '../../src/sessions/launcher.js';
import { GitAdapter } from '../../src/adapters/git.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { HerdrAdapter, HerdrAgent, HerdrPane } from '../../src/adapters/herdr.js';
import type { Role, SessionRecord, SessionStatus } from '../../src/contracts.js';

// R5-10/M5-F2 — reconciliação persistente de unknown. Falsos SOMENTE nas bordas
// (Herdr/Git); runtime, registry e launcher são reais em diretórios temporários.

const PROJECT_A = '11111111-2222-3333-4444-5555555555a1';
const PROJECT_B = '11111111-2222-3333-4444-5555555555b2';

const OK = { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
const gitFake = () => new FakeProcessRunner(() => OK);

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, value: { stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) } };
}

interface Inventory { agents: HerdrAgent[] | Error; panes: HerdrPane[] | Error }

/** Herdr falso com CONTAGEM de cada chamada e inventário programável (lança quando Error = indisponível). */
class CountingHerdr implements HerdrAdapter {
  counts = { ensureWorkspace: 0, createTab: 0, startAgent: 0, waitAgent: 0, listAgents: 0, listPanes: 0 };
  inventory: Inventory = { agents: [], panes: [] };
  /** true: createTab simula o hook SessionStart imediato (registra a geração recém-preparada). */
  autoRegister = true;
  private tabs = 0;
  constructor(private readonly store: StateStore) {}

  async ensureWorkspace(projectId: string, path: string) { this.counts.ensureWorkspace++; return { workspaceId: 'w', projectId, path }; }
  async createTab(_ws: string, _label: string, cwd: string, env: Record<string, string>) {
    this.counts.createTab++;
    const paneId = `pane-novo-${++this.tabs}`;
    if (this.autoRegister) {
      const registry = new SessionRegistry(this.store);
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await registry.register({
            event: 'SessionStart', session_id: `thread-${env.SDLC_CODEX_GENERATION_ID}`, cwd,
            project_id: env.SDLC_CODEX_PROJECT_ID, role: env.SDLC_CODEX_ROLE, token: env.SDLC_CODEX_LAUNCH_TOKEN,
          });
          break;
        } catch (error) {
          if (attempt === 19) throw error; // EPERM transitório de rename concorrente no Windows: tenta de novo
          await new Promise(r => setTimeout(r, 25));
        }
      }
    }
    return { tabId: `tab-${this.tabs}`, paneId };
  }
  async listPanes() { this.counts.listPanes++; if (this.inventory.panes instanceof Error) throw this.inventory.panes; return this.inventory.panes; }
  async startAgent() { this.counts.startAgent++; }
  async waitAgent() { this.counts.waitAgent++; return true; }
  async listAgents() { this.counts.listAgents++; if (this.inventory.agents instanceof Error) throw this.inventory.agents; return this.inventory.agents; }
  get creations(): number { return this.counts.createTab + this.counts.startAgent + this.counts.ensureWorkspace; }
}

interface Ctx { root: string; projectId: string; store: StateStore; herdr: CountingHerdr; registry: SessionRegistry }

async function newProject(projectId: string): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-r5-sessions-'));
  const cfg = join(root, 'incoming.json');
  await writeFile(cfg, JSON.stringify({ schemaVersion: 1, projectId, projectName: 'R5-10', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'] }));
  const x = io();
  assert.equal(await runCli(['adopt', '--config', cfg, '--project', root, '--apply', '--json'], x.value), 0, x.err.join(' '));
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId });
  await store.init(projectId);
  return { root, projectId, store, herdr: new CountingHerdr(store), registry: new SessionRegistry(store) };
}

async function seed(ctx: Ctx, sessions: Array<Partial<SessionRecord> & { role: Role; generationId: string; status: SessionStatus }>): Promise<void> {
  await ctx.store.mutate(s => ({
    state: {
      ...s,
      sessions: sessions.map(x => ({
        projectId: ctx.projectId, cwd: ctx.root, workspaceId: 'w', lastEventAt: new Date().toISOString(),
        threadId: x.status === 'launching' ? undefined : `thread-${x.generationId}`, ...x,
      }) as SessionRecord),
    },
    result: undefined,
  }));
}

const healthyInventory = (paneId: string): Inventory => ({
  agents: [{ name: 'codex', paneId, kind: 'codex' }],
  panes: [{ paneId, workspaceId: 'w', ready: true }],
});

async function up(ctx: Ctx, extra: string[] = ['--roles', 'planner']): Promise<{ code: number; team: LaunchResult[]; partial: boolean }> {
  const x = io();
  const code = await runCli(['up', 'demanda-1', '--project', ctx.root, '--json', ...extra], x.value, { runner: gitFake(), herdr: ctx.herdr });
  const parsed = JSON.parse(x.out[0]) as { team: LaunchResult[]; partial: boolean };
  return { code, team: parsed.team, partial: parsed.partial };
}

const statusOf = async (ctx: Ctx, generationId: string) => (await ctx.store.read()).sessions.find(s => s.generationId === generationId)?.status;
const launcherOf = (ctx: Ctx) => new TeamLauncher(ctx.herdr, new GitAdapter(gitFake()), ctx.registry);

const OFFLINE = new Error('herdr fora do ar');

// ---------------------------------------------------------------------------

// Reprodução mínima do defeito pela CLI pública, só com campos que já existiam (sem `reason`).
test('R5-10: 2º up com inventário ainda offline NÃO cria aba (defeito: createTab do 2º up)', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-a', status: 'ready', paneId: 'pane-1' }]);
  ctx.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };
  await up(ctx);
  assert.equal(ctx.herdr.counts.createTab, 0, '1º up: zero criação');
  assert.equal(await statusOf(ctx, 'gen-a'), 'unknown', '1º up: unknown');
  const second = await up(ctx);
  assert.equal(ctx.herdr.counts.createTab, 0, `2º up: createTab=${ctx.herdr.counts.createTab} (esperado 0)`);
  assert.equal(second.partial, true, '2º up continua parcial (sem esclarecer o inventário)');
  assert.equal((await ctx.store.read()).sessions.length, 1, '2º up: nenhuma geração nova');
  assert.equal(await statusOf(ctx, 'gen-a'), 'unknown', '2º up: unknown persiste');
});

test('R5-10: up repetido com inventário offline (1º, 2º, 3º) nunca cria e mantém unknown', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-a', status: 'ready', paneId: 'pane-1' }]);
  ctx.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };

  for (const n of [1, 2, 3]) {
    const r = await up(ctx);
    // ZERO criação a cada up: nenhum workspace/tab/agente (invariante central do R5-10).
    assert.equal(ctx.herdr.counts.createTab, 0, `up #${n}: createTab`);
    assert.equal(ctx.herdr.counts.startAgent, 0, `up #${n}: startAgent`);
    assert.equal(ctx.herdr.creations, 0, `up #${n}: zero createTab/startAgent/ensureWorkspace`);
    assert.equal(r.partial, true, `up #${n}: time parcial`);
    assert.equal(r.team[0].ready, false);
    assert.equal(r.team[0].reason, 'inventory', `up #${n}: motivo`);
    assert.equal(r.team[0].generationId, 'gen-a', `up #${n}: aponta a geração conhecida`);
    assert.match(r.team[0].error ?? '', /inventário|unknown/);
    // O inventário é RECONSULTADO em cada up (não decidido por cache/estado).
    assert.equal(ctx.herdr.counts.listAgents, n, `up #${n}: inventário reconsultado`);
    // Estado persistido: continua unknown, sem geração nova.
    const state = await ctx.store.read();
    assert.equal(state.sessions.length, 1, `up #${n}: nenhuma geração nova`);
    assert.equal(state.sessions[0].status, 'unknown', `up #${n}: unknown persiste`);
  }
  // Auditoria não é inflada pelas repetições: uma única transição ready->unknown.
  const events = (await ctx.store.read()).events.filter(e => e.kind === 'session-unknown' && e.detail === 'gen-a');
  assert.equal(events.length, 1);
});

test('R5-10: inventário volta saudável -> reutiliza a MESMA geração, volta a ready com auditoria', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-a', status: 'ready', paneId: 'pane-1' }]);
  ctx.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };
  await up(ctx);
  await up(ctx);
  assert.equal(await statusOf(ctx, 'gen-a'), 'unknown');

  ctx.herdr.inventory = healthyInventory('pane-1');
  const r = await up(ctx);
  assert.equal(r.partial, false);
  assert.equal(r.team[0].ready, true);
  assert.equal(r.team[0].reused, true);
  assert.equal(r.team[0].reconciled, true);
  assert.equal(r.team[0].generationId, 'gen-a', 'mesma identidade');
  assert.equal(ctx.herdr.creations, 0, 'sem nova aba/agente');
  const state = await ctx.store.read();
  assert.equal(state.sessions.length, 1, 'sem nova geração');
  assert.equal(state.sessions[0].status, 'ready');
  assert.equal(state.sessions[0].threadId, 'thread-gen-a', 'identidade preservada');
  assert.ok(state.events.some(e => e.kind === 'session-reconciled' && e.detail.includes('gen-a')), 'auditoria da reconciliação');
  // Idempotente: novo up reutiliza sem novo evento de reconciliação.
  const again = await up(ctx);
  assert.equal(again.team[0].reused, true);
  assert.equal(again.team[0].reconciled, undefined);
});

test('R5-10: morte comprovada -> nova geração; a unknown antiga só fecha na promoção e nunca rebaixa a nova', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-velha', status: 'ready', paneId: 'pane-1' }]);
  ctx.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };
  await up(ctx);
  assert.equal(await statusOf(ctx, 'gen-velha'), 'unknown');

  // Inventário volta e PROVA a ausência: pane existe e não tem agente codex.
  ctx.herdr.inventory = { agents: [], panes: [{ paneId: 'pane-1', workspaceId: 'w', ready: true }] };
  const r = await up(ctx);
  assert.equal(r.team[0].ready, true, JSON.stringify(r.team[0]));
  assert.notEqual(r.team[0].generationId, 'gen-velha', 'nova geração');
  assert.equal(ctx.herdr.counts.createTab, 1);
  assert.equal(ctx.herdr.counts.startAgent, 1);
  const state = await ctx.store.read();
  const nova = r.team[0].generationId;
  assert.equal(state.sessions.find(s => s.generationId === nova)?.status, 'ready');
  assert.equal(state.sessions.find(s => s.generationId === 'gen-velha')?.status, 'closed', 'substituição confirmada fecha a unknown antiga');
  assert.ok(state.events.some(e => e.kind === 'session-superseded' && e.detail.includes('gen-velha') && e.detail.includes(nova)));

  // A antiga (mesmo reemitida por geração) NÃO rebaixa a nova.
  await ctx.registry.invalidateByGeneration('gen-velha', 'unknown');
  await ctx.registry.eventByGeneration('gen-velha', 'unknown', 'launch-timeout');
  assert.equal(await statusOf(ctx, nova), 'ready', 'nova intacta');
  assert.equal(await statusOf(ctx, 'gen-velha'), 'closed', 'closed é terminal');

  // O próximo up reutiliza a nova (vigente = mais recente), sem criar.
  ctx.herdr.inventory = healthyInventory(state.sessions.find(s => s.generationId === nova)!.paneId!);
  const before = ctx.herdr.counts.createTab;
  const next = await up(ctx);
  assert.equal(next.team[0].generationId, nova);
  assert.equal(next.team[0].reused, true);
  assert.equal(ctx.herdr.counts.createTab, before);
});

test('R5-10: nova geração que não confirma NÃO fecha a unknown antiga (sem prova de morte da antiga substituída)', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-velha', status: 'unknown', paneId: 'pane-1' }]);
  ctx.herdr.inventory = { agents: [], panes: [{ paneId: 'pane-1', workspaceId: 'w', ready: true }] };
  ctx.herdr.autoRegister = false; // hook nunca chega: a nova expira
  const [r] = await launcherOf(ctx).launch({ projectId: PROJECT_A, projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'launch-timeout');
  const state = await ctx.store.read();
  assert.equal(state.sessions.find(s => s.generationId === 'gen-velha')?.status, 'unknown', 'antiga não é fechada sem confirmação');
  assert.equal(state.sessions.find(s => s.generationId === r.generationId)?.status, 'unknown', 'nova expirada persistida unknown');
});

test('R5-10: timeout de lançamento vs falha de inventário são diferenciados por reason', async () => {
  const ctx = await newProject(PROJECT_A);
  ctx.herdr.autoRegister = false;
  const [first] = await launcherOf(ctx).launch({ projectId: PROJECT_A, projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 600 });
  assert.equal(first.reason, 'launch-timeout');
  assert.match(first.error ?? '', /SessionStart|readiness/);
  const created = ctx.herdr.counts.createTab;
  assert.equal(created, 1);
  const timedOutGen = first.generationId;
  const state0 = await ctx.store.read();
  assert.ok(state0.events.some(e => e.kind === 'launch-timeout' && e.detail === timedOutGen), 'causa auditada');

  // (a) inventário indisponível: falha de inventário, com a nota do timeout anterior; zero criação.
  ctx.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };
  const [offline] = await launcherOf(ctx).launch({ projectId: PROJECT_A, projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 600 });
  assert.equal(offline.reason, 'inventory');
  assert.match(offline.error ?? '', /expirou/);
  assert.equal(ctx.herdr.counts.createTab, created, 'zero criação');

  // (b) agente ainda vivo no pane MAS sem SessionStart: identidade não comprovada — timeout, zero criação.
  const pane = state0.sessions.find(s => s.generationId === timedOutGen)!.paneId!;
  ctx.herdr.inventory = healthyInventory(pane);
  const [alive] = await launcherOf(ctx).launch({ projectId: PROJECT_A, projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 600 });
  assert.equal(alive.reason, 'launch-timeout');
  assert.equal(alive.ready, false);
  assert.equal(ctx.herdr.counts.createTab, created, 'zero criação com agente vivo sem hook');
  assert.equal(await statusOf(ctx, timedOutGen), 'unknown');
});

test('R5-10: interrupted sem seleção explícita -> zero criação com reason interrupted; com --roles relança', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-pausada', status: 'interrupted', paneId: 'pane-1' }]);
  ctx.herdr.inventory = healthyInventory('pane-1');

  const [semSelecao] = await launcherOf(ctx).launch({ projectId: PROJECT_A, projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(semSelecao.ready, false);
  assert.equal(semSelecao.reason, 'interrupted');
  assert.match(semSelecao.error ?? '', /retome a sessão ou solicite a substituição com up --roles planner/);
  assert.equal(ctx.herdr.creations, 0, 'zero criação');
  assert.equal(ctx.herdr.counts.listAgents, 0, 'sem consulta: pausada não é despertada nem reavaliada');
  assert.equal(await statusOf(ctx, 'gen-pausada'), 'interrupted', 'estado intacto');

  const [explicita] = await launcherOf(ctx).launch({ projectId: PROJECT_A, projectRoot: ctx.root, roles: ['planner'], explicitRoles: true, registrationTimeoutMs: 600 });
  assert.equal(explicita.ready, true, JSON.stringify(explicita));
  assert.notEqual(explicita.generationId, 'gen-pausada');
  assert.equal(ctx.herdr.counts.createTab, 1, 'pedido explícito = substituição');
  const state = await ctx.store.read();
  assert.equal(state.sessions.find(s => s.generationId === explicita.generationId)?.status, 'ready');
  assert.equal(state.sessions.find(s => s.generationId === 'gen-pausada')?.status, 'interrupted', 'pausada não é fechada sem prova de morte');
});

test('R5-10: up sem --roles (CLI) com papel interrupted: zero criação e os demais papéis seguem', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [
    { role: 'planner', generationId: 'gen-pausada', status: 'interrupted', paneId: 'pane-p' },
    { role: 'reviewer', generationId: 'gen-rev', status: 'ready', paneId: 'pane-r' },
  ]);
  ctx.herdr.inventory = {
    agents: [{ name: 'rev', paneId: 'pane-r', kind: 'codex' }],
    panes: [{ paneId: 'pane-r', workspaceId: 'w', ready: true }, { paneId: 'pane-p', workspaceId: 'w', ready: true }],
  };
  const r = await up(ctx, ['--workflow', 'review-only']);
  const planner = r.team.find(t => t.role === 'planner')!;
  const reviewer = r.team.find(t => t.role === 'reviewer')!;
  assert.equal(r.partial, true);
  assert.equal(planner.reason, 'interrupted');
  assert.equal(reviewer.reused, true);
  assert.equal(ctx.herdr.creations, 0);
  assert.equal(await statusOf(ctx, 'gen-pausada'), 'interrupted');
});

test('R5-10: launching recente é lançamento em andamento: zero criação e não é substituído', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-lancando', status: 'launching', paneId: 'pane-1', launchToken: 'tok' }]);
  ctx.herdr.inventory = { agents: [], panes: [{ paneId: 'pane-1', workspaceId: 'w', ready: true }] };
  const r = await up(ctx);
  assert.equal(r.team[0].ready, false);
  assert.equal(r.team[0].reason, 'launch-in-progress');
  assert.match(r.team[0].error ?? '', /em andamento/);
  assert.equal(ctx.herdr.creations, 0);
  assert.equal(ctx.herdr.counts.listAgents, 0, 'não reavalia lançamento dentro do prazo');
  const state = await ctx.store.read();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].status, 'launching', 'não rebaixado nem substituído');
});

test('R5-10: launching recente respeita a folga configurável (launchGraceMs)', async () => {
  const ctx = await newProject(PROJECT_A);
  const dezSegundosAtras = new Date(Date.now() - 10_000).toISOString();
  await seed(ctx, [{ role: 'planner', generationId: 'gen-l', status: 'launching', paneId: 'pane-1', launchToken: 'tok', lastEventAt: dezSegundosAtras }]);
  ctx.herdr.inventory = { agents: [], panes: [{ paneId: 'pane-1', workspaceId: 'w', ready: true }] };
  // prazo 1s + folga 60s => 10s ainda é "em andamento".
  const [dentro] = await launcherOf(ctx).launch({ projectId: PROJECT_A, projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 1000, launchGraceMs: 60_000 });
  assert.equal(dentro.reason, 'launch-in-progress');
  assert.equal(ctx.herdr.creations, 0);
  // prazo 1s + folga padrão (1s) => 10s já venceu; sem threadId + inventário indisponível => diagnóstico, zero criação.
  ctx.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };
  const [vencida] = await launcherOf(ctx).launch({ projectId: PROJECT_A, projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 1000 });
  assert.equal(vencida.reason, 'inventory');
  assert.equal(ctx.herdr.creations, 0);
});

test('R5-10: launching antigo sem threadId: sem prova de ausência = diagnóstico e zero criação; com prova = relança', async () => {
  const velha = new Date(Date.now() - 10 * 60_000).toISOString();

  // (a) inventário indisponível => ambíguo => unknown, zero criação.
  const a = await newProject(PROJECT_A);
  await seed(a, [{ role: 'planner', generationId: 'gen-l', status: 'launching', paneId: 'pane-1', launchToken: 'tok', lastEventAt: velha }]);
  a.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };
  const ra = await up(a);
  assert.equal(ra.team[0].reason, 'inventory');
  assert.equal(a.herdr.creations, 0);
  assert.equal(await statusOf(a, 'gen-l'), 'unknown', 'launching vencido persiste como unknown');

  // (b) agente vivo no pane mas sem SessionStart => identidade não comprovada => zero criação.
  const b = await newProject(PROJECT_A);
  await seed(b, [{ role: 'planner', generationId: 'gen-l', status: 'launching', paneId: 'pane-1', launchToken: 'tok', lastEventAt: velha }]);
  b.herdr.inventory = healthyInventory('pane-1');
  const rb = await up(b);
  assert.equal(rb.team[0].reason, 'launch-timeout');
  assert.equal(b.herdr.creations, 0);
  assert.equal(await statusOf(b, 'gen-l'), 'unknown');

  // (c) pane sem agente (ausência comprovada) => up relança; a antiga launching some/fecha e a nova fica ready.
  const c = await newProject(PROJECT_A);
  await seed(c, [{ role: 'planner', generationId: 'gen-l', status: 'launching', paneId: 'pane-1', launchToken: 'tok', lastEventAt: velha }]);
  c.herdr.inventory = { agents: [], panes: [{ paneId: 'pane-1', workspaceId: 'w', ready: true }] };
  const rc = await up(c);
  assert.equal(rc.team[0].ready, true, JSON.stringify(rc.team[0]));
  assert.equal(c.herdr.counts.createTab, 1);
  const stateC = await c.store.read();
  assert.equal(stateC.sessions.find(s => s.generationId === rc.team[0].generationId)?.status, 'ready');
  assert.equal(stateC.sessions.find(s => s.generationId === 'gen-l')?.status, 'closed', 'o launching antigo é FECHADO (registro preservado, nunca apagado)');
  assert.ok(stateC.events.some(e => e.kind === 'session-superseded' && e.detail.includes('gen-l')), 'substituição auditada');
});

test('R5-10: launching antigo COM threadId e inventário saudável reconcilia para ready (sem nova geração)', async () => {
  const ctx = await newProject(PROJECT_A);
  const velha = new Date(Date.now() - 10 * 60_000).toISOString();
  await seed(ctx, [{ role: 'planner', generationId: 'gen-l', status: 'launching', paneId: 'pane-1', threadId: 'thread-hook', launchToken: 'tok', lastEventAt: velha }]);
  ctx.herdr.inventory = healthyInventory('pane-1');
  const r = await up(ctx);
  assert.equal(r.team[0].reconciled, true);
  assert.equal(r.team[0].generationId, 'gen-l');
  assert.equal(ctx.herdr.creations, 0);
  assert.equal(await statusOf(ctx, 'gen-l'), 'ready');
});

test('R5-10: ambiguidade de inventário (duplicado, múltiplos agentes, sem paneId) mantém unknown sem criar', async () => {
  const cenarios: Array<{ nome: string; seedExtra: Partial<SessionRecord>; inventory: Inventory }> = [
    { nome: 'pane duplicado', seedExtra: { paneId: 'pane-1' }, inventory: { agents: [{ name: 'a', paneId: 'pane-1', kind: 'codex' }], panes: [{ paneId: 'pane-1', workspaceId: 'w', ready: true }, { paneId: 'pane-1', workspaceId: 'w', ready: true }] } },
    { nome: 'múltiplos agentes', seedExtra: { paneId: 'pane-1' }, inventory: { agents: [{ name: 'a', paneId: 'pane-1', kind: 'codex' }, { name: 'b', paneId: 'pane-1', kind: 'codex' }], panes: [{ paneId: 'pane-1', workspaceId: 'w', ready: true }] } },
    { nome: 'sem paneId', seedExtra: { paneId: undefined }, inventory: healthyInventory('pane-1') },
    { nome: 'outro workspace', seedExtra: { paneId: 'pane-1' }, inventory: { agents: [{ name: 'a', paneId: 'pane-1', kind: 'codex' }], panes: [{ paneId: 'pane-1', workspaceId: 'w-outro', ready: true }] } },
  ];
  for (const c of cenarios) {
    const ctx = await newProject(PROJECT_A);
    await seed(ctx, [{ role: 'planner', generationId: 'gen-a', status: 'unknown', ...c.seedExtra }]);
    ctx.herdr.inventory = c.inventory;
    for (let n = 1; n <= 2; n++) {
      const r = await up(ctx);
      assert.equal(r.team[0].reason, 'inventory', `${c.nome} up #${n}`);
      assert.equal(ctx.herdr.creations, 0, `${c.nome} up #${n}: zero criação`);
      assert.equal(await statusOf(ctx, 'gen-a'), 'unknown', `${c.nome} up #${n}`);
    }
  }
});

test('R5-10: geração unknown fechada por SessionEnd (mais recente closed) não bloqueia novo lançamento', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-fim', status: 'closed', paneId: 'pane-1' }]);
  const r = await up(ctx);
  assert.equal(r.team[0].ready, true);
  assert.equal(ctx.herdr.counts.createTab, 1);
  assert.equal(ctx.herdr.counts.listAgents, 0, 'closed é terminal: sem reconsulta');
});

test('R5-10: projetos distintos com mesmo nome/papel/demanda não se cruzam (projectId)', async () => {
  const a = await newProject(PROJECT_A);
  const b = await newProject(PROJECT_B);
  await seed(a, [{ role: 'planner', generationId: 'gen-a', status: 'unknown', paneId: 'pane-a' }]);

  // Função pura: registro misto (projeto A e B) — a vigente é sempre a do projectId pedido.
  const mistos = [
    { role: 'planner', generationId: 'ga', projectId: PROJECT_A, status: 'unknown', cwd: 'x', lastEventAt: new Date().toISOString() },
    { role: 'planner', generationId: 'gb', projectId: PROJECT_B, status: 'ready', cwd: 'x', lastEventAt: new Date().toISOString() },
  ] as SessionRecord[];
  assert.equal(latestGeneration(mistos, PROJECT_A, 'planner')?.generationId, 'ga');
  assert.equal(latestGeneration(mistos, PROJECT_B, 'planner')?.generationId, 'gb');
  assert.equal(latestGeneration(mistos, 'inexistente', 'planner'), undefined);

  // Inventário compartilhado mostra o agente do projeto A num pane; o projeto B, sem sessões, NÃO o reutiliza.
  b.herdr.inventory = healthyInventory('pane-a');
  const rb = await up(b);
  assert.equal(rb.team[0].ready, true);
  assert.notEqual(rb.team[0].reused, true, 'B não reutiliza a sessão de A');
  assert.equal(b.herdr.counts.createTab, 1);
  // A permanece exatamente como estava (unknown), sem criação.
  assert.equal(await statusOf(a, 'gen-a'), 'unknown');
  assert.equal(a.herdr.creations, 0);
  // E A, com inventário indisponível, continua sem criar mesmo com B saudável.
  a.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };
  const ra = await up(a);
  assert.equal(ra.team[0].reason, 'inventory');
  assert.equal(a.herdr.creations, 0);
  assert.equal((await b.store.read()).sessions.filter(s => s.role === 'planner').length, 1);
});

// ---------- revisão independente C (A1–A4) ----------

test('R5-10 (revisão C/A1) dois up SIMULTÂNEOS do mesmo papel criam UMA aba (a guarda é a própria reserva sob lock)', async () => {
  const ctx = await newProject(PROJECT_A);
  ctx.herdr.inventory = healthyInventory('pane-novo-1');
  const [r1, r2] = await Promise.all([up(ctx), up(ctx)]);
  assert.equal(ctx.herdr.counts.createTab, 1, `createTab=${ctx.herdr.counts.createTab} (esperado 1)`);
  assert.equal(ctx.herdr.counts.startAgent, 1);
  const results = [r1.team[0], r2.team[0]];
  assert.equal(results.filter(r => r.ready && !r.reused).length, 1, JSON.stringify(results));
  const loser = results.find(r => !r.ready || r.reused);
  assert.ok(loser, 'o outro up NÃO criou sessão');
  assert.ok(loser.reason === 'launch-in-progress' || loser.reused === true, JSON.stringify(loser));
  const state = await ctx.store.read();
  assert.equal(state.sessions.filter(s => s.role === 'planner').length, 1, 'uma geração no runtime');
  assert.equal(state.sessions.filter(s => s.status === 'ready').length, 1);
});

test('R5-10 (revisão C/A2) a geração launching substituída é FECHADA com auditoria — nunca apagada', async () => {
  const ctx = await newProject(PROJECT_A);
  const velha = new Date(Date.now() - 10 * 60_000).toISOString();
  await seed(ctx, [{ role: 'planner', generationId: 'gen-l', status: 'launching', paneId: 'pane-1', launchToken: 'tok', lastEventAt: velha }]);
  ctx.herdr.inventory = { agents: [], panes: [{ paneId: 'pane-1', workspaceId: 'w', ready: true }] };
  const r = await up(ctx);
  assert.equal(r.team[0].ready, true, JSON.stringify(r.team[0]));
  const state = await ctx.store.read();
  assert.equal(state.sessions.find(s => s.generationId === 'gen-l')?.status, 'closed', 'registro preservado e fechado');
  assert.ok(state.events.some(e => e.kind === 'session-superseded' && e.detail.includes('gen-l')), 'evento session-superseded gravado');
});

test('R5-10 (revisão C/A3) falha transitória ao persistir o timeout é REINTENTADA (não engolida); falha permanente entra no diagnóstico', async () => {
  for (const mode of ['transitoria', 'permanente'] as const) {
    const ctx = await newProject(PROJECT_A);
    ctx.herdr.autoRegister = false; // o hook nunca registra: o lançamento estoura o prazo
    let calls = 0;
    const flaky = new SessionRegistry(ctx.store);
    const original = flaky.eventByGeneration.bind(flaky);
    flaky.eventByGeneration = async (...args: Parameters<SessionRegistry['eventByGeneration']>) => {
      calls++;
      if (mode === 'permanente' || calls === 1) throw new Error('EPERM rename (injetado)');
      return original(...args);
    };
    const launcher = new TeamLauncher(ctx.herdr, new GitAdapter(gitFake()), flaky);
    const [result] = await launcher.launch({ projectId: ctx.projectId, projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 700 });
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'launch-timeout');
    const state = await ctx.store.read();
    if (mode === 'transitoria') {
      assert.ok(calls >= 2, 'tentou de novo');
      assert.equal(state.sessions.find(s => s.generationId === result.generationId)?.status, 'unknown');
      assert.ok(state.events.some(e => e.kind === 'launch-timeout' && e.detail === result.generationId), 'causa auditada');
      assert.doesNotMatch(result.error ?? '', /falha ao persistir/);
    } else {
      assert.equal(calls, 4, 'quatro tentativas');
      assert.match(result.error ?? '', /falha ao persistir o estado da sessão após 4 tentativas/);
    }
  }
});

test('R5-10 (revisão C/A4) unknown ambíguo: `up --roles` sozinho NÃO substitui; `--replace-unknown` (ação humana explícita) substitui com auditoria', async () => {
  const ctx = await newProject(PROJECT_A);
  await seed(ctx, [{ role: 'planner', generationId: 'gen-u', status: 'unknown', paneId: 'pane-1' }]);
  ctx.herdr.inventory = { agents: OFFLINE, panes: OFFLINE };
  const plain = await up(ctx, ['--roles', 'planner']);
  assert.equal(plain.team[0].reason, 'inventory');
  assert.match(plain.team[0].error ?? '', /--replace-unknown/, 'a mensagem ensina a ação explícita');
  assert.equal(ctx.herdr.creations, 0);
  // --replace-unknown SEM --roles não tem efeito (a seleção explícita de papéis é parte do pedido)
  // --replace-unknown SEM --roles é RECUSADO (exit 2) — nunca ignorado em silêncio (verificação V1)
  const refused = io();
  assert.equal(await runCli(['up', 'demanda-1', '--project', ctx.root, '--json', '--replace-unknown'], refused.value, { runner: gitFake(), herdr: ctx.herdr }), 2);
  assert.match(refused.err.join(' '), /--replace-unknown exige --roles/);
  const stateNoRoles = await ctx.store.read();
  assert.equal(stateNoRoles.sessions.find(s => s.generationId === 'gen-u')?.status, 'unknown', '--replace-unknown sem --roles não substitui');
  assert.equal(stateNoRoles.sessions.filter(s => s.role === 'planner').length, 1, 'nenhuma geração nova para o planner');
  const tabsBefore = ctx.herdr.counts.createTab;
  // o inventário CONTINUA indisponível: sem prova de morte, só a ação humana explícita autoriza a substituição
  const replaced = await up(ctx, ['--roles', 'planner', '--replace-unknown']);
  assert.equal(replaced.team[0].ready, true, JSON.stringify(replaced.team[0]));
  assert.equal(ctx.herdr.counts.createTab, tabsBefore + 1, "--replace-unknown com --roles cria exatamente uma aba");
  const state = await ctx.store.read();
  assert.equal(state.sessions.find(s => s.generationId === 'gen-u')?.status, 'closed', 'a unknown declarada perdida fecha na substituição');
  assert.ok(state.events.some(e => e.kind === 'session-human-replace' && e.detail === 'gen-u'), 'ação humana auditada');
  assert.ok(state.events.some(e => e.kind === 'session-superseded'));
});

// ---------- verificação independente V1 ----------

/** Barreira DETERMINÍSTICA entre a decisão e a reserva: `ensureWorkspace` roda depois da decisão e antes do prepare. */
function barrierAtWorkspace(ctx: Ctx, parties: number): void {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  ctx.herdr.ensureWorkspace = async (projectId: string, path: string) => {
    ctx.herdr.counts.ensureWorkspace++;
    if (++arrivals === parties) release();
    await gate;
    return { workspaceId: 'w', projectId, path };
  };
}

test('R5-10 (verificação V1-2) o CAS da reserva é exercido DETERMINISTICAMENTE: mesma decisão obsoleta → só um cria; o outro recebe launch-in-progress', async () => {
  const ctx = await newProject(PROJECT_A);
  barrierAtWorkspace(ctx, 2);
  const [r1, r2] = await Promise.all([up(ctx), up(ctx)]);
  const results = [r1.team[0], r2.team[0]];
  assert.equal(ctx.herdr.counts.createTab, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.ready).length, 1);
  const loser = results.find(r => !r.ready)!;
  assert.equal(loser.reason, 'launch-in-progress', 'o perdedor passou pelo CAS (não pela guarda de resolveExisting)');
  assert.match(loser.error ?? '', /mudou depois da decisão/);
});

test('R5-10 (verificação V1-1) o perdedor da corrida NUNCA executa git worktree add; falha do worktree fecha a reserva', async () => {
  const ctx = await newProject(PROJECT_A);
  barrierAtWorkspace(ctx, 2);
  const runner = new FakeProcessRunner((_exe, args) => (args[0] === 'worktree' && args[1] === 'list') ? { ...OK, stdout: '' } : args[0] === 'show-ref' ? { ...OK, exitCode: 1 } : OK);
  const launcher = new TeamLauncher(ctx.herdr, new GitAdapter(runner), ctx.registry);
  const input = { projectId: ctx.projectId, projectRoot: ctx.root, roles: ['dev' as Role], demand: 'd1', devWorktree: join(ctx.root, '.sdlc-codex', 'worktrees', 'd1'), gitBase: 'main', registrationTimeoutMs: 3000 };
  const [a, b] = await Promise.all([launcher.launch(input), launcher.launch(input)]);
  const adds = runner.calls.filter(c => c.args[0] === 'worktree' && c.args[1] === 'add');
  assert.equal(adds.length, 1, `git worktree add: ${adds.length} (esperado 1)`);
  const loser = [a[0], b[0]].find(r => !r.ready)!;
  assert.equal(loser.reason, 'launch-in-progress', JSON.stringify(loser));

  // falha do worktree depois de vencer a reserva: a geração não fica 'launching' fantasma
  const ctx2 = await newProject(PROJECT_A);
  const failing = new FakeProcessRunner((_exe, args) => (args[0] === 'worktree' && args[1] === 'add') ? { ...OK, exitCode: 1, stderr: 'fatal: boom' } : args[0] === 'show-ref' ? { ...OK, exitCode: 1 } : OK);
  const launcher2 = new TeamLauncher(ctx2.herdr, new GitAdapter(failing), ctx2.registry);
  const [r] = await launcher2.launch({ ...input, projectRoot: ctx2.root, projectId: ctx2.projectId, devWorktree: join(ctx2.root, '.sdlc-codex', 'worktrees', 'd1') });
  assert.equal(r.ready, false);
  assert.match(r.error ?? '', /worktree add falhou/);
  const st = await ctx2.store.read();
  assert.ok(st.sessions.every(s => s.status !== 'launching'), 'nenhum launching fantasma');
  assert.ok(st.events.some(e => e.kind === 'worktree-failed'), 'causa auditada');
  assert.equal(ctx2.herdr.counts.createTab, 0, 'nenhuma aba criada');
});
