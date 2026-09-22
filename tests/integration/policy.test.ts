import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPolicy } from '../../src/hooks/policy.js';
import { runCheck } from '../../src/evidence/checks.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import { validateConfig } from '../../src/project/config.js';

test('política bloqueia deploy, Git destrutivo e apply_patch em protegido', () => {
  assert.equal(checkPolicy({ action: 'deploy', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git reset --hard', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git merge feature/x', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git rebase main', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git clean -fd', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git push --force origin sdlc/x', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git push -f origin sdlc/x', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git checkout -b fora-do-fluxo', protectedPaths: [] }).allowed, false);
  // C06: commit/push da branch de trabalho são autorizados pelo plano aprovado.
  assert.equal(checkPolicy({ action: 'git', command: 'git commit -m "x"', protectedPaths: [] }).allowed, true);
  assert.equal(checkPolicy({ action: 'git', command: 'git push origin sdlc/demanda', protectedPaths: [] }).allowed, true);
  // apply_patch com caminho protegido citado no comando
  assert.equal(checkPolicy({ action: 'write', tool: 'apply_patch', command: 'apply_patch *** Begin Patch\n*** Update File: .sdlc-codex/runtime.json', protectedPaths: ['.sdlc-codex'] }).allowed, false);
  assert.equal(checkPolicy({ action: 'write', path: 'docs/x.md', protectedPaths: ['.git'] }).allowed, true);
});

// C06 (revisão cruzada): branch protegida, contornos de criação de branch,
// separador Windows em apply_patch e falso positivo de merge-base.
test('política: push para branch protegida e criação fora do fluxo são bloqueados', () => {
  const protectedBranches = ['main'];
  assert.equal(checkPolicy({ action: 'git', command: 'git push origin main', protectedPaths: [], protectedBranches }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git push origin +main', protectedPaths: [], protectedBranches }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git push origin HEAD:main', protectedPaths: [], protectedBranches }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git push origin sdlc/x:main', protectedPaths: [], protectedBranches }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git push origin sdlc/demanda', protectedPaths: [], protectedBranches }).allowed, true);
  // Criação de branch fora do fluxo: checkout -b, switch -c e `git branch <nome>`.
  assert.equal(checkPolicy({ action: 'git', command: 'git branch nova-feature', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git switch -c nova', protectedPaths: [] }).allowed, false);
  assert.equal(checkPolicy({ action: 'git', command: 'git branch', protectedPaths: [] }).allowed, true);
  assert.equal(checkPolicy({ action: 'git', command: 'git branch -D velha', protectedPaths: [] }).allowed, true);
  // merge-base é inspeção read-only legítima: NÃO é bloqueado.
  assert.equal(checkPolicy({ action: 'git', command: 'git merge-base --is-ancestor main HEAD', protectedPaths: [] }).allowed, true);
});

test('política: apply_patch com separador Windows em caminho protegido é bloqueado', () => {
  // Contraexemplo da revisão cruzada: `.sdlc-codex\runtime.json` não era extraído.
  assert.equal(checkPolicy({
    action: 'write', tool: 'apply_patch',
    command: 'apply_patch *** Begin Patch\n*** Update File: .sdlc-codex\\runtime.json',
    protectedPaths: ['.sdlc-codex'],
  }).allowed, false);
  assert.equal(checkPolicy({
    action: 'write', tool: 'apply_patch',
    command: 'apply_patch *** Begin Patch\n*** Update File: C:\\proj\\src\\a.ts',
    protectedPaths: ['.sdlc-codex'],
  }).allowed, true);
});

// R4-09: caminhos relativos resolvem contra a BASE da sessão (baseDir), não
// contra o cwd do processo do hook — worktree/subdiretório protegidos de verdade.
test('política: caminhos relativos resolvem contra baseDir da sessão', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'sdlc-wt-'));
  // Escrita em <worktree>/.sdlc-codex/runtime.json via path relativo.
  const denied = checkPolicy({
    action: 'write', path: '.sdlc-codex/runtime.json',
    protectedPaths: ['.sdlc-codex'], baseDir: worktree,
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? '', /caminho protegido/);
  // Mesmo path relativo SEM baseDir (resolve contra o cwd do teste) NÃO protege
  // o worktree — o hook sempre passa baseDir; este braço documenta a assinatura.
  const allowed = checkPolicy({
    action: 'write', path: 'src/index.ts',
    protectedPaths: ['.sdlc-codex'], baseDir: worktree,
  });
  assert.equal(allowed.allowed, true);
  // Caminho absoluto continua absoluto (baseDir ignorado para absolutos).
  const absDenied = checkPolicy({
    action: 'write', path: join(worktree, '.sdlc-codex', 'runtime.json'),
    protectedPaths: ['.sdlc-codex'], baseDir: worktree,
  });
  assert.equal(absDenied.allowed, false);
  // apply_patch com path relativo citado no conteúdo também resolve na base.
  assert.equal(checkPolicy({
    action: 'write', tool: 'apply_patch',
    command: 'apply_patch *** Begin Patch\n*** Update File: .git\\config',
    protectedPaths: ['.git'], baseDir: worktree,
  }).allowed, false);
});

// R16: runCheck exercitado — aprovado, falho, ausente e interrompido.
test('runCheck diferencia aprovado, falho, ausente e interrompido', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-check-'));
  const ev = join(dir, 'ev');
  const okRunner = new FakeProcessRunner(() => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, acceptedBeforeTimeout: false }));
  assert.equal((await runCheck('unit', { executable: 'npm', args: ['test'] }, okRunner, dir, ev)).status, 'approved');
  const failRunner = new FakeProcessRunner(() => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, acceptedBeforeTimeout: false }));
  assert.equal((await runCheck('unit', { executable: 'npm', args: ['test'] }, failRunner, dir, ev)).status, 'failed');
  assert.equal((await runCheck('e2e', undefined, okRunner, dir, ev)).status, 'missing');
  const slowRunner = new FakeProcessRunner(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true, acceptedBeforeTimeout: false }));
  assert.equal((await runCheck('build', { executable: 'npm', args: ['run', 'build'] }, slowRunner, dir, ev)).status, 'interrupted');
});

test('config inválida é rejeitada com motivo (nunca engolida)', () => {
  assert.throws(() => validateConfig({}), /configuração inválida/);
  assert.throws(() => validateConfig({ schemaVersion: 1, projectId: 'p', projectName: 'n', prBase: 'main', protectedPaths: [], models: { 'desconhecido': {} } }), /papel desconhecido/);
  assert.throws(() => validateConfig({ schemaVersion: 1, projectId: 'p', projectName: 'n', prBase: 'main', protectedPaths: [], checks: { build: { executable: '', args: [] } } }), /executável/);
});
