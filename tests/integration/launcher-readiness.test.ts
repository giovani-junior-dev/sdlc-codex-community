import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { writeApproval } from './flow-fixtures.js';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { TeamLauncher } from '../../src/sessions/launcher.js';
import { HerdrProcessAdapter } from '../../src/adapters/herdr.js';
import { GitAdapter } from '../../src/adapters/git.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { ProcessResult } from '../../src/adapters/process.js';
import type { Role } from '../../src/contracts.js';

const OK = (stdout = ''): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, acceptedBeforeTimeout: false });

interface Ctx {
  root: string; store: StateStore; registry: SessionRegistry;
  herdrCalls: string[][]; gitCalls: string[][];
  herdr: HerdrProcessAdapter; git: GitAdapter;
}

/** Herdr/Git EXCLUSIVAMENTE falsos (runner falso; nenhum processo real). */
async function setup(projectId: string, herdrHandler: (args: string[]) => ProcessResult): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-b-ready-'));
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId });
  await store.init(projectId);
  const herdrCalls: string[][] = [];
  const gitCalls: string[][] = [];
  const herdr = new HerdrProcessAdapter(new FakeProcessRunner((_e, args) => { herdrCalls.push(args); return herdrHandler(args); }));
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => { gitCalls.push(args); return OK(); }));
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

async function registerWhenLaunching(
  ctx: Ctx,
  role: Role,
  cwd: string,
  launch: Promise<unknown>,
): Promise<void> {
  let settled = false;
  let lastError: unknown;
  void launch.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    const state = await ctx.store.read();
    const launching = state.sessions.find(x => x.status === 'launching' && x.role === role && x.launchToken);
    if (launching) {
      try {
        await ctx.registry.register({ event: 'SessionStart', session_id: `thread-${launching.generationId}`, cwd, project_id: launching.projectId, role, token: launching.launchToken });
        return;
      } catch (error) {
        // EPERM transitório de rename concorrente no Windows: tenta de novo.
        lastError = error;
      }
    }
    await new Promise(r => setTimeout(r, 25));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`lançamento terminou antes de o registro da sessão de teste ser concluído${detail}`);
}

// R4-11 (regressão do bug real): o timeout recebia generationId mas a API de
// evento comparava threadId — a geração lançada NUNCA era marcada unknown.
test('R4-11: timeout marca EXATAMENTE a geração lançada como unknown', async () => {
  const ctx = await setup('proj-a', baseHerdr());
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 700 });
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /SessionStart|parcial/);
  const state = await ctx.store.read();
  const session = state.sessions.find(s => s.generationId === result[0].generationId)!;
  assert.equal(session.status, 'unknown', 'geração lançada persistida como unknown');
  assert.ok(!state.sessions.some(s => s.status === 'ready'), 'nenhuma ready espúria');
  // Auditoria endereçada pela GERAÇÃO (não por threadId inexistente).
  assert.ok(state.events.some(e => e.kind === 'session-unknown' && e.detail === result[0].generationId));
});

// M5-F1: hook registrado (SessionStart) + Herdr sem readiness => timeout e unknown.
test('hook registrado sem readiness persiste unknown ao fim do prazo', async () => {
  const ctx = await setup('proj-a', (args) => {
    if (args[0] === 'agent' && args[1] === 'wait') return { exitCode: 1, stdout: '', stderr: 'timeout', timedOut: false, acceptedBeforeTimeout: false };
    return baseHerdr()(args);
  });
  const launchPromise = launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 8000 });
  await registerWhenLaunching(ctx, 'reviewer', ctx.root, launchPromise);
  const result = await launchPromise;
  assert.equal(result[0].ready, false);
  assert.match(result[0].error ?? '', /readiness/);
  const state = await ctx.store.read();
  assert.equal(state.sessions.find(s => s.generationId === result[0].generationId)?.status, 'unknown');
});

// M5-F1: readiness Herdr + hook ausente => timeout e unknown (janela fechada para start).
test('readiness sem registro do hook persiste unknown ao fim do prazo', async () => {
  const ctx = await setup('proj-a', baseHerdr());
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 700 });
  assert.equal(result[0].ready, false);
  const state = await ctx.store.read();
  assert.equal(state.sessions.find(s => s.generationId === result[0].generationId)?.status, 'unknown');
});

// M5-F1: o deadline é respeitado (não devolve cedo nem trava).
test('deadline do lançamento é respeitado', async () => {
  const ctx = await setup('proj-a', baseHerdr());
  const t0 = Date.now();
  const result = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 800 });
  const elapsed = Date.now() - t0;
  assert.equal(result[0].ready, false);
  assert.ok(elapsed >= 750, `esperou o prazo (${elapsed}ms)`);
  assert.ok(elapsed < 10_000, `não travou (${elapsed}ms)`);
});

// M5-F1: hook ATRASADO (após o timeout) não cria nem promove sessão alguma.
test('hook atrasado após timeout é recusado sem criar sessão', async () => {
  const ctx = await setup('proj-a', baseHerdr());
  // O prazo é folgado para a carga paralela da suíte; o teste é sobre o hook
  // ATRASADO, não sobre um deadline curto (coberto no teste anterior).
  // A captura do token termina quando o token aparece OU o lançamento encerra — nunca por um limite arbitrário.
  const launchPromise = launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 8000 });
  let settled = false;
  void launchPromise.then(() => { settled = true; }, () => { settled = true; });
  let token: string | undefined;
  while (!token && !settled) {
    const state = await ctx.store.read();
    token = state.sessions.find(s => s.role === 'reviewer' && s.status === 'launching')?.launchToken;
    if (!token) await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(token, 'lançamento em flight capturado');
  const result = await launchPromise;
  assert.equal(result[0].ready, false);
  await assert.rejects(
    () => ctx.registry.register({ event: 'SessionStart', session_id: 'thread-atrasado', cwd: ctx.root, project_id: 'proj-a', role: 'reviewer', token }),
    /não corresponde|recusado/);
  const state = await ctx.store.read();
  assert.equal(state.sessions.length, 1, 'nenhuma sessão criada pelo hook atrasado');
  assert.equal(state.sessions[0].status, 'unknown');
  assert.equal(state.sessions[0].threadId, undefined);
});

// M5-F1: geração NOVA pronta enquanto a ANTIGA expira — a expiração não rebaixa a substituta.
test('expiração da geração antiga nunca rebaixa a geração substituta pronta', async () => {
  const ctx = await setup('proj-a', baseHerdr());
  // Geração A expira sem hook.
  const failed = await launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 600 });
  assert.equal(failed[0].ready, false);
  const genA = failed[0].generationId;
  // Geração B lançada em seguida e confirmada (hook + readiness).
  const launchB = launcherFor(ctx).launch({ projectId: 'proj-a', projectRoot: ctx.root, roles: ['reviewer'], registrationTimeoutMs: 8000 });
  await registerWhenLaunching(ctx, 'reviewer', ctx.root, launchB);
  const succeeded = await launchB;
  assert.equal(succeeded[0].ready, true);
  const genB = succeeded[0].generationId;
  assert.notEqual(genA, genB);
  // Reemissão do timeout da geração antiga (corrida): substituta intacta.
  await ctx.registry.eventByGeneration(genA, 'unknown');
  const state = await ctx.store.read();
  // R5-10/M5-F2: o launcher lançou B com PROVA de ausência de A (pane sem agente no inventário),
  // então a unknown A fecha na promoção de B (substituição confirmada); antes ficava 'unknown' para sempre.
  assert.equal(state.sessions.find(s => s.generationId === genA)?.status, 'closed');
  assert.equal(state.sessions.find(s => s.generationId === genB)?.status, 'ready', 'geração substituta não rebaixada');
});

// M5-F1: time parcial — participante saudável preservado, falho persistido unknown.
test('time parcial: saudável preservado e falho unknown, sem kickoff do launcher', async () => {
  const ctx = await setup('proj-a', baseHerdr());
  const launchPromise = launcherFor(ctx).launch({
    projectId: 'proj-a', projectRoot: ctx.root, roles: ['planner', 'reviewer'], registrationTimeoutMs: 8000,
  });
  await registerWhenLaunching(ctx, 'planner', ctx.root, launchPromise);
  const result = await launchPromise;
  const planner = result.find(r => r.role === 'planner')!;
  const reviewer = result.find(r => r.role === 'reviewer')!;
  assert.equal(planner.ready, true);
  assert.equal(reviewer.ready, false);
  const state = await ctx.store.read();
  assert.equal(state.sessions.find(s => s.role === 'planner')?.status, 'ready', 'saudável preservado');
  assert.equal(state.sessions.find(s => s.role === 'reviewer')?.status, 'unknown');
});

// M5-F1: start durante o lançamento — sessão com hook registrado mas ainda sem
// confirmação de readiness (status 'launching') NÃO é elegível: falha sem mutar
// pipeline e sem despachar kickoff (zero mensagens/entregas).
test('start recusa sessão em lançamento e não muta pipeline nem despacha kickoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-b-start-'));
  const projectId = '11111111-2222-3333-4444-555555555511';
  await mkdir(join(root, '.sdlc-codex'), { recursive: true });
  await writeFile(join(root, '.sdlc-codex', 'config.json'), JSON.stringify({
    schemaVersion: 1, projectId, projectName: 'Parcial', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'],
  }));
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId });
  await store.init(projectId);
  // Hooks SessionStart já observados (threadId), mas o launcher ainda não confirmou readiness.
  await store.mutate(s => ({
    state: {
      ...s,
      sessions: [{
        role: 'reviewer', threadId: 'thread-lancando-rev', generationId: 'gen-lancando-rev', projectId,
        cwd: root, status: 'launching' as const, lastEventAt: new Date().toISOString(), launchToken: 'tok-rev',
      }],
    },
    result: undefined,
  }));
  await store.mutate(s => ({
    state: {
      ...s,
      sessions: [...s.sessions, {
        role: 'planner', threadId: 'thread-lancando', generationId: 'gen-lancando', projectId,
        cwd: root, status: 'launching' as const, lastEventAt: new Date().toISOString(), launchToken: 'tok',
      }],
    },
    result: undefined,
  }));
  // R5-05: a aprovação exige manifesto de requisitos; sem ele o start falharia por OUTRO motivo
  // e o teste deixaria de provar a recusa por readiness (nem o controle positivo passaria).
  await writeApproval(root, { entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }] });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ['start', 'demanda-x', '--intent', 'intent.md', '--plan', 'plan.md', '--approval', 'approval.json',
      '--workflow', 'review-only', '--project', root, '--json'],
    { stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) },
    { runner: new FakeProcessRunner(() => OK()) });
  assert.notEqual(code, 0, `start deve falhar (stderr: ${err.join(' ')})`);
  const after = await store.read();
  assert.equal(after.runs.length, 0, 'pipeline não mutado');
  assert.equal(after.messages.length, 0, 'zero kickoff');
  assert.equal(after.deliveries.length, 0, 'zero entregas');
  // E o control: após confirmação de readiness pelo launcher, as MESMAS sessões viram elegíveis.
  const registry = new SessionRegistry(store);
  await registry.confirmReady('gen-lancando');
  await registry.confirmReady('gen-lancando-rev');
  const out2: string[] = [];
  const code2 = await runCli(
    ['start', 'demanda-x', '--intent', 'intent.md', '--plan', 'plan.md', '--approval', 'approval.json',
      '--workflow', 'review-only', '--project', root, '--json'],
    { stdout: (v: string) => out2.push(v), stderr: (v: string) => err.push(v) },
    { runner: new FakeProcessRunner(() => OK()) });
  assert.equal(code2, 0, `start aceita após confirmação de readiness (stderr: ${err.join(' ')})`);
  const finalState = await store.read();
  assert.equal(finalState.runs.length, 1);
  assert.ok(finalState.messages.length > 0, 'kickoff despachado só após confirmação');
});
