import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { TeamLauncher } from '../../src/sessions/launcher.js';
import { HerdrProcessAdapter } from '../../src/adapters/herdr.js';
import { GitAdapter } from '../../src/adapters/git.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { ProcessResult } from '../../src/adapters/process.js';

interface Ctx { root: string; store: StateStore; registry: SessionRegistry; calls: Array<{ exe: string; args: string[] }>; gitCalls: string[][]; }

async function setup(handler: (exe: string, args: string[]) => ProcessResult, projectId = 'project-a'): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-'));
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId });
  await store.init(projectId);
  const calls: Array<{ exe: string; args: string[] }> = [];
  const gitCalls: string[][] = [];
  const herdrRunner = new FakeProcessRunner((exe, args) => { calls.push({ exe, args }); return handler(exe, args); });
  const gitRunner = new FakeProcessRunner((_exe, args) => {
    gitCalls.push(args);
    if (args[0] === 'worktree' && args[1] === 'list') return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'show-ref') return { exitCode: 1, stdout: '', stderr: 'not found', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
  const ctx: Ctx = { root, store, registry: new SessionRegistry(store), calls, gitCalls };
  void herdrRunner; void gitRunner;
  (ctx as unknown as Record<string, unknown>).herdrRunner = herdrRunner;
  (ctx as unknown as Record<string, unknown>).gitRunner = gitRunner;
  return ctx;
}

function herdrOf(ctx: Ctx): HerdrProcessAdapter {
  return new HerdrProcessAdapter((ctx as unknown as Record<string, unknown>).herdrRunner as FakeProcessRunner);
}
function gitOf(ctx: Ctx): GitAdapter {
  return new GitAdapter((ctx as unknown as Record<string, unknown>).gitRunner as FakeProcessRunner);
}

// R09/R16: adaptador de PRODUÇÃO com ProcessRunner falso — argumentos e respostas reais verificados.
test('launcher usa interfaces reais: workspace/tab/agent-start/agent-wait', async () => {
  const ctx = await setup((exe, args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'workspace' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'w-1' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'tab' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'tab-1', paneId: 'pane-9' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'pane' && args[1] === 'list') return { exitCode: 0, stdout: JSON.stringify([{ id: 'pane-8', workspaceId: 'outro' }, { id: 'pane-9', workspaceId: 'w-1' }]), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'agent' && args[1] === 'start') return { exitCode: 0, stdout: 'started', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'agent' && args[1] === 'wait') return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'agent' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
  const launcher = new TeamLauncher(herdrOf(ctx), gitOf(ctx), ctx.registry);
  // Aguarda o prepare criar a sessão launching, depois injeta o registro SessionStart.
  const nativeCodex = join(ctx.root, 'native', 'codex.exe');
  const launchPromise = launcher.launch({ projectId: 'project-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 8000, nativeCodexExecutable: nativeCodex, bypassHookTrust: true, trustProject: true, windowsSandbox: 'unelevated' });
  // Aguarda a sessão launching ser criada pelo prepare
  await new Promise(r => setTimeout(r, 50)); // dá tempo para o prepare criar a sessão launching
  const deadline = Date.now() + 6000;
  let injected = false;
  while (Date.now() < deadline && !injected) {
    const state = await ctx.store.read();
    const launching = state.sessions.find(s => s.status === 'launching' && s.launchToken);
    if (launching) {
      try {
        await ctx.registry.register({ event: 'SessionStart', session_id: 'thread-1', cwd: ctx.root, project_id: 'project-a', role: launching.role, token: launching.launchToken });
        injected = true;
      } catch {
        // EPERM transitório de rename concorrente no Windows: tenta de novo.
      }
    }
    await new Promise(r => setTimeout(r, 25));
  }
  const result = await launchPromise;
  assert.equal(result[0].ready, true);
  const flat = ctx.calls.map(c => [c.exe, ...c.args].join(' '));
  assert.ok(flat.some(s => s.startsWith('herdr workspace create')), flat.join('\n'));
  const tab = ctx.calls.find(c => c.args[0] === 'tab' && c.args[1] === 'create')!;
  assert.ok(tab.args.includes('--workspace') && tab.args.includes('--cwd') && tab.args.includes('--label'));
  assert.ok(tab.args.includes('--env'));
  const envIdx = tab.args.indexOf('--env');
  assert.ok(tab.args.slice(envIdx).join(' ').includes('SDLC_CODEX_LAUNCH_TOKEN='));
  assert.ok(tab.args.some(a => a.startsWith(`PATH=${join(ctx.root, 'native')}${delimiter}${join(ctx.root, '.sdlc-codex', 'bin')}${delimiter}`)), 'binário nativo do Codex precede o shim do SDLC no PATH');
  const start = ctx.calls.find(c => c.args[0] === 'agent' && c.args[1] === 'start')!;
  // herdr agent start <NAME> --kind codex --pane <ID>
  assert.match(start.args[2], /^sdlc-[a-f0-9]{16}-planner$/);
  assert.deepEqual(start.args.slice(3, 7), ['--kind', 'codex', '--pane', 'pane-9']);
  assert.ok(start.args.includes('--dangerously-bypass-hook-trust'), 'opt-in explícito encaminha a flag oficial para automação de hooks verificados');
  const sandboxConfig = start.args.findIndex((arg, index) => arg === '-c' && start.args[index + 1] === 'windows.sandbox="unelevated"');
  assert.ok(sandboxConfig >= 0, 'fallback explícito mantém o sandbox Windows e é encaminhado ao Codex');
  assert.ok(start.args.includes(`projects={'${ctx.root}'={trust_level='trusted'}}`), 'confiança entra na configuração antes do SessionStart');
  assert.ok(flat.some(s => s === 'herdr pane send-keys pane-9 Enter'), 'opt-in explícito confirma o prompt de confiança no pane exato');
  const wait = ctx.calls.find(c => c.args[0] === 'agent' && c.args[1] === 'wait')!;
  assert.ok(wait.args.includes('--timeout'));
  assert.ok(!flat.some(s => s.includes('workspace ensure') || s.includes('pane wait-ready') || s.includes('inventory')));
});

// R10: reutilização verificada ANTES de criar worktree; base configurada (nunca HEAD).
test('sessão saudável é reutilizada sem worktree novo; worktree usa base', async () => {
  const ctx = await setup((exe, args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return { exitCode: 0, stdout: JSON.stringify([{ id: 'w-1', cwd: 'x', label: 'project-a' }]), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'agent' && args[1] === 'list') return { exitCode: 0, stdout: JSON.stringify([{ name: 'project-a-planner', paneId: 'pane-ok', kind: 'codex' }]), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'pane' && args[1] === 'list') return { exitCode: 0, stdout: JSON.stringify([{ id: 'pane-ok', workspaceId: 'w-1' }]), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
  await ctx.store.mutate(s => ({
    state: { ...s, sessions: [{ role: 'planner', threadId: 't', generationId: 'g', projectId: 'project-a', cwd: ctx.root, paneId: 'pane-ok', workspaceId: 'w-1', status: 'ready', lastEventAt: new Date().toISOString() }] },
    result: undefined,
  }));
  const launcher = new TeamLauncher(herdrOf(ctx), gitOf(ctx), ctx.registry);
  const result = await launcher.launch({ projectId: 'project-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 1000 });
  assert.equal(result[0].ready, true);
  assert.equal(result[0].reused, true);
  assert.equal(ctx.gitCalls.length, 0);
});

// R10/C07: sem registro no prazo (ou pane não identificável) => parcial com diagnóstico, sem exceção.
test('papel sem registro vira parcial com diagnóstico', async () => {
  const ctx = await setup((_exe, args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'workspace' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'w-1' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'tab' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'tab-1' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
  // Criação válida, mas pane não identificável e registro nunca chega.
  const launcher = new TeamLauncher(herdrOf(ctx), gitOf(ctx), ctx.registry);
  const result = await launcher.launch({ projectId: 'project-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 800 });
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /não identificada|parcial/);
});

test('falha externa depois de prepare encerra a reserva e preserva generationId no diagnóstico', async () => {
  const ctx = await setup((_exe, args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'workspace' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'w-1' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'tab' && args[1] === 'create') return { exitCode: 1, stdout: '', stderr: 'tab recusada', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
  const result = await new TeamLauncher(herdrOf(ctx), gitOf(ctx), ctx.registry).launch({
    projectId: 'project-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 800,
  });
  assert.equal(result[0].ready, false);
  assert.ok(result[0].generationId, 'identidade da reserva não pode ser perdida no erro');
  assert.match(result[0].error ?? '', /tab recusada/);
  const state = await ctx.store.read();
  const generation = state.sessions.find(s => s.generationId === result[0].generationId);
  assert.equal(generation?.status, 'unknown', 'falha externa não deixa launching órfão');
  assert.ok(state.events.some(e => e.kind === 'launch-failed' && e.detail === result[0].generationId));
});

test('nome do agente Herdr derivado de UUID respeita o contrato de 32 caracteres', async () => {
  const projectId = '689a7b21-6576-4eff-892a-57ad1a82ea5d';
  const ctx = await setup((_exe, args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'workspace' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'w-1' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'tab' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'tab-1', paneId: 'pane-1' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'agent' && args[1] === 'start') return { exitCode: 1, stdout: '', stderr: 'probe', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  }, projectId);
  await new TeamLauncher(herdrOf(ctx), gitOf(ctx), ctx.registry).launch({ projectId, projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 500 });
  const name = ctx.calls.find(c => c.args[0] === 'agent' && c.args[1] === 'start')?.args[2] ?? '';
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(name.length <= 32, `nome com ${name.length} caracteres: ${name}`);
  assert.match(name, /-reviewer$/);
});

test('bootstrap controlado registra UUID real quando o hook SessionStart não chegou', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555599';
  const ctx = await setup((_exe, args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'workspace' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'w-1' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'tab' && args[1] === 'create') return { exitCode: 0, stdout: JSON.stringify({ id: 'tab-1', paneId: 'pane-9' }), stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'agent' && args[1] === 'get') return {
      exitCode: 0,
      stdout: JSON.stringify({ id: 'cli:agent:get', result: { agent: { name: args[2], pane_id: 'pane-9', agent_session: { value: sessionId } } } }),
      stderr: '', timedOut: false, acceptedBeforeTimeout: false,
    };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
  const result = await new TeamLauncher(herdrOf(ctx), gitOf(ctx), ctx.registry).launch({
    projectId: 'project-a', projectRoot: ctx.root, roles: ['planner'],
    registrationTimeoutMs: 6000, bootstrapRegistration: true,
  });
  assert.equal(result[0].ready, true, result[0].error);
  const state = await ctx.store.read();
  assert.equal(state.sessions[0].threadId, sessionId);
  assert.ok(ctx.calls.some(c => c.args[0] === 'pane' && c.args[1] === 'send-text'));
  assert.ok(ctx.calls.some(c => c.args[0] === 'pane' && c.args[1] === 'send-keys' && c.args.at(-1) === 'Enter'));
});
