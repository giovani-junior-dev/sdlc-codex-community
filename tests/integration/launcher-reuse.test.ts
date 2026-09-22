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
const FAIL = (stderr: string): ProcessResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false, acceptedBeforeTimeout: false });

interface Ctx {
  root: string; store: StateStore; registry: SessionRegistry;
  herdrCalls: string[][]; gitCalls: string[][];
  herdr: HerdrProcessAdapter; git: GitAdapter;
}

async function setup(projectId: string, herdrHandler: (args: string[]) => ProcessResult, prefix = 'sdlc-b-reuse-'): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId });
  await store.init(projectId);
  const herdrCalls: string[][] = [];
  const gitCalls: string[][] = [];
  const herdr = new HerdrProcessAdapter(new FakeProcessRunner((_e, args) => { herdrCalls.push(args); return herdrHandler(args); }));
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => { gitCalls.push(args); return OK(); }));
  return { root, store, registry: new SessionRegistry(store), herdrCalls, gitCalls, herdr, git };
}

const launcherFor = (ctx: Ctx) => new TeamLauncher(ctx.herdr, ctx.git, ctx.registry);

function baseHerdr(): (args: string[]) => ProcessResult {
  return (args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return OK('[]');
    if (args[0] === 'workspace' && args[1] === 'create') return OK(JSON.stringify({ id: 'w-1' }));
    if (args[0] === 'tab' && args[1] === 'create') return OK(JSON.stringify({ id: 'tab-1', paneId: 'pane-novo' }));
    if (args[0] === 'pane' && args[1] === 'list') return OK('[]');
    if (args[0] === 'agent' && args[1] === 'start') return OK('started');
    if (args[0] === 'agent' && args[1] === 'wait') return OK('');
    if (args[0] === 'agent' && args[1] === 'list') return OK('[]');
    return OK();
  };
}

/** Inventário que CORROBORA a sessão registrada: agente codex no pane, pane no workspace registrado. */
function corroboratingHerdr(): (args: string[]) => ProcessResult {
  return (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return OK(JSON.stringify([{ name: 'agente', paneId: 'pane-ok', kind: 'codex' }]));
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'pane-ok', workspaceId: 'w-1' }]));
    return baseHerdr()(args);
  };
}

async function putReadySession(ctx: Ctx, session: Partial<SessionRecord> & { role: Role; cwd: string; paneId: string; generationId: string }): Promise<void> {
  await ctx.store.mutate(s => ({
    state: {
      ...s,
      sessions: [{
        threadId: `thread-${session.generationId}`, projectId: s.projectId,
        status: 'ready', lastEventAt: new Date().toISOString(), workspaceId: 'w-1', ...session,
      } as SessionRecord],
    },
    result: undefined,
  }));
}

function assertZeroCreation(ctx: Ctx): void {
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'tab' && c[1] === 'create'), 'nenhuma tab criada');
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'agent' && c[1] === 'start'), 'nenhum agente lançado');
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'workspace' && c[1] === 'create'), 'nenhum workspace criado');
  assert.equal(ctx.gitCalls.length, 0, 'nenhum efeito Git');
}

// R4-15: reuso saudável — agente no MESMO pane + pane no MESMO workspace + cwd relevante.
test('reuso saudável corroborado pelo inventário não cria nada', async () => {
  const ctx = await setup('proj-a', corroboratingHerdr());
  await putReadySession(ctx, { role: 'planner', cwd: ctx.root, paneId: 'pane-ok', generationId: 'gen-ok' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(result[0].ready, true);
  assert.equal(result[0].reused, true);
  assert.equal(result[0].generationId, 'gen-ok');
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'workspace' && c[1] === 'create'), 'reuso puro: workspace lazy, zero criação');
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'tab' && c[1] === 'create'), 'reuso puro: nenhuma tab');
  assert.ok(!ctx.herdrCalls.some(c => c[0] === 'agent' && c[1] === 'start'), 'reuso puro: nenhum agente');
});

// R4-15: cwd é normalizado na correlação (case/separadores Windows): reuso preservado.
test('reuso preserva cwd com case/separadores diferentes (normalização Windows)', async () => {
  const ctx = await setup('proj-a', corroboratingHerdr());
  const variant = (ctx.root.replace(/\//g, '\\') + '\\').replace(/^([A-Za-z]):/, (m) => m.toUpperCase());
  await putReadySession(ctx, { role: 'planner', cwd: variant, paneId: 'pane-ok', generationId: 'gen-ok' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(result[0].reused, true, 'cwd normalizado casa com a raiz principal');
});

// R4-15: pane que aparece em OUTRO workspace não comprova liveness => unknown + zero criação.
test('pane de outro workspace é ambiguidade: unknown sem criar nada', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return OK(JSON.stringify([{ name: 'agente', paneId: 'pane-ok', kind: 'codex' }]));
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'pane-ok', workspaceId: 'w-OUTRO' }]));
    return baseHerdr()(args);
  });
  await putReadySession(ctx, { role: 'planner', cwd: ctx.root, paneId: 'pane-ok', generationId: 'gen-ok', workspaceId: 'w-1' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /unknown|workspace/);
  const state = await ctx.store.read();
  assert.equal(state.sessions.find(s => s.generationId === 'gen-ok')?.status, 'unknown');
  assertZeroCreation(ctx);
});

// R4-15: pane duplicado no inventário = ambíguo => unknown + zero criação.
test('pane duplicado no inventário é ambiguidade: unknown sem criar nada', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return OK(JSON.stringify([{ name: 'agente', paneId: 'pane-ok', kind: 'codex' }]));
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'pane-ok', workspaceId: 'w-1' }, { id: 'pane-ok', workspaceId: 'w-1' }]));
    return baseHerdr()(args);
  });
  await putReadySession(ctx, { role: 'planner', cwd: ctx.root, paneId: 'pane-ok', generationId: 'gen-ok', workspaceId: 'w-1' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /unknown|ambígu/);
  assert.equal((await ctx.store.read()).sessions.find(s => s.generationId === 'gen-ok')?.status, 'unknown');
  assertZeroCreation(ctx);
});

// R4-15: múltiplos agentes codex no mesmo pane = ambíguo => unknown + zero criação.
test('múltiplos agentes no pane são ambiguidade: unknown sem criar nada', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') {
      return OK(JSON.stringify([{ name: 'a1', paneId: 'pane-ok', kind: 'codex' }, { name: 'a2', paneId: 'pane-ok', kind: 'codex' }]));
    }
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'pane-ok', workspaceId: 'w-1' }]));
    return baseHerdr()(args);
  });
  await putReadySession(ctx, { role: 'planner', cwd: ctx.root, paneId: 'pane-ok', generationId: 'gen-ok', workspaceId: 'w-1' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /unknown|ambígu/);
  assertZeroCreation(ctx);
});

// R4-15: sessão ready sem paneId não pode ser correlacionada => unknown + zero criação.
test('sessão ready sem paneId é ambiguidade: unknown sem criar nada', async () => {
  const ctx = await setup('proj-a', corroboratingHerdr());
  await ctx.store.mutate(s => ({
    state: {
      ...s,
      sessions: [{
        role: 'planner', threadId: 'thread-x', projectId: s.projectId, cwd: ctx.root,
        status: 'ready', lastEventAt: new Date().toISOString(), generationId: 'gen-ok', workspaceId: 'w-1',
      } as SessionRecord],
    },
    result: undefined,
  }));
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 600 });
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /unknown|paneId/);
  assert.equal((await ctx.store.read()).sessions.find(s => s.generationId === 'gen-ok')?.status, 'unknown');
  assertZeroCreation(ctx);
});

// R4-15: pane MORTO (inventário disponível e vazio para o pane) é evidência de
// morte — nova geração é justificada (distinto de inventário indisponível).
test('pane sem agente no inventário é evidência de morte: nova geração justificada', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return OK('[]');
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'pane-ok', workspaceId: 'w-1' }]));
    return baseHerdr()(args);
  });
  await putReadySession(ctx, { role: 'planner', cwd: ctx.root, paneId: 'pane-ok', generationId: 'gen-morta', workspaceId: 'w-1' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 700 });
  assert.notEqual(result[0].reused, true);
  assert.ok(ctx.herdrCalls.some(c => c[0] === 'tab' && c[1] === 'create'), 'nova aba para a geração substituta');
  const state = await ctx.store.read();
  assert.ok(state.sessions.some(s => s.generationId !== 'gen-morta'), 'geração substituta lançada');
  assert.equal(state.sessions.find(s => s.generationId === 'gen-morta')?.status, 'ready', 'morte comprovada não rebaixa a antiga');
});

// R4-15: agente de kind diferente no pane (não-codex) não comprova a sessão codex registrada.
test('agente não-codex no pane não comprova liveness da sessão codex', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return OK(JSON.stringify([{ name: 'shell', paneId: 'pane-ok', kind: 'shell' }]));
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'pane-ok', workspaceId: 'w-1' }]));
    return baseHerdr()(args);
  });
  await putReadySession(ctx, { role: 'planner', cwd: ctx.root, paneId: 'pane-ok', generationId: 'gen-codex', workspaceId: 'w-1' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 700 });
  assert.notEqual(result[0].reused, true);
  assert.ok(ctx.herdrCalls.some(c => c[0] === 'tab' && c[1] === 'create'));
});

// R4-15: cwd irrelevante para o papel (não-dev fora da raiz principal) => nova geração.
test('sessão ready com cwd fora da raiz não é reutilizada para o papel', async () => {
  const ctx = await setup('proj-a', corroboratingHerdr());
  await putReadySession(ctx, { role: 'planner', cwd: 'C:\\outro\\lugar', paneId: 'pane-ok', generationId: 'gen-fora', workspaceId: 'w-1' });
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner'], registrationTimeoutMs: 700 });
  assert.notEqual(result[0].reused, true);
  assert.ok(ctx.herdrCalls.some(c => c[0] === 'tab' && c[1] === 'create'), 'cwd divergente exige nova geração');
});

// R4-15: dois projetos com o mesmo slug/nome não se reutilizam — identidade é o
// projectId (UUID): agentes/tabs são nomeados por ele e o estado é isolado.
test('dois projetos mesmo slug: identidade por projectId, sem reuso cruzado', async () => {
  const ctxA = await setup('projeto-uuid-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return OK(JSON.stringify([{ name: 'demanda-1-planner', paneId: 'pane-a', kind: 'codex' }]));
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'pane-a', workspaceId: 'w-a' }]));
    return baseHerdr()(args);
  });
  const ctxB = await setup('projeto-uuid-b', (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return OK(JSON.stringify([{ name: 'demanda-1-planner', paneId: 'pane-a', kind: 'codex' }]));
    if (args[0] === 'pane' && args[1] === 'list') return OK(JSON.stringify([{ id: 'pane-a', workspaceId: 'w-a' }]));
    return baseHerdr()(args);
  });
  // Mesmo slug de demanda e nome de agente idêntico no inventário compartilhado.
  await putReadySession(ctxA, { role: 'planner', cwd: ctxA.root, paneId: 'pane-a', generationId: 'gen-a', workspaceId: 'w-a' });
  const resultB = await launcherFor(ctxB).launch({ projectId: 'projeto-uuid-b', projectRoot: ctxB.root, roles: ['planner'], demand: 'demanda-1', registrationTimeoutMs: 700 });
  assert.notEqual(resultB[0].reused, true, 'projeto B não reutiliza a sessão de A');
  const start = ctxB.herdrCalls.find(c => c[0] === 'agent' && c[1] === 'start')!;
  assert.match(start[2], /^sdlc-[a-f0-9]{16}-planner$/, 'agente nomeado por chave estável derivada do projectId de B');
  assert.ok(start[2].length <= 32, 'nome respeita o limite do Herdr');
  // A intacto: ainda ready no estado de A.
  assert.equal((await ctxA.store.read()).sessions.find(s => s.generationId === 'gen-a')?.status, 'ready');
});

// R4-15: caminhos Windows com espaços e acentos atravessam o launcher como
// argumento único e são normalizados na correlação de cwd.
test('caminhos com espaços e acentos: argv intacto e reuso por normalização', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return OK('[]');
    if (args[0] === 'workspace' && args[1] === 'create') return OK(JSON.stringify({ id: 'w-1' }));
    if (args[0] === 'tab' && args[1] === 'create') return OK(JSON.stringify({ id: 'tab-1', paneId: 'pane-novo' }));
    if (args[0] === 'pane' && args[1] === 'list') return OK('[]');
    if (args[0] === 'agent' && args[1] === 'start') return OK('started');
    if (args[0] === 'agent' && args[1] === 'wait') return FAIL('nunca fica pronto');
    if (args[0] === 'agent' && args[1] === 'list') return OK('[]');
    return OK();
  }, 'sdlc código com espaços-');
  const worktree = join(ctx.root, '.sdlc-codex', 'worktrees', 'demanda áé');
  const gitCalls: string[][] = [];
  ctx.git = new GitAdapter(new FakeProcessRunner((_e, args) => {
    gitCalls.push(args);
    if (args[0] === 'worktree' && args[1] === 'list') return OK('');
    if (args[0] === 'show-ref') return FAIL('not found');
    return OK('');
  }));
  const result = await launcherFor(ctx).launch({
    projectId: 'proj-a', projectRoot: ctx.root, roles: ['dev'], demand: 'demanda áé',
    devWorktree: worktree, devBranch: 'sdlc/demanda-áé', gitBase: 'main', registrationTimeoutMs: 500,
  });
  assert.notEqual(result[0].ready, true, 'sem registro do hook não fica pronto');
  const tab = ctx.herdrCalls.find(c => c[0] === 'tab' && c[1] === 'create')!;
  assert.equal(tab[tab.indexOf('--cwd') + 1], worktree, 'cwd com espaços/acentos como argumento único');
  const start = ctx.herdrCalls.find(c => c[0] === 'agent' && c[1] === 'start')!;
  assert.equal(start[start.indexOf('-C') + 1], worktree, '-C com espaços/acentos como argumento único');
  const add = gitCalls.find(c => c[0] === 'worktree' && c[1] === 'add')!;
  assert.ok(add.includes(worktree) && add.includes('main'), 'worktree criado a partir da base com caminho intacto');
});
