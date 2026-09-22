import test from 'node:test';
import assert from 'node:assert/strict';
import { GitAdapter, parseWorktreeList } from '../../src/adapters/git.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { ProcessResult } from '../../src/adapters/process.js';

const OK = (stdout = ''): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, acceptedBeforeTimeout: false });

// C07: substring de path NÃO é prova de worktree — igualdade exata normalizada.
test('ensureWorktree cria quando só existe caminho com substring semelhante', async () => {
  const calls: string[][] = [];
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => {
    calls.push(args);
    if (args[0] === 'worktree' && args[1] === 'list') {
      return OK('worktree C:/proj/wt-extra\nbranch refs/heads/outra\n\n');
    }
    if (args[0] === 'show-ref') return { exitCode: 1, stdout: '', stderr: 'not found', timedOut: false, acceptedBeforeTimeout: false };
    return OK('');
  }));
  const outcome = await git.ensureWorktree('C:\\proj', 'C:\\proj\\wt', 'sdlc/x', 'main');
  assert.equal(outcome, 'created', 'C:\\proj\\wt-extra não autoriza reuso de C:\\proj\\wt');
  const add = calls.find(c => c[0] === 'worktree' && c[1] === 'add')!;
  assert.deepEqual(add.slice(2), ['-b', 'sdlc/x', 'C:\\proj\\wt', 'main']);
});

// C07: reuso exato verifica branch e base antes de devolver 'reused'.
test('ensureWorktree reutiliza somente com path, branch e base compatíveis', async () => {
  const calls: string[][] = [];
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => {
    calls.push(args);
    if (args[0] === 'worktree' && args[1] === 'list') {
      return OK('worktree C:/proj/wt\nbranch refs/heads/sdlc/x\n\nworktree C:/proj\nbranch refs/heads/main\n\n');
    }
    return OK('');
  }));
  const outcome = await git.ensureWorktree('C:\\proj', 'c:\\PROJ\\wt\\', 'sdlc/x', 'main');
  assert.equal(outcome, 'reused', 'igualdade normalizada (case/separadores/trailing)');
  assert.ok(calls.some(c => c[0] === 'merge-base' && c[1] === '--is-ancestor' && c[2] === 'main'), 'base conferida como ancestral do HEAD do worktree');
  assert.ok(!calls.some(c => c[0] === 'worktree' && c[1] === 'add'), 'nenhum add em reuso');
});

// C07: branch divergente no worktree existente é colisão incompatível.
test('ensureWorktree recusa worktree existente com branch divergente', async () => {
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => {
    if (args[0] === 'worktree' && args[1] === 'list') return OK('worktree C:/proj/wt\nbranch refs/heads/outra-branch\n\n');
    return OK('');
  }));
  await assert.rejects(() => git.ensureWorktree('C:\\proj', 'C:\\proj\\wt', 'sdlc/x', 'main'), /colisão incompatível/);
});

// C07: base que não é ancestral do HEAD do worktree é colisão incompatível.
test('ensureWorktree recusa worktree que não deriva da base configurada', async () => {
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => {
    if (args[0] === 'worktree' && args[1] === 'list') return OK('worktree C:/proj/wt\nbranch refs/heads/sdlc/x\n\n');
    if (args[0] === 'merge-base') return { exitCode: 1, stdout: '', stderr: 'not ancestor', timedOut: false, acceptedBeforeTimeout: false };
    return OK('');
  }));
  await assert.rejects(() => git.ensureWorktree('C:\\proj', 'C:\\proj\\wt', 'sdlc/x', 'main'), /não deriva da base/);
});

// C07: branch já existe sem worktree correspondente continua sendo erro explicativo.
test('ensureWorktree recusa criar quando a branch já existe', async () => {
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => {
    if (args[0] === 'worktree' && args[1] === 'list') return OK('');
    if (args[0] === 'show-ref') return OK('abc refs/heads/sdlc/x');
    return OK('');
  }));
  await assert.rejects(() => git.ensureWorktree('C:\\proj', 'C:\\proj\\wt', 'sdlc/x', 'main'), /branch sdlc\/x já existe/);
});

test('parseWorktreeList lê blocos porcelana com branch opcional', () => {
  const entries = parseWorktreeList('worktree C:/a\nbranch refs/heads/x\nbare\n\nworktree C:/b\n\ndetached\n');
  assert.deepEqual(entries, [
    { path: 'C:/a', branch: 'refs/heads/x' },
    { path: 'C:/b', branch: undefined },
  ]);
});
