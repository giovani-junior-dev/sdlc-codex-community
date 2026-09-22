import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tryCaptureCodeSnapshot } from '../../src/evidence/snapshot.js';
import { gitFake, porcelain, put, tmpRepo } from './snapshot-fixture.js';

// M2-F2 (R5-06) — symlink/junction e permissões no filesystem REAL (temp). O Git segue sendo falso.
// Comportamento do Git/Windows observado em docs/validation/round-5/m2-git-format-probe.log:
// `git status -uall` lista `junction-out/secret.txt` (segue a junction) e `link-file` (symlink de arquivo).

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Cria symlink/junction; sem privilégio (EPERM) o teste é PULADO com motivo — nunca aprovado às cegas. */
async function tryLink(t: TestContext, target: string, path: string, type: 'file' | 'junction'): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    t.skip(`symlink indisponível neste ambiente (${(error as NodeJS.ErrnoException).code})`);
    return false;
  }
}

test('R5-06: symlink de arquivo é hasheado pelo texto do alvo (tipo symlink) e NUNCA seguido', async t => {
  const dir = await tmpRepo();
  const outside = await tmpRepo('sdlc-outside-');
  await put(outside, { 'secret.txt': 'fora v1\n', 'other.txt': 'outro\n' });
  const link = join(dir, 'link-file');
  if (!await tryLink(t, join(outside, 'secret.txt'), link, 'file')) return;
  const status = porcelain('?? link-file');
  const r1 = await tryCaptureCodeSnapshot(gitFake(status), dir);
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(r1.inventory[0].type, 'symlink');
  assert.equal(r1.inventory[0].hash, sha(await readlink(link)), 'hash do texto do alvo, não do conteúdo');
  // o conteúdo apontado (fora do escopo) mudar NÃO é lido nem altera o fingerprint
  await writeFile(join(outside, 'secret.txt'), 'fora v2 — não deve ser lido\n');
  const r2 = await tryCaptureCodeSnapshot(gitFake(status), dir);
  assert.ok(r2.ok);
  assert.equal(r2.snapshot.diffFingerprint, r1.snapshot.diffFingerprint);
  // retargetar o link muda o registro
  await unlink(link);
  await symlink(join(outside, 'other.txt'), link, 'file');
  const r3 = await tryCaptureCodeSnapshot(gitFake(status), dir);
  assert.ok(r3.ok);
  assert.notEqual(r3.snapshot.diffFingerprint, r1.snapshot.diffFingerprint);
});

test('R5-06: junction/symlink de DIRETÓRIO que resolve para fora do escopo => outside-scope (conteúdo externo não é lido)', async t => {
  const dir = await tmpRepo();
  const outside = await tmpRepo('sdlc-outside-');
  await put(outside, { 'secret.txt': 'fora do escopo\n' });
  if (!await tryLink(t, outside, join(dir, 'junction-out'), 'junction')) return;
  // formato real da sonda: o Git lista o arquivo DENTRO da junction
  const r = await tryCaptureCodeSnapshot(gitFake(porcelain('?? junction-out/secret.txt')), dir);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'outside-scope');
  assert.equal(r.path, 'junction-out/secret.txt');
});

test('R5-06: junction para DENTRO do escopo é permitida e o arquivo é hasheado por bytes', async t => {
  const dir = await tmpRepo();
  await put(dir, { 'real/x.txt': 'dentro v1\n' });
  if (!await tryLink(t, join(dir, 'real'), join(dir, 'alias'), 'junction')) return;
  const status = porcelain('?? alias/x.txt');
  const r1 = await tryCaptureCodeSnapshot(gitFake(status), dir);
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(r1.inventory[0].type, 'file');
  await writeFile(join(dir, 'real', 'x.txt'), 'dentro v2\n');
  const r2 = await tryCaptureCodeSnapshot(gitFake(status), dir);
  assert.ok(r2.ok);
  assert.notEqual(r2.snapshot.diffFingerprint, r1.snapshot.diffFingerprint);
});

test('R5-06: arquivo relevante ilegível (permissão) => read-failed, nunca hash constante "unreadable"', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('chmod 000 não bloqueia leitura no Windows nem para root; cenário coberto em snapshot-failures via ENOENT/ENOTDIR');
    return;
  }
  const dir = await tmpRepo();
  await put(dir, { 'secret.ts': 'x\n' });
  await chmod(join(dir, 'secret.ts'), 0o000);
  const r = await tryCaptureCodeSnapshot(gitFake(porcelain('?? secret.ts')), dir);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'read-failed');
    assert.equal(r.path, 'secret.ts');
  }
});

test('R5-06: diretório vazio ou aninhado não vira arquivo: entrada de diretório não é lida', async () => {
  const dir = await tmpRepo();
  await mkdir(join(dir, 'nested', '.git'), { recursive: true });
  const r = await tryCaptureCodeSnapshot(gitFake(porcelain('?? nested/')), dir);
  assert.ok(r.ok);
  assert.equal(r.inventory[0].type, 'directory');
  assert.equal(r.inventory[0].hash, '');
});
