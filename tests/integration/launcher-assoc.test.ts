import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { TeamLauncher } from '../../src/sessions/launcher.js';
import { HerdrProcessAdapter } from '../../src/adapters/herdr.js';
import { GitAdapter } from '../../src/adapters/git.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { ProcessResult } from '../../src/adapters/process.js';
import type { Role, SessionRecord } from '../../src/contracts.js';

const OK = (stdout = ''): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, acceptedBeforeTimeout: false });

interface Ctx {
  root: string; store: StateStore; registry: SessionRegistry;
  herdrCalls: string[][]; gitCalls: string[][];
  herdr: HerdrProcessAdapter; git: GitAdapter;
}

/** Herdr/Git mutável EXCLUSIVAMENTE falsos (runner falso; nenhum processo real). */
async function setup(
  projectId: string,
  herdrHandler: (args: string[]) => ProcessResult,
  gitHandler?: (args: string[]) => ProcessResult,
): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-b-launch-'));
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId });
  await store.init(projectId);
  const herdrCalls: string[][] = [];
  const gitCalls: string[][] = [];
  const herdr = new HerdrProcessAdapter(new FakeProcessRunner((_e, args) => { herdrCalls.push(args); return herdrHandler(args); }));
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => {
    gitCalls.push(args);
    return gitHandler ? gitHandler(args) : OK();
  }));
  return { root, store, registry: new SessionRegistry(store), herdrCalls, gitCalls, herdr, git };
}

const launcherFor = (ctx: Ctx) => new TeamLauncher(ctx.herdr, ctx.git, ctx.registry);

function baseHerdr(tabPaneId = 'pane-new'): (args: string[]) => ProcessResult {
  return (args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return OK('[]');
    if (args[0] === 'workspace' && args[1] === 'create') return OK(JSON.stringify({ id: 'w-1' }));
    if (args[0] === 'tab' && args[1] === 'create') return OK(JSON.stringify({ id: 'tab-1', paneId: tabPaneId }));
    if (args[0] === 'pane' && args[1] === 'list') return OK('[]');
    if (args[0] === 'agent' && args[1] === 'start') return OK('started');
    if (args[0] === 'agent' && args[1] === 'wait') return OK('');
    if (args[0] === 'agent' && args[1] === 'list') return OK('[]');
    return OK();
  };
}

async function putReadySession(ctx: Ctx, session: Partial<SessionRecord> & { role: Role; cwd: string; paneId: string; generationId: string }): Promise<void> {
  await ctx.store.mutate(s => ({
    state: {
      ...s,
      sessions: [{
        threadId: `thread-${session.paneId}`, projectId: s.projectId,
        status: 'ready', lastEventAt: new Date().toISOString(), ...session,
      } as SessionRecord],
    },
    result: undefined,
  }));
}

async function registerWhenLaunching(ctx: Ctx, role: Role, cwd: string): Promise<void> {
  const deadline = Date.now() + 6000;
  let lastError = 'nenhuma geração launching observada';
  while (Date.now() < deadline) {
    const state = await ctx.store.read();
    const launching = state.sessions.find(x => x.status === 'launching' && x.role === role && x.launchToken);
    if (launching) {
      try {
        await ctx.registry.register({ event: 'SessionStart', session_id: `thread-${launching.generationId}`, cwd, project_id: launching.projectId, role, token: launching.launchToken });
        return;
      } catch (error) {
        // EPERM transitório de rename concorrente no Windows: tenta de novo (o último erro fica no diagnóstico).
        lastError = (error as Error).message;
      }
    }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`registro da sessão de teste não concluído no prazo (último estado: ${lastError})`);
}

// C07: nome SEMELHANTE de outro projeto/pane não é prova de identidade.
test('projeto com nome semelhante não reutiliza sessão de outro projeto', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') {
      // Agente de nome parecido, mas em pane DIFERENTE do registrado.
      return OK(JSON.stringify([{ name: 'proj-a-dev', paneId: 'pane-x', kind: 'codex' }]));
    }
    return baseHerdr('pane-novo')(args);
  });
  await putReadySession(ctx, { role: 'dev', cwd: 'C:\\wt-b', paneId: 'pane-b', generationId: 'gen-b' });
  const launcher = launcherFor(ctx);
  const gitNoBranch: (args: string[]) => ProcessResult = (args) =>
    args[0] === 'show-ref'
      ? { exitCode: 1, stdout: '', stderr: 'not found', timedOut: false, acceptedBeforeTimeout: false }
      : OK('');
  const ctxWithGit: Ctx = { ...ctx, git: new GitAdapter(new FakeProcessRunner((_e, args) => { ctx.gitCalls.push(args); return gitNoBranch(args); })) };
  const result = await launcherFor(ctxWithGit).launch({
    projectId: 'proj-a', projectRoot: ctx.root, roles: ['dev'], demand: 'd1',
    devWorktree: join(ctx.root, 'wt-a'), devBranch: 'sdlc/d1', gitBase: 'main', registrationTimeoutMs: 600,
  });
  assert.notEqual(result[0].reused, true, 'pane diferente não é reutilização');
  assert.ok(ctx.herdrCalls.some(c => c[0] === 'tab' && c[1] === 'create'), 'nova tab criada em vez de reuso às cegas');
  const start = ctx.herdrCalls.find(c => c[0] === 'agent' && c[1] === 'start')!;
  assert.equal(start[start.indexOf('--pane') + 1], 'pane-novo');
});

// R4-15: inventário INDISPONÍVEL = "não sei" => estado unknown + diagnóstico,
// ZERO criação (nenhuma tab/agente/workspace novo) e NUNCA relançamento automático.
test('inventário indisponível marca a geração unknown sem criar nada', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return { exitCode: 1, stdout: '', stderr: 'herdr fora do ar', timedOut: false, acceptedBeforeTimeout: false };
    return baseHerdr()(args);
  });
  await putReadySession(ctx, { role: 'planner', cwd: ctx.root, paneId: 'pane-ok', generationId: 'gen-1', workspaceId: 'w-1' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(result[0].ready, false);
  assert.notEqual(result[0].reused, true);
  assert.match(result[0].error ?? '', /inventário|unknown/);
  // Estado persistido: a geração registrada foi rebaixada a 'unknown'.
  const state = await ctx.store.read();
  const session = state.sessions.find(s => s.generationId === 'gen-1')!;
  assert.equal(session.status, 'unknown');
  // ZERO efeito: sem tab nova, sem agent start, sem workspace create.
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'tab' && c[1] === 'create'), 'nenhuma tab criada');
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'agent' && c[1] === 'start'), 'nenhum agente lançado');
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'workspace' && c[1] === 'create'), 'nenhum workspace criado');
  assert.equal(ctx.gitCalls.length, 0, 'nenhum efeito Git');
});

// C07: registro SEM readiness não é sessão pronta.
test('registro sem readiness vira parcial', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'wait') return { exitCode: 1, stdout: '', stderr: 'timeout', timedOut: false, acceptedBeforeTimeout: false };
    return baseHerdr()(args);
  });
  const launchPromise = launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 8000 });
  await registerWhenLaunching(ctx, 'reviewer', ctx.root);
  const result = await launchPromise;
  assert.equal(result[0].ready, false, 'readiness é obrigatório junto do registro');
  assert.match(result[0].error ?? '', /readiness/);
});

// C07: readiness SEM registro não é sessão pronta (caminho feliz do partial).
test('readiness sem registro vira parcial', async () => {
  const ctx = await setup('proj-a', baseHerdr());
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 600 });
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /SessionStart|parcial/);
});

// C07: dev NÃO é reutilizado para demanda/worktree incompatíveis.
test('dev com cwd incompatível não é reutilizado e worktree novo é preparado', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return OK(JSON.stringify([{ name: 'proj-a-dev', paneId: 'pane-old', kind: 'codex' }]));
    return baseHerdr()(args);
  }, (args) => {
    if (args[0] === 'worktree' && args[1] === 'list') return OK('');
    if (args[0] === 'show-ref') return { exitCode: 1, stdout: '', stderr: 'not found', timedOut: false, acceptedBeforeTimeout: false };
    return OK('');
  });
  await putReadySession(ctx, { role: 'dev', cwd: 'C:\\wt-antiga', paneId: 'pane-old', generationId: 'gen-old' });
  const newWorktree = join(ctx.root, '.sdlc-codex', 'worktrees', 'demanda-x');
  const result = await launcherFor(ctx).launch({
    projectId: 'proj-a', projectRoot: ctx.root, roles: ['dev'], demand: 'demanda-x',
    devWorktree: newWorktree, devBranch: 'sdlc/demanda-x', gitBase: 'main', registrationTimeoutMs: 600,
  });
  assert.notEqual(result[0].reused, true);
  const add = ctx.gitCalls.find(c => c[0] === 'worktree' && c[1] === 'add')!;
  assert.ok(add, 'worktree novo criado a partir da base');
  assert.ok(add.includes(newWorktree) && add.includes('main'));
});

// C07: pane determinístico mesmo com panes fora de ordem e workspaces misturados.
test('pane da tab é escolhido por correlação exata, não por última pane global', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'tab' && args[1] === 'create') return OK(JSON.stringify({ id: 'tab-1', paneId: 'pane-correta' }));
    if (args[0] === 'pane' && args[1] === 'list') {
      return OK(JSON.stringify([
        { id: 'pane-3', workspaceId: 'w-1' },
        { id: 'pane-1', workspaceId: 'w-outro' },
        { id: 'pane-2', workspaceId: 'w-1' },
      ]));
    }
    return baseHerdr()(args);
  });
  const launchPromise = launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 8000 });
  await registerWhenLaunching(ctx, 'planner', ctx.root);
  const result = await launchPromise;
  assert.equal(result[0].ready, true);
  const start = ctx.herdrCalls.find(c => c[0] === 'agent' && c[1] === 'start')!;
  assert.equal(start[start.indexOf('--pane') + 1], 'pane-correta', 'pane do contrato da tab, não a última pane listada');
});

// C07: pane ambíguo (sem paneId na tab e múltiplos panes no workspace) é diagnóstico.
test('pane ambíguo é recusado com diagnóstico', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'tab' && args[1] === 'create') return OK(JSON.stringify({ id: 'tab-1' }));
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'p1', workspaceId: 'w-1' }, { id: 'p2', workspaceId: 'w-1' }]));
    return baseHerdr()(args);
  });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /determín|determin|adivinhar/);
});

// C07: configuração por papel (modelo + esforço) chega aos argumentos do Codex.
test('modelo e esforço por papel são encaminhados aos argumentos do agente', async () => {
  const ctx = await setup('proj-a', baseHerdr());
  const launchPromise = launcherFor(ctx).launch({
    projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 8000,
    modelByRole: { planner: { model: 'modelo-x', effort: 'high' } },
  });
  await registerWhenLaunching(ctx, 'planner', ctx.root);
  const result = await launchPromise;
  assert.equal(result[0].ready, true);
  const start = ctx.herdrCalls.find(c => c[0] === 'agent' && c[1] === 'start')!;
  const dashdash = start.indexOf('--');
  const agentArgs = start.slice(dashdash + 1);
  const idxM = agentArgs.indexOf('-m');
  assert.equal(agentArgs[idxM + 1], 'modelo-x');
  const idxC = agentArgs.indexOf('-c');
  assert.equal(agentArgs[idxC + 1], 'model_reasoning_effort=high');
  const idxCwd = agentArgs.indexOf('-C');
  assert.equal(agentArgs[idxCwd + 1], ctx.root);
  // Espera do agente endereçada pelo nome exato do agente.
  const wait = ctx.herdrCalls.find(c => c[0] === 'agent' && c[1] === 'wait')!;
  assert.match(wait[2], /^sdlc-[a-f0-9]{16}-planner$/);
  assert.ok(wait[2].length <= 32, 'nome respeita o limite do Herdr');
});
