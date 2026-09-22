import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runCheck, requiredChecks } from '../../src/evidence/checks.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { CommandConfig } from '../../src/project/config.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const okResult = { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, acceptedBeforeTimeout: false };

// ---------- M4-F2 — requiredChecks compartilhada: config respeitada, ausência acidental separada ----------

test('requiredChecks: matriz do método + lint configurado em estágios que inspecionam código', () => {
  const all: Record<string, CommandConfig> = {
    build: { executable: 't', args: ['b'] }, lint: { executable: 't', args: ['l'] },
    unit: { executable: 't', args: ['u'] }, e2e: { executable: 't', args: ['e'] },
  };
  assert.deepEqual(requiredChecks(all, 'feature', 'build').required, ['build', 'lint']);
  assert.deepEqual(requiredChecks(all, 'feature', 'review').required, ['unit', 'lint']);
  assert.deepEqual(requiredChecks(all, 'feature', 'e2e').required, ['e2e']);
  assert.deepEqual(requiredChecks(all, 'feature', 'pr').required, ['build', 'lint']);
  assert.deepEqual(requiredChecks(all, 'feature', 'document').required, ['build']);
  // lint configurado mas estágio não inspeciona código => não entra
  assert.deepEqual(requiredChecks(all, 'feature', 'e2e').skipped, ['build', 'lint', 'unit']);
  // sem lint configurado: comportamento da matriz do método
  const noLint = { build: all.build, unit: all.unit, e2e: all.e2e };
  assert.deepEqual(requiredChecks(noLint, 'feature', 'build').required, ['build']);
  assert.deepEqual(requiredChecks(noLint, 'feature', 'build').missing, []);
});

test('requiredChecks: ausência acidental (exigido pelo método, fora da config) nunca vira pass', () => {
  const onlyUnit = { unit: { executable: 't', args: ['u'] } };
  const sel = requiredChecks(onlyUnit, 'feature', 'build');
  assert.deepEqual(sel.required, []);
  assert.deepEqual(sel.missing, ['build']);
  assert.equal(sel.notApplicable, false);
  // R5-03: a ausência da config nunca gera dispensa; só dispensa explícita aprovada (manifesto) move o check para `exempt`
  assert.deepEqual(sel.exempt, []);
  const exempted = requiredChecks(onlyUnit, 'feature', 'build', [{ workflow: 'feature', stage: 'build', check: 'build', reason: 'projeto sem build' }]);
  assert.deepEqual(exempted.missing, []);
  assert.deepEqual(exempted.exempt, [{ check: 'build', reason: 'projeto sem build' }]);
  // review-only: método não exige check mecânico — explicitamente não aplicável
  const ro = requiredChecks(onlyUnit, 'review-only', 'review');
  assert.equal(ro.notApplicable, true);
  assert.deepEqual(ro.required, []);
  assert.deepEqual(ro.missing, []);
});

// ---------- M4-F2 — cwd relativo resolve contra o worktree da execução ----------

test('runCheck: command.cwd relativo resolve contra o worktree, nunca contra o cwd de quem chamou', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'sdlc-cwd-'));
  const calls: Array<{ executable: string; args: string[]; cwd?: string }> = [];
  // runner falso que registra argv/cwd efetivos (FakeProcessRunner não expõe options)
  const recording = {
    async run(executable: string, args: string[], options: { cwd?: string } = {}) {
      calls.push({ executable, args, cwd: options.cwd });
      return okResult;
    },
  };
  await runCheck('build', { executable: 't', args: [], cwd: 'subdir' }, recording, worktree, join(worktree, 'ev'));
  assert.equal(calls[0].cwd, resolve(worktree, 'subdir'));
  await runCheck('build', { executable: 't', args: [], cwd: worktree }, recording, worktree, join(worktree, 'ev'));
  assert.equal(calls[1].cwd, worktree, 'cwd absoluto segue o contrato documentado');
  // caller em diretório diferente do worktree: cwd registrado permanece no worktree
  const elsewhere = await mkdtemp(join(tmpdir(), 'sdlc-caller-'));
  await runCheck('unit', { executable: 't', args: [], cwd: 'src' }, recording, worktree, join(worktree, 'ev'));
  assert.equal(calls[2].cwd, resolve(worktree, 'src'));
  assert.notEqual(calls[2].cwd, resolve(elsewhere, 'src'));
});

// ---------- M4-F2 — logs duráveis: imutáveis, preservados entre tentativas ----------

test('runCheck: logs imutáveis — mesmo check em duas tentativas preserva o log anterior', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-durable-'));
  const ev = join(dir, 'ev');
  const r1 = new FakeProcessRunner(() => ({ exitCode: 1, stdout: '', stderr: 'boom-tentativa-1', timedOut: false, acceptedBeforeTimeout: false }));
  const first = await runCheck('build', { executable: 't', args: [] }, r1, dir, ev, { logName: 'build-r0-a0-x1.log' });
  assert.equal(first.status, 'failed');
  const r2 = new FakeProcessRunner(() => okResult);
  const second = await runCheck('build', { executable: 't', args: [] }, r2, dir, ev, { logName: 'build-r0-a1-x2.log' });
  assert.equal(second.status, 'approved');
  // log da tentativa anterior preservado após falha e retry
  assert.match(await readFile(first.logPath, 'utf8'), /boom-tentativa-1/);
  assert.match(await readFile(second.logPath, 'utf8'), /exitCode: 0/);
  assert.notEqual(first.logPath, second.logPath);
  // hash registrado confere com o conteúdo real do log
  assert.equal(first.logHash, sha256(await readFile(first.logPath, 'utf8')));
});

test('runCheck: mesmo slug em runs diferentes não colide; nome reutilizado falha em vez de sobrescrever', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-imut-'));
  const ev = join(dir, 'ev');
  const okRunner = new FakeProcessRunner(() => okResult);
  // dois runs (revisões distintas) do mesmo slug: nomes distintos por revisão/tentativa/evidenceId
  const runA = await runCheck('build', { executable: 't', args: [] }, okRunner, dir, ev, { logName: 'build-r0-a0-runA.log' });
  const runB = await runCheck('build', { executable: 't', args: [] }, okRunner, dir, ev, { logName: 'build-r1-a0-runB.log' });
  assert.notEqual(runA.logPath, runB.logPath);
  // nome de log reutilizado (violação do contrato de imutabilidade) rejeita com erro explicativo
  await assert.rejects(
    () => runCheck('build', { executable: 't', args: [] }, okRunner, dir, ev, { logName: 'build-r0-a0-runA.log' }),
    /imutáveis/);
});

test('runCheck: timeout é interrupted; lint falhando é failed; ausente é missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-status-'));
  const ev = join(dir, 'ev');
  const slow = new FakeProcessRunner(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true, acceptedBeforeTimeout: false }));
  assert.equal((await runCheck('build', { executable: 't', args: [] }, slow, dir, ev)).status, 'interrupted');
  const lintFail = new FakeProcessRunner(() => ({ exitCode: 1, stdout: '', stderr: 'lint erro', timedOut: false, acceptedBeforeTimeout: false }));
  const lint = await runCheck('lint', { executable: 't', args: ['lint'] }, lintFail, dir, ev);
  assert.equal(lint.status, 'failed');
  assert.equal(lint.exitCode, 1);
  const missing = await runCheck('e2e', undefined, lintFail, dir, ev);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.exitCode, null);
});

test('runCheck: log contém stdout/stderr/exit code verificáveis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-log-'));
  const ev = join(dir, 'ev');
  const runner = new FakeProcessRunner(() => ({ exitCode: 3, stdout: 'saída', stderr: 'erro', timedOut: false, acceptedBeforeTimeout: false }));
  const out = await runCheck('unit', { executable: 't', args: ['x'] }, runner, dir, ev);
  const log = await readFile(out.logPath, 'utf8');
  assert.match(log, /saída/);
  assert.match(log, /erro/);
  assert.match(log, /exitCode: 3/);
});
