import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateLiveEnv, validateUpResult, isPathWithin, LiveEvidence,
  runLivePilot, LiveGuardError, MANUAL_STEPS, FUTURE_LIVE, FEATURE_TEAM_ROLES,
} from '../live/harness.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';

/**
 * C13/S14 + R4-16 — guardas e mecanismo do harness live testados com FALSOS na
 * suíte padrão. Nenhum efeito externo: as sondas de versão usam runner falso e
 * os alvos são diretórios temporários criados pelo próprio teste. SDLC_LIVE=1
 * NUNCA é definido aqui — o piloto real fica em tests/live com opt-in.
 */
function okProbes() {
  return new FakeProcessRunner((executable, args) => {
    const base = { stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (executable === 'codex' && args[0] === '--version') return { ...base, exitCode: 0, stdout: 'codex-cli 0.155.0\n' };
    if (executable === 'herdr' && args[0] === '--version') return { ...base, exitCode: 0, stdout: '0.7.5\n' };
    return { ...base, exitCode: 1, stdout: '' };
  });
}

async function disposableTarget(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'sdlc-live-'));
  await writeFile(join(target, '.sdlc-live-fixture'), 'descartavel');
  return target;
}

/** realpath sem o prefixo estendido \\\\?\\ que o Windows pode devolver. */
async function realpathNoPrefix(p: string): Promise<string> {
  const rp = await import('node:fs/promises').then(fs => fs.realpath(p));
  return rp.startsWith('\\\\?\\') ? rp.slice(4) : rp;
}

// ---------- guarda de opt-in (antes de qualquer efeito) ----------

test('guarda: sem SDLC_LIVE=1 recusa antes de qualquer efeito', async () => {
  await assert.rejects(() => validateLiveEnv({ live: undefined, target: undefined, expectedTmpPrefix: tmpdir() }, { runner: okProbes() }), /SDLC_LIVE=1/);
  await assert.rejects(() => validateLiveEnv({ live: '0', target: undefined, expectedTmpPrefix: tmpdir() }, { runner: okProbes() }), /SDLC_LIVE=1/);
});

// ---------- R4-16: canonicalização e pertencimento por componentes ----------

test('guarda: alvo com .. que escapa do temporário é recusado', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-live-'));
  const inside = join(root, 'sub');
  await mkdir(inside, { recursive: true });
  await writeFile(join(root, '.sdlc-live-fixture'), 'x');
  // 'sub/..' canonicaliza para a própria raiz (permanece dentro) — aceito.
  const ok = await validateLiveEnv({ live: '1', target: join(inside, '..'), expectedTmpPrefix: root }, { runner: okProbes() });
  assert.equal(ok.target, await realpathNoPrefix(root));
  // 'sub/../..' escapa da raiz — recusado mesmo existindo o marcador na raiz.
  await assert.rejects(
    () => validateLiveEnv({ live: '1', target: join(inside, '..', '..', 'fora-sdlc-live'), expectedTmpPrefix: root }, { runner: okProbes() }),
    /fora do diretório temporário/);
});

test('guarda: prefixo semelhante por componentes (sdlc-x vs sdlc-x-evil) é recusado', async () => {
  const fakePrefix = await mkdtemp(join(tmpdir(), 'sdlc-prefixo-'));
  const sibling = `${fakePrefix}-evil`;
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, '.sdlc-live-fixture'), 'x');
  await assert.rejects(
    () => validateLiveEnv({ live: '1', target: sibling, expectedTmpPrefix: fakePrefix }, { runner: okProbes() }),
    /fora do diretório temporário/);
});

test('guarda: marcador presente FORA da raiz não autoriza o alvo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-live-'));
  const outside = await mkdtemp(join(tmpdir(), 'sdlc-out-'));
  await writeFile(join(outside, '.sdlc-live-fixture'), 'x'); // marcador sozinho não basta
  await assert.rejects(
    () => validateLiveEnv({ live: '1', target: outside, expectedTmpPrefix: root }, { runner: okProbes() }),
    /fora do diretório temporário/);
});

test('guarda: junction/symlink dentro da raiz apontando para fora é recusado', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-live-'));
  const outside = await mkdtemp(join(tmpdir(), 'sdlc-out-'));
  await writeFile(join(outside, '.sdlc-live-fixture'), 'x');
  const link = join(root, 'link-externo');
  // 'junction' no Windows resolve o alvo real; em outros SOs, symlink de diretório.
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    () => validateLiveEnv({ live: '1', target: link, expectedTmpPrefix: root }, { runner: okProbes() }),
    /fora do diretório temporário/);
});

test('guarda: alvo ausente, fora do temporário ou sem marcador descartável é recusado', async () => {
  await assert.rejects(() => validateLiveEnv({ live: '1', target: undefined, expectedTmpPrefix: tmpdir() }, { runner: okProbes() }), /SDLC_LIVE_TARGET/);
  await assert.rejects(() => validateLiveEnv({ live: '1', target: 'C:/sistema-producao', expectedTmpPrefix: tmpdir() }, { runner: okProbes() }), /fora do diretório temporário/);
  await assert.rejects(() => validateLiveEnv({ live: '1', target: join(tmpdir(), 'inexistente-xyz'), expectedTmpPrefix: tmpdir() }, { runner: okProbes() }), /não existe/);
  const noMarker = await mkdtemp(join(tmpdir(), 'sdlc-live-'));
  await assert.rejects(() => validateLiveEnv({ live: '1', target: noMarker, expectedTmpPrefix: tmpdir() }, { runner: okProbes() }), /marcador/);
});

test('guarda: executáveis indisponíveis abortam antes do piloto', async () => {
  const target = await disposableTarget();
  const failing = new FakeProcessRunner(() => ({ exitCode: 1, stdout: '', stderr: 'não encontrado', timedOut: false, acceptedBeforeTimeout: false }));
  await assert.rejects(() => validateLiveEnv({ live: '1', target, expectedTmpPrefix: tmpdir() }, { runner: failing }), /codex indisponível/);
});

test('guarda: validação completa aceita alvo descartável com sondas ok (falsos)', async () => {
  const target = await disposableTarget();
  const validation = await validateLiveEnv({ live: '1', target, expectedTmpPrefix: tmpdir() }, { runner: okProbes() });
  assert.equal(validation.target, await realpathNoPrefix(target));
  assert.match(validation.codexVersion, /0\.155\.0/);
  assert.match(validation.herdrVersion, /0\.7\.5/);
});

test('unitário: isPathWithin compara por componentes, nunca por prefixo cru', () => {
  assert.equal(isPathWithin('C:/Temp/sdlc-x/alvo', 'C:/Temp/sdlc-x'), true);
  assert.equal(isPathWithin('C:/Temp/sdlc-x', 'C:/Temp/sdlc-x'), true);
  assert.equal(isPathWithin('C:/Temp/sdlc-x-evil/alvo', 'C:/Temp/sdlc-x'), false);
  assert.equal(isPathWithin('C:/Temp/sdlc-x/../fora', 'C:/Temp/sdlc-x'), false);
  assert.equal(isPathWithin('D:/Temp/sdlc-x/alvo', 'C:/Temp/sdlc-x'), false);
  assert.equal(isPathWithin('C:/Temp/sdlc-x/sub/../alvo', 'C:/Temp/sdlc-x'), true);
});

// ---------- R4-16: resultado estruturado de up ----------

interface UpPayloadTeamEntry { role: string; paneId: string; generationId: string; ready: boolean; }
function upPayload(overrides: Partial<{ partial: boolean; team: UpPayloadTeamEntry[] }> = {}) {
  return {
    slug: 'pilot', workflow: 'feature', partial: false,
    team: (FEATURE_TEAM_ROLES as readonly string[]).map(role => ({ role, paneId: `pane-${role}`, generationId: `gen-${role}`, ready: true })),
    ...overrides,
  };
}

test('unitário: validateUpResult recusa exit0 com partial=true (time parcial não é sucesso)', () => {
  const partial = upPayload({ partial: true });
  assert.throws(() => validateUpResult(partial), /time parcial/);
});

test('unitário: validateUpResult exige todos os papéis com readiness e identidade', () => {
  const semPapel = upPayload();
  semPapel.team = semPapel.team.filter(t => t.role !== 'reviewer');
  assert.throws(() => validateUpResult(semPapel), /reviewer ausente/);

  const semReadiness = upPayload();
  semReadiness.team.find(t => t.role === 'dev')!.ready = false;
  assert.throws(() => validateUpResult(semReadiness), /dev sem readiness/);

  const semIdentidade = upPayload();
  semIdentidade.team.find(t => t.role === 'document')!.generationId = '';
  assert.throws(() => validateUpResult(semIdentidade), /document sem identidade/);

  assert.throws(() => validateUpResult(undefined), /ilegível/);
  assert.throws(() => validateUpResult('{"partial":false}'), /ilegível/);
});

test('unitário: validateUpResult aceita time completo estruturado', () => {
  const result = validateUpResult(upPayload());
  assert.equal(result.partial, false);
  assert.equal(result.team.length, FEATURE_TEAM_ROLES.length);
});

// ---------- mecanismo: evidência e relatório honestos ----------

test('mecanismo: coleta registra passos, falha de asserção aborta e relatório separa seções', async () => {
  const evidence = new LiveEvidence();
  evidence.record('passo-1', 'cmd --x', 0, 'ok');
  evidence.assert('passo-1', true, 'sempre ok');
  assert.throws(() => evidence.assert('passo-2', false, 'detalhe do problema'), (e: unknown) => e instanceof LiveGuardError && /passo-2/.test((e as Error).message));

  // Manual sem anexos: listado, mas em notExecuted — nunca pass.
  evidence.recordManual('manual-1', 'descrever passo manual');
  // Manual com anexo verificável: executado.
  const target = await disposableTarget();
  const att = join(target, 'anexo.txt');
  await writeFile(att, 'evidência do operador');
  evidence.recordManual('manual-2', 'passo com evidência', [att]);
  // Manual com anexo inacessível: não executado, com problema registrado.
  evidence.recordManual('manual-3', 'passo com anexo perdido', [join(target, 'nao-existe.png')]);

  await evidence.verifyManualAttachments();
  const report = evidence.report();
  assert.equal(report.automated.length, 1);
  assert.equal(report.manual.length, 3);
  assert.deepEqual(report.notExecuted, ['manual-1', 'manual-3']);
  const m2 = report.manual.find(e => e.step === 'manual-2');
  assert.equal(m2?.executed, true);
  const m3 = report.manual.find(e => e.step === 'manual-3');
  assert.ok(m3?.problems?.some(p => /inacessível/.test(p)));
  assert.deepEqual([...report.future], [...FUTURE_LIVE]);
  assert.ok(report.future.some(f => /60 minutos/.test(f)));
  assert.ok(report.future.some(f => /PR real/.test(f)));

  const reportPath = join(target, 'relatorio', 'pilot.json');
  await evidence.write(reportPath);
  const parsed = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(reportPath, 'utf8'))) as typeof report;
  assert.equal(parsed.automated.length, 1);
  assert.deepEqual(parsed.notExecuted, ['manual-1', 'manual-3']);
});

// ---------- mecanismo: piloto com falsos ----------

test('mecanismo: runLivePilot aborta na etapa adopt quando o alvo não tem config (falsos)', async () => {
  const target = await mkdtemp(join(tmpdir(), 'sdlc-live-'));
  await writeFile(join(target, '.sdlc-live-fixture'), 'descartavel');
  await assert.rejects(
    () => runLivePilot({ live: '1', target, expectedTmpPrefix: tmpdir() }, { runner: okProbes() }),
    /asserção do piloto falhou em 'adopt'/);
});

/** Herdr falso que registra SessionStart por papel (prontidão completa) ou falha
 *  de readiness para o papel indicado (simula time parcial com exit0). */
function herdrFake(target: string, failRole?: string, starts?: string[][]) {
  return {
    async ensureWorkspace(projectId: string, path: string) { return { workspaceId: 'w', projectId, path }; },
    async createTab(_w: string, _l: string, cwd: string, env: Record<string, string>) {
      if (env.SDLC_CODEX_ROLE !== failRole) {
        const { SessionRegistry } = await import('../../src/sessions/registry.js');
        const { StateStore } = await import('../../src/state/store.js');
        const role = env.SDLC_CODEX_ROLE as 'planner' | 'dev' | 'reviewer' | 'tester-e2e' | 'document';
        await new SessionRegistry(new StateStore(join(target, '.sdlc-codex'), { projectId: '11111111-2222-3333-4444-555555555507' }))
          .register({ event: 'SessionStart', session_id: `live-${role}`, cwd, project_id: env.SDLC_CODEX_PROJECT_ID, role, token: env.SDLC_CODEX_LAUNCH_TOKEN });
      }
      return { tabId: `tab-${env.SDLC_CODEX_ROLE}`, paneId: `pane-${env.SDLC_CODEX_ROLE}` };
    },
    async listPanes() { return [{ paneId: 'pane-x', ready: true, workspaceId: 'w' }]; },
    async startAgent(_name: string, _paneId: string, args: string[] = []) { starts?.push(args); return; },
    async acceptProjectTrust() { return true; },
    // Lançar (e não apenas retornar false) força o caminho rápido do launcher
    // (try/catch por papel) — o polling até o deadline de 60 s seria proibitivo.
    async waitAgent(name: string) { if (failRole && name.endsWith(`-${failRole}`)) throw new Error('agente sem readiness no Herdr'); return true; },
    async listAgents() { return []; },
  };
}

function gitFake() {
  return new FakeProcessRunner((executable, args) => {
    const base = { stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (executable === 'codex' && args[0] === '--version') return { ...base, exitCode: 0, stdout: 'codex-cli 0.155.0\n' };
    if (executable === 'herdr' && args[0] === '--version') return { ...base, exitCode: 0, stdout: '0.7.5\n' };
    if (executable === 'git') {
      if (args[0] === 'worktree') return { ...base, exitCode: 0, stdout: '' };
      if (args[0] === 'show-ref') return { ...base, exitCode: 1, stdout: '' };
    }
    return { ...base, exitCode: 0, stdout: '' };
  });
}

async function pilotTarget(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'sdlc-live-'));
  await writeFile(join(target, '.sdlc-live-fixture'), 'descartavel');
  await writeFile(join(target, 'project-config.json'), JSON.stringify({
    schemaVersion: 1, projectId: '11111111-2222-3333-4444-555555555507',
    projectName: 'Live', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'],
  }));
  return target;
}

test('mecanismo: up parcial (exit0) aborta o piloto — exit0 isolado não é sucesso (R4-16)', async () => {
  const target = await pilotTarget();
  // 'document' nunca fica pronto no Herdr falso: up sai 0 com partial=true.
  await assert.rejects(
    () => runLivePilot({ live: '1', target, expectedTmpPrefix: tmpdir() }, { runner: gitFake(), herdr: herdrFake(target, 'document') }),
    /time parcial/);
});

test('mecanismo: piloto feliz com falsos valida time completo estruturado e grava relatório honesto', async () => {
  const target = await pilotTarget();
  const { reportPath, evidence } = await runLivePilot(
    { live: '1', target, expectedTmpPrefix: tmpdir() },
    { runner: gitFake(), herdr: herdrFake(target) });
  const steps = evidence.entries.map(e => e.step);
  assert.ok(steps.includes('adopt'));
  assert.ok(steps.includes('up'));
  assert.ok(steps.includes('up-team'));
  assert.equal(steps.filter(s => s.startsWith('manual-')).length, MANUAL_STEPS.length);
  const report = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(reportPath, 'utf8'))) as {
    automated: Array<{ step: string }>; manual: unknown[]; notExecuted: string[]; future: string[];
  };
  assert.ok(report.automated.some(e => e.step === 'up-team'));
  assert.equal(report.manual.length, MANUAL_STEPS.length);
  // Sem operador, todo o roteiro manual fica em notExecuted (nunca pass).
  assert.equal(report.notExecuted.length, MANUAL_STEPS.length);
  assert.ok(report.future.length >= 3);
});

test('mecanismo: piloto de cinco papéis encaminha as opções live ao Codex sem alterar configuração global', async () => {
  const target = await pilotTarget();
  const starts: string[][] = [];
  const herdr = herdrFake(target, undefined, starts);

  await runLivePilot(
    { live: '1', target, expectedTmpPrefix: tmpdir() },
    { runner: gitFake(), herdr },
    { trustProject: true, bypassHookTrust: true, windowsSandbox: 'unelevated' },
  );

  assert.equal(starts.length, FEATURE_TEAM_ROLES.length);
  for (const args of starts) {
    assert.ok(args.includes('--dangerously-bypass-hook-trust'));
    assert.ok(args.includes('-c'));
    assert.ok(args.includes('windows.sandbox="unelevated"'));
    assert.ok(args.some(arg => arg.startsWith('projects={')));
  }
});

test('mecanismo: suíte padrão roda sem SDLC_LIVE — piloto exige opt-in explícito', () => {
  assert.notEqual(process.env.SDLC_LIVE, '1');
  // Os testes live (tests/live/*.test.ts) usam { skip: !enabled } e jamais
  // reportam sucesso live sem o opt-in; aqui só se exercita o mecanismo com falsos.
});
