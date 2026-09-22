import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../../src/state/store.js';

// Revisão independente A / F1 — lockStatus() (usado pelo doctor) é SOMENTE LEITURA: nunca cria a raiz
// do estado nem seus diretórios-pai, mesmo em projeto não adotado.

test('R5-02 lockStatus sobre raiz inexistente não cria diretório algum (nem os pais)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sdlc-lockstatus-'));
  const root = join(base, 'sub', 'nao-adotado', '.sdlc-codex');
  const status = await new StateStore(root).lockStatus();
  assert.deepEqual(status, { held: 'no', leftovers: [] });
  await assert.rejects(() => stat(join(base, 'sub')), /ENOENT/, 'nenhum diretório-pai foi criado');
  assert.deepEqual(await readdir(base), [], 'o disco não mudou');
});

test('R5-02 lockStatus sobre raiz existente também não altera o disco', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-lockstatus-'));
  const before = await readdir(root);
  const status = await new StateStore(root).lockStatus();
  assert.equal(status.held, 'no');
  assert.deepEqual(await readdir(root), before);
});

test('R5-02 lockStatus classifica falha de acesso como unknown, não como detentor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-lockstatus-'));
  const store = new StateStore(root, { projectId: 'status-permission' });
  await store.init('status-permission');
  const originalOpen = fsp.open;
  t.after(() => { (fsp as unknown as Record<string, unknown>).open = originalOpen; });
  (fsp as unknown as Record<string, unknown>).open = (async (path: unknown, ...args: unknown[]) => {
    if (String(path).endsWith('state.authority.lock')) {
      throw Object.assign(new Error('acesso negado simulado'), { code: 'EACCES' });
    }
    return originalOpen.call(fsp, path as never, ...(args as never[]));
  }) as never;

  const status = await store.lockStatus();
  assert.equal(status.held, 'unknown');
});
