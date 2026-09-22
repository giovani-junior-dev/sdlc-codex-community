import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureCodeSnapshot, tryCaptureCodeSnapshot } from '../../src/evidence/snapshot.js';
import { gitFake, GitFake, HEAD, porcelain, put, tmpRepo } from './snapshot-fixture.js';

// M4-F3 + M2-F1/F2 (R5-04, R5-06). Reescrito da versão antiga, que codificava o formato
// `status --short` textual e exclusões por nome (dist/, node_modules/, logs/, *.log): esse
// formato é exatamente o defeito R5-06. Os invariantes válidos (HEAD igual não prova árvore
// igual; untracked entra por conteúdo; artefato operacional não invalida) foram preservados.

const fingerprint = async (status: string, dir: string, diff = '', opts = {}): Promise<string> =>
  (await captureCodeSnapshot(gitFake(status, diff), dir, opts)).diffFingerprint;

test('M4-F3: commit igual com diff diferente => snapshot diferente (HEAD igual não prova árvore igual)', async () => {
  const dir = await tmpRepo();
  await put(dir, { 'src/a.ts': 'x\n' });
  const status = porcelain(' M src/a.ts');
  const s1 = await captureCodeSnapshot(gitFake(status, 'diff --git a/src/a.ts b/src/a.ts\n+linha\n'), dir);
  const s2 = await captureCodeSnapshot(gitFake(status, 'diff --git a/src/a.ts b/src/a.ts\n+linha ALTERADA\n'), dir);
  assert.equal(s1.commit, HEAD);
  assert.equal(s1.source, 'git-readonly');
  assert.notEqual(s1.diffFingerprint, s2.diffFingerprint);
});

test('R5-06: alterar newsrc/a.ts (diretório NOVO, -uall lista arquivo a arquivo) altera o fingerprint', async () => {
  const dir = await tmpRepo();
  const status = porcelain('?? newsrc/a.ts', '?? newsrc/b.ts', '?? newsrc/deep/c.ts');
  await put(dir, { 'newsrc/a.ts': 'one\n', 'newsrc/b.ts': 'b\n', 'newsrc/deep/c.ts': 'c\n' });
  const one = await fingerprint(status, dir);
  assert.equal(await fingerprint(status, dir), one, 'controle negativo: árvore igual => fingerprint igual');
  await writeFile(join(dir, 'newsrc', 'a.ts'), 'two\n');
  assert.notEqual(await fingerprint(status, dir), one, 'a.ts one->two');
  await writeFile(join(dir, 'newsrc', 'deep', 'c.ts'), 'c2\n');
  const two = await fingerprint(status, dir);
  await writeFile(join(dir, 'newsrc', 'deep', 'c.ts'), 'c3\n');
  assert.notEqual(await fingerprint(status, dir), two, 'arquivo em subdiretório profundo também entra');
});

test('R5-06: entrada de diretório ("?? nested/", repositório aninhado) não é lida como arquivo nem vira hash "unreadable"', async () => {
  const dir = await tmpRepo();
  await put(dir, { 'nested/n.txt': 'n\n' });
  const result = await tryCaptureCodeSnapshot(gitFake(porcelain('?? nested/')), dir);
  assert.ok(result.ok);
  assert.deepEqual(result.inventory.map(e => [e.path, e.type, e.hash]), [['nested/', 'directory', '']]);
});

test('R5-06: arquivos homônimos em diretórios distintos são distintos (troca de conteúdo altera o fingerprint)', async () => {
  const dir = await tmpRepo();
  const status = porcelain('?? newsrc/a.ts', '?? src/other/a.ts');
  await put(dir, { 'newsrc/a.ts': 'um\n', 'src/other/a.ts': 'dois\n' });
  const before = await fingerprint(status, dir);
  // mesmo multiconjunto de hashes, caminhos trocados: só passa se caminho e hash estiverem ligados.
  await put(dir, { 'newsrc/a.ts': 'dois\n', 'src/other/a.ts': 'um\n' });
  assert.notEqual(await fingerprint(status, dir), before);
});

test('R5-06: renomear (mesmo conteúdo) e remover alteram o fingerprint; remoção não é erro de leitura', async () => {
  const dir = await tmpRepo();
  await put(dir, { 'old.ts': 'conteúdo\n' });
  const asOld = await fingerprint(porcelain('?? old.ts'), dir);
  await rename(join(dir, 'old.ts'), join(dir, 'new.ts'));
  // --no-renames: rename staged aparece como D + A (fixture real da sonda)
  const asNew = await fingerprint(porcelain('D  old.ts', 'A  new.ts'), dir);
  assert.notEqual(asNew, asOld);
  const deleted = await tryCaptureCodeSnapshot(gitFake(porcelain(' D src/gone.ts')), dir);
  assert.ok(deleted.ok);
  assert.deepEqual(deleted.inventory.map(e => [e.path, e.status, e.type, e.hash]), [['src/gone.ts', ' D', 'deleted', '']]);
  assert.notEqual(deleted.snapshot.diffFingerprint, await fingerprint('', dir));
});

test('R5-06: staged x unstaged x untracked com o mesmo conteúdo têm fingerprints distintos', async () => {
  const dir = await tmpRepo();
  await put(dir, { 'src/a.ts': 'igual\n' });
  const all = new Set([
    await fingerprint(porcelain(' M src/a.ts'), dir),
    await fingerprint(porcelain('M  src/a.ts'), dir),
    await fingerprint(porcelain('MM src/a.ts'), dir),
    await fingerprint(porcelain('?? src/a.ts'), dir),
    await fingerprint(porcelain('A  src/a.ts'), dir),
  ]);
  assert.equal(all.size, 5);
});

test('R5-06: .log untracked que é fixture do produto ENTRA; logs/, dist/ e node_modules/ não são excluídos por nome', async () => {
  const dir = await tmpRepo();
  const files = { 'fixtures/produto.log': 'v1\n', 'logs/run.log': 'l1\n', 'dist/out.js': 'd1\n', 'node_modules/pkg/i.js': 'n1\n' };
  await put(dir, files);
  const status = porcelain('?? fixtures/produto.log', '?? logs/run.log', '?? dist/out.js', '?? node_modules/pkg/i.js');
  const result = await tryCaptureCodeSnapshot(gitFake(status), dir);
  assert.ok(result.ok);
  assert.deepEqual(result.inventory.map(e => e.path), ['dist/out.js', 'fixtures/produto.log', 'logs/run.log', 'node_modules/pkg/i.js']);
  for (const rel of Object.keys(files)) {
    const before = await fingerprint(status, dir);
    await writeFile(join(dir, rel), 'alterado\n');
    assert.notEqual(await fingerprint(status, dir), before, `${rel} deve alterar o fingerprint`);
  }
});

test('R5-06: artefato operacional (.sdlc-codex/) não altera o fingerprint; pathspec de exclusão vai ao Git', async () => {
  const dir = await tmpRepo();
  await put(dir, { 'src/a.ts': 'a\n', '.sdlc-codex/state.json': '{}', '.sdlc-codex/runs/x.json': '1' });
  const clean = porcelain('?? src/a.ts');
  const base = await fingerprint(clean, dir);
  const withOperational = porcelain('?? src/a.ts', '?? .sdlc-codex/state.json', 'A  .sdlc-codex/runs/x.json', ' M .sdlc-codex');
  assert.equal(await fingerprint(withOperational, dir), base);
  await writeFile(join(dir, '.sdlc-codex', 'state.json'), '{"outro":1}');
  assert.equal(await fingerprint(withOperational, dir), base, 'conteúdo operacional também não conta');
  const git = gitFake(clean);
  await captureCodeSnapshot(git, dir);
  const statusArgs = git.calls.find(c => c.args[0] === 'status')!.args;
  const magic = process.platform === 'win32' ? 'exclude,literal,icase' : 'exclude,literal'; // win32: Git só casa pathspec com icase (sonda)
  assert.deepEqual(statusArgs.slice(statusArgs.indexOf('--')), ['--', '.', `:(${magic}).sdlc-codex`]);
  const diffArgs = git.calls.find(c => c.args[0] === 'diff')!.args;
  assert.deepEqual(diffArgs.slice(diffArgs.indexOf('--')), ['--', '.', `:(${magic}).sdlc-codex`], 'diff também exclui via pathspec');
  // só o diretório operacional RAIZ: um homônimo aninhado é código do produto.
  await put(dir, { 'pkg/.sdlc-codex/a.txt': 'produto\n' });
  assert.notEqual(await fingerprint(porcelain('?? src/a.ts', '?? pkg/.sdlc-codex/a.txt'), dir), base);
});

test('R5-06: excludeRoots é ADITIVO (.sdlc-codex sempre excluído), aceita diretório ou arquivo exato e normaliza componentes', async () => {
  const dir = await tmpRepo();
  await put(dir, {
    'src/a.ts': 'a\n', 'tmp-out/x': '1', 'docs/spec/a.md': 'd', 'docs/exact.md': 'e', 'docs/exact.md.bak': 'b', 'docs/keep.md': 'k', '.sdlc-codex/s.json': '{}',
  });
  const kept = ['?? src/a.ts', '?? docs/keep.md', '?? docs/exact.md.bak']; // .bak é irmão de prefixo do arquivo exato: NÃO pode sair
  const base = await fingerprint(porcelain(...kept), dir);
  const full = porcelain(...kept, '?? tmp-out/x', '?? docs/spec/a.md', '?? docs/exact.md', '?? .sdlc-codex/s.json');
  assert.notEqual(await fingerprint(full, dir), base, 'sem extras, o que não é padrão entra');
  const extras = { excludeRoots: ['./tmp-out//', 'docs\\spec', 'docs/exact.md'] };
  assert.equal(await fingerprint(full, dir, '', extras), base, 'diretório, arquivo exato e .sdlc-codex (padrão) excluídos; homônimo de prefixo permanece');
  // case-insensitive só no win32 (Git preserva o caso; o filesystem não distingue)
  const upper = await fingerprint(porcelain(...kept, '?? docs/spec/a.md'), dir, '', { excludeRoots: ['DOCS/SPEC'] });
  assert.equal(upper === base, process.platform === 'win32');
});

test('R5-06: excludeRoots inválido (vazio, absoluto, com "..") é erro de programação, não falha de captura', async () => {
  const dir = await tmpRepo();
  for (const bad of ['', '.', '..', '../x', 'a/../b', '/abs', '\\abs', 'C:/x']) {
    await assert.rejects(tryCaptureCodeSnapshot(gitFake(''), dir, { excludeRoots: [bad] }), TypeError, `excludeRoots '${bad}'`);
  }
});

test('R5-06: o commit NÃO entra no fingerprint — mesma árvore relativa ao HEAD em commits distintos => mesmo fingerprint', async () => {
  const dir = await tmpRepo();
  await put(dir, { 'src/a.ts': 'x\n' });
  const status = porcelain(' M src/a.ts');
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n+x\n';
  const c1 = await captureCodeSnapshot(gitFake(status, diff), dir);
  const other = new GitFake({ head: 'def4567', status, diff });
  const c2 = await captureCodeSnapshot(other, dir);
  assert.notEqual(c1.commit, c2.commit);
  assert.equal(c1.diffFingerprint, c2.diffFingerprint);
});

test('R5-04: inventário vazio não depende do cwd existir no disco (worktree fake) — saídas vazias e exit 0 => ok', async () => {
  const dir = join(await tmpRepo(), 'worktree-que-nao-existe');
  const r = await tryCaptureCodeSnapshot(gitFake('', ''), dir);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.inventory, []);
  assert.equal(r.snapshot.commit, HEAD);
  // com entradas a ler, o cwd inexistente continua falhando fechado
  const withEntry = await tryCaptureCodeSnapshot(gitFake(porcelain('?? a.ts')), dir);
  assert.equal(withEntry.ok, false);
  if (!withEntry.ok) assert.equal(withEntry.code, 'read-failed');
});

test('R5-06: hash é de BYTES (binário; sequências UTF-8 inválidas distintas não colidem)', async () => {
  const dir = await tmpRepo();
  const status = porcelain('?? a.bin');
  await put(dir, { 'a.bin': Buffer.from([0, 1, 2, 0xff, 4]) });
  const f1 = await fingerprint(status, dir);
  await put(dir, { 'a.bin': Buffer.from([0, 1, 2, 0xfe, 4]) }); // 0xff e 0xfe decodificam ambos para U+FFFD como texto
  assert.notEqual(await fingerprint(status, dir), f1);
  await put(dir, { 'a.bin': Buffer.from([0, 1, 2, 0xff, 4]) });
  assert.equal(await fingerprint(status, dir), f1, 'mesmos bytes => mesmo fingerprint');
});

test('R5-06: a ORDEM do inventário não altera o fingerprint; inventário sai ordenado por bytes do caminho', async () => {
  const dir = await tmpRepo();
  await put(dir, { 'b.ts': 'b', 'a.ts': 'a', 'Z.ts': 'z', 'é.ts': 'e', 'src/m.ts': 'm' });
  const forward = porcelain(' M a.ts', ' M b.ts', '?? Z.ts', '?? é.ts', '?? src/m.ts');
  const shuffled = porcelain('?? src/m.ts', '?? é.ts', ' M b.ts', '?? Z.ts', ' M a.ts');
  const r1 = await tryCaptureCodeSnapshot(gitFake(forward), dir);
  const r2 = await tryCaptureCodeSnapshot(gitFake(shuffled), dir);
  assert.ok(r1.ok && r2.ok);
  assert.equal(r1.snapshot.diffFingerprint, r2.snapshot.diffFingerprint);
  assert.deepEqual(r1.inventory.map(e => e.path), ['Z.ts', 'a.ts', 'b.ts', 'src/m.ts', 'é.ts']);
});

test('R5-06: nomes adversos (espaço, acento, apóstrofo; tab/LF/aspas via -z) preservados no inventário', async () => {
  const dir = await tmpRepo();
  // Windows recusa tab/LF/aspas duplas no nome (probe): esses vão como REMOÇÕES, que não exigem o FS,
  // e provam o parser -z; espaço/acento/apóstrofo existem de verdade e têm o conteúdo hasheado.
  await put(dir, { 'nome com espaço.txt': 'e\n', 'acentuação-çãõ.txt': 'a\n', "apos'trofo.txt": 'p\n' });
  const removed = ['com\ttab.txt', 'com\nquebra.txt', 'aspas"duplas.txt', 'dois  espaços .txt'];
  const status = porcelain('?? nome com espaço.txt', '?? acentuação-çãõ.txt', "?? apos'trofo.txt", ...removed.map(p => ` D ${p}`));
  const r = await tryCaptureCodeSnapshot(gitFake(status), dir);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(new Set(r.inventory.map(e => e.path)), new Set(['nome com espaço.txt', 'acentuação-çãõ.txt', "apos'trofo.txt", ...removed]));
  assert.equal(r.inventory.filter(e => e.type === 'deleted').length, 4);
  const before = r.snapshot.diffFingerprint;
  await writeFile(join(dir, 'acentuação-çãõ.txt'), 'a2\n');
  assert.notEqual(await fingerprint(status, dir), before, 'conteúdo de arquivo com acento conta (git quoted não é usado)');
});

test('R5-06: fixture REAL da sonda (git 2.51.1, --no-renames) percorre todos os tipos de entrada', async () => {
  const dir = await tmpRepo();
  // status copiado de m2-git-format-probe.log ("v1 -z all --no-renames"), sem link-file/junction-out (cobertos em snapshot-fs).
  const status = porcelain(
    'A  copy-of-big.ts', 'AM renamed.txt', ' M src/a.ts', 'A  src/staged.ts', 'MM src/tracked.ts', 'D  to-delete.txt', 'D  to-rename.txt',
    '?? acentuação-çãõ.txt', "?? apos'trofo.txt", '?? binario.bin', '?? dist/out.js', '?? logs/run.log', '?? nested/', '?? newsrc/a.ts',
    '?? newsrc/b.ts', '?? newsrc/deep/c.ts', '?? nome com espaço.txt', '?? produto.log', '?? src/other/a.ts', '?? .sdlc-codex/state.json',
  );
  await put(dir, {
    'copy-of-big.ts': 'c', 'renamed.txt': 'r', 'src/a.ts': 'two\n', 'src/staged.ts': 's', 'src/tracked.ts': 'v3', 'acentuação-çãõ.txt': 'a',
    "apos'trofo.txt": 'p', 'binario.bin': Buffer.from([0, 255, 0, 128, 7]), 'dist/out.js': 'x', 'logs/run.log': 'x', 'nested/n.txt': 'n',
    'newsrc/a.ts': 'one\n', 'newsrc/b.ts': 'b', 'newsrc/deep/c.ts': 'c', 'nome com espaço.txt': 'e', 'produto.log': 'l', 'src/other/a.ts': 'h',
    '.sdlc-codex/state.json': '{}',
  });
  await mkdir(join(dir, 'nested'), { recursive: true });
  const r = await tryCaptureCodeSnapshot(gitFake(status), dir);
  assert.ok(r.ok, JSON.stringify(r));
  const byPath = new Map(r.inventory.map(e => [e.path, e]));
  assert.equal(r.inventory.length, 19, '20 registros - 1 operacional');
  assert.equal(byPath.get('to-delete.txt')?.type, 'deleted');
  assert.equal(byPath.get('nested/')?.type, 'directory');
  assert.equal(byPath.get('src/tracked.ts')?.status, 'MM');
  assert.equal(byPath.get('binario.bin')?.type, 'file');
  assert.equal(byPath.has('.sdlc-codex/state.json'), false);
  assert.match(byPath.get('src/a.ts')!.hash, /^[0-9a-f]{64}$/);
});
