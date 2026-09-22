import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findProjectRoot } from '../../src/project/config.js';
import { GitAdapter } from '../../src/adapters/git.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { ProcessResult } from '../../src/adapters/process.js';

const OK = (stdout = ''): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, acceptedBeforeTimeout: false });

async function projectWithConfig(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, '.sdlc-codex'), { recursive: true });
  await writeFile(join(root, '.sdlc-codex', 'config.json'), JSON.stringify({
    schemaVersion: 1, projectId: '11111111-2222-3333-4444-555555555555', projectName: 'P', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'],
  }));
  return root;
}

test('resolve a raiz a partir de subdiretório (ascendência, sem Git)', async () => {
  const root = await projectWithConfig('sdlc-root-sub-');
  const sub = join(root, 'src', 'deep');
  await mkdir(sub, { recursive: true });
  assert.equal(resolve(await findProjectRoot(sub)), resolve(root));
  assert.equal(resolve(await findProjectRoot(root)), resolve(root));
});

test('worktree EXTERNO à árvore: raiz principal localizada via Git somente leitura', async () => {
  const main = await projectWithConfig('sdlc-root-main-');
  const external = await mkdtemp(join(tmpdir(), 'sdlc-root-ext-'));
  const git = {
    root: async () => external,
    worktreeList: async () => `worktree ${external}\nbranch refs/heads/sdlc/x\n\nworktree ${main}\nbranch refs/heads/main\n`,
  };
  // A partir da raiz do worktree externo...
  assert.equal(resolve(await findProjectRoot(external, { git })), resolve(main));
  // ...e a partir de um SUBDIRETÓRIO dentro dele.
  const nested = join(external, 'pacote', 'modulo');
  await mkdir(nested, { recursive: true });
  assert.equal(resolve(await findProjectRoot(nested, { git })), resolve(main));
});

test('worktree externo com Git indisponível: comportamento legado (devolve o início, sem throw)', async () => {
  const external = await mkdtemp(join(tmpdir(), 'sdlc-root-nogit-'));
  const git = {
    root: async () => { throw new Error('não é um repositório git'); },
    worktreeList: async () => { throw new Error('sem git'); },
  };
  assert.equal(resolve(await findProjectRoot(external, { git })), resolve(external));
});

test('dois checkouts com .sdlc-codex no mesmo repositório: ambiguidade é erro, não adivinhação', async () => {
  const mainA = await projectWithConfig('sdlc-root-ambA-');
  const mainB = await projectWithConfig('sdlc-root-ambB-');
  const external = await mkdtemp(join(tmpdir(), 'sdlc-root-ambext-'));
  const git = {
    root: async () => external,
    worktreeList: async () => `worktree ${external}\n\nworktree ${mainA}\n\nworktree ${mainB}\n`,
  };
  await assert.rejects(() => findProjectRoot(external, { git }), /ambígua/);
});

test('GitAdapter real com runner falso: argv exato do contrato somente leitura', async () => {
  const calls: string[][] = [];
  const external = await mkdtemp(join(tmpdir(), 'sdlc-root-argv-'));
  const main = await projectWithConfig('sdlc-root-argvmain-');
  const git = new GitAdapter(new FakeProcessRunner((_e, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return OK(`${external}\n`);
    if (args[0] === 'worktree') return OK(`worktree ${external}\n\nworktree ${main}\n`);
    return OK();
  }));
  assert.equal(resolve(await findProjectRoot(external, { git })), resolve(main));
  assert.deepEqual(calls[0], ['rev-parse', '--show-toplevel']);
  assert.deepEqual(calls[1], ['worktree', 'list', '--porcelain']);
  // Nenhuma operação Git mutável: só leitura.
  assert.ok(calls.every(c => ['rev-parse', 'worktree'].includes(c[0])));
});

test('caminhos com espaços e acentos resolvem corretamente', async () => {
  const root = await projectWithConfig('sdlc código áü root-');
  const sub = join(root, 'pasta com espaços', 'módulo');
  await mkdir(sub, { recursive: true });
  assert.equal(resolve(await findProjectRoot(sub)), resolve(root));
});
