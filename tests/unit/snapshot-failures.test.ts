import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { captureCodeSnapshot, SnapshotCaptureError, tryCaptureCodeSnapshot, type SnapshotFailureCode } from '../../src/evidence/snapshot.js';
import { fail, gitFake, GitFake, ok, porcelain, put, timeout, tmpRepo } from './snapshot-fixture.js';

// R5-04 (base): captura com resultado DISCRIMINADO. Tabela de resultados esperados (M2-F1):
// cada falha de HEAD/status/diff/leitura/escopo/estabilidade produz um código explícito em
// tryCaptureCodeSnapshot (ok:false, sem snapshot) e SnapshotCaptureError em captureCodeSnapshot.

type Make = (dir: string) => GitFake | Promise<GitFake>;
interface Row { name: string; make: Make; code: SnapshotFailureCode; path?: string }

const boom = (): never => { throw new Error('spawn git ENOENT'); };
const fileStatus = porcelain(' M src/a.ts');

/** Fixture com um arquivo relevante existente e status coerente; o hook injeta a falha. */
const withFile = (hook: ConstructorParameters<typeof GitFake>[1], status = fileStatus, diff = ''): Make => async dir => {
  await put(dir, { 'src/a.ts': 'conteúdo\n' });
  return gitFake(status, diff, hook);
};
const plain = (status = '', diff = '', hook?: ConstructorParameters<typeof GitFake>[1]): Make => () => gitFake(status, diff, hook);

const rows: Row[] = [
  // HEAD
  { name: 'HEAD: exit != 0', make: plain('', '', c => c === 'head' ? fail() : undefined), code: 'head-failed' },
  { name: 'HEAD: timeout', make: plain('', '', c => c === 'head' ? timeout() : undefined), code: 'timeout' },
  { name: 'HEAD: commit vazio (exit 0)', make: () => new GitFake({ head: '', status: '', diff: '' }), code: 'empty-commit' },
  { name: 'HEAD: valor que não é commit', make: () => new GitFake({ head: 'HEAD', status: '', diff: '' }), code: 'invalid-output' },
  { name: 'HEAD: runner rejeita (git ausente)', make: plain('', '', c => c === 'head' ? boom() : undefined), code: 'head-failed' },
  // status
  { name: 'status: exit != 0', make: plain('', '', c => c === 'status' ? fail() : undefined), code: 'status-failed' },
  { name: 'status: timeout', make: plain('', '', c => c === 'status' ? timeout() : undefined), code: 'timeout' },
  { name: 'status: runner rejeita', make: plain('', '', c => c === 'status' ? boom() : undefined), code: 'status-failed' },
  { name: 'status: saída truncada (sem NUL final)', make: plain(' M src/a.ts\0 M src/b'), code: 'invalid-output' },
  { name: 'status: registro inválido', make: plain('lixo\0'), code: 'invalid-output' },
  { name: 'status: rename inesperado apesar de --no-renames', make: plain(porcelain('R  novo.ts', 'antigo.ts')), code: 'invalid-output', path: 'novo.ts' },
  { name: 'status: caminho com bytes não-UTF-8 (U+FFFD)', make: plain(porcelain('?? a\uFFFDb.ts')), code: 'invalid-output' },
  // diff
  { name: 'diff: exit != 0', make: plain('', '', c => c === 'diff' ? fail(1) : undefined), code: 'diff-failed' },
  { name: 'diff: timeout', make: plain('', '', c => c === 'diff' ? timeout() : undefined), code: 'timeout' },
  { name: 'diff: runner rejeita', make: plain('', '', c => c === 'diff' ? boom() : undefined), code: 'diff-failed' },
  { name: 'diff: saída truncada (sem newline final)', make: plain('', 'diff --git a/x b/x\n+linha sem fim'), code: 'invalid-output' },
  // escopo
  { name: 'escopo: caminho com ..', make: plain(porcelain('?? ../fora.txt')), code: 'outside-scope', path: '../fora.txt' },
  { name: 'escopo: caminho absoluto POSIX', make: plain(porcelain('?? /etc/passwd')), code: 'outside-scope', path: '/etc/passwd' },
  { name: 'escopo: caminho absoluto de drive', make: plain(porcelain('?? C:/Windows/x.dll')), code: 'outside-scope', path: 'C:/Windows/x.dll' },
  // leitura
  { name: 'leitura: arquivo listado ausente sem D no status', make: plain(fileStatus), code: 'read-failed', path: 'src/a.ts' },
  {
    name: 'leitura: arquivo desaparece antes da leitura (some entre status e hash)',
    make: async dir => {
      await put(dir, { 'src/a.ts': 'x' });
      return gitFake(fileStatus, '', async c => { if (c === 'diff') await rm(join(dir, 'src', 'a.ts')); return undefined; });
    },
    code: 'read-failed', path: 'src/a.ts',
  },
  {
    name: 'leitura: pai do caminho é um arquivo (ENOTDIR)',
    make: async dir => { await put(dir, { 'src': 'sou arquivo' }); return gitFake(porcelain('?? src/a.ts')); },
    code: 'read-failed', path: 'src/a.ts',
  },
  // instabilidade
  { name: 'instável: HEAD muda entre as leituras', make: plain('', '', (c, n) => c === 'head' && n === 2 ? ok('def456\n') : undefined), code: 'unstable' },
  { name: 'instável: arquivo novo aparece na releitura do inventário', make: withFile((c, n) => c === 'status' && n === 2 ? ok(porcelain(' M src/a.ts', '?? novo.ts')) : undefined), code: 'unstable' },
  { name: 'instável: arquivo some do inventário na releitura', make: withFile((c, n) => c === 'status' && n === 2 ? ok('') : undefined), code: 'unstable' },
  { name: 'releitura do status falha: erro classificado (não reaproveita a primeira leitura)', make: withFile((c, n) => c === 'status' && n === 2 ? fail() : undefined), code: 'status-failed' },
  {
    name: 'instável: mtime do arquivo muda durante a captura (mesmo tamanho)',
    make: async dir => {
      await put(dir, { 'src/a.ts': 'conteúdo\n' });
      return gitFake(fileStatus, '', async (c, n) => {
        if (c === 'status' && n === 2) await utimes(join(dir, 'src', 'a.ts'), new Date(), new Date(Date.now() + 3_600_000));
        return undefined;
      });
    },
    code: 'unstable', path: 'src/a.ts',
  },
];

for (const row of rows) {
  test(`R5-04: ${row.name} => ${row.code}`, async () => {
    const dir = await tmpRepo();
    const result = await tryCaptureCodeSnapshot(await row.make(dir), dir);
    assert.equal(result.ok, false, `esperado falha, veio ${JSON.stringify(result)}`);
    if (result.ok) return;
    assert.equal(result.code, row.code, result.message);
    assert.ok(result.message.length > 0);
    if (row.path !== undefined) assert.equal(result.path, row.path);
    assert.equal('snapshot' in result, false, 'falha nunca carrega snapshot parcial');
    // a versão que lança é o mesmo contrato, com o mesmo código.
    await assert.rejects(captureCodeSnapshot(await row.make(dir), dir), (error: unknown) =>
      error instanceof SnapshotCaptureError && error.code === row.code);
  });
}

test('R5-04: chamadas ao Git são somente leitura, com timeout explícito, cwd da captura e sem lock opcional', async () => {
  const dir = await tmpRepo();
  await put(dir, { 'src/a.ts': 'x' });
  const git = gitFake(fileStatus);
  await captureCodeSnapshot(git, dir);
  assert.deepEqual(new Set(git.calls.map(c => c.args[0])), new Set(['rev-parse', 'status', 'diff']));
  for (const c of git.calls) {
    assert.equal(c.executable, 'git');
    assert.equal(c.timeoutMs, 60_000, 'timeout default explícito');
    assert.equal(c.cwd, dir);
    assert.equal(c.env?.GIT_OPTIONAL_LOCKS, '0', 'status não pode reescrever .git/index');
  }
  const status = git.calls.find(c => c.args[0] === 'status')!.args;
  assert.deepEqual(status.slice(0, 5), ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  const diff = git.calls.find(c => c.args[0] === 'diff')!.args;
  for (const flag of ['HEAD', '--no-ext-diff', '--no-textconv', '--no-renames']) assert.ok(diff.includes(flag), flag);
  const custom = gitFake(fileStatus);
  await captureCodeSnapshot(custom, dir, { timeoutMs: 1234 });
  assert.ok(custom.calls.every(c => c.timeoutMs === 1234));
});

test('R5-04: falha nunca reaproveita snapshot anterior — captura seguinte após falha é independente e válida', async () => {
  const dir = await tmpRepo();
  const first = await tryCaptureCodeSnapshot(gitFake(''), dir);
  assert.ok(first.ok);
  const broken = await tryCaptureCodeSnapshot(gitFake('', '', c => c === 'status' ? fail() : undefined), dir);
  assert.equal(broken.ok, false);
  const again = await tryCaptureCodeSnapshot(gitFake(''), dir);
  assert.ok(again.ok);
  assert.equal(again.snapshot.diffFingerprint, first.snapshot.diffFingerprint, 'árvore igual => equivalentes (base do gate before/after)');
});
