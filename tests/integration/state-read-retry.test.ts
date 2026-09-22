import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateCorruptError, StateStore } from '../../src/state/store.js';

// Leitura concorrente com a troca atômica (rename) do escritor: no Windows a leitura pode falhar de forma TRANSITÓRIA
// (EPERM/EBUSY/EACCES). O store faz retry DELIMITADO; esgotado, a falha é explícita (StateCorruptError) — nunca "ausente".
// Determinístico: EPERM injetado em fs.promises.readFile só para runtime.json (origem dos flakes de leitura observados).

async function withReadFailures<T>(failTimes: number, body: () => Promise<T>): Promise<{ result: T; injected: number }> {
  const original = fsp.readFile;
  let injected = 0;
  (fsp as { readFile: unknown }).readFile = (async (path: unknown, options: unknown) => {
    if (String(path).endsWith('runtime.json') && injected < failTimes) {
      injected++;
      throw Object.assign(new Error('EPERM: operation not permitted (injetado)'), { code: 'EPERM' });
    }
    return original.call(fsp, path as never, options as never);
  }) as typeof fsp.readFile;
  try { return { result: await body(), injected }; }
  finally { (fsp as { readFile: unknown }).readFile = original; }
}

test('R5-01 leitura do runtime com EPERM transitório é REINTENTADA e devolve o estado íntegro', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-read-retry-'));
  const store = new StateStore(root, { projectId: 'p-read' });
  await store.init('p-read');
  const { result, injected } = await withReadFailures(3, () => store.read());
  assert.equal(injected, 3, 'três falhas transitórias injetadas');
  assert.equal(result.projectId, 'p-read');
});

test('R5-01 EPERM que persiste além do limite vira StateCorruptError explícito (nunca estado ausente)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-read-retry-'));
  const store = new StateStore(root, { projectId: 'p-read' });
  await store.init('p-read');
  const { injected, result } = await withReadFailures(1000, async () => {
    try { await store.read(); return 'leu'; } catch (e) { return e; }
  });
  assert.ok(result instanceof StateCorruptError, `esperado StateCorruptError, obtido ${String(result)}`);
  assert.match((result as Error).message, /falha de leitura.*EPERM/);
  assert.equal(injected, 6, 'seis tentativas (limite delimitado), não infinito');
});

// Verificação V1-6 — só EPERM/EBUSY/EACCES são reintentados; qualquer outro código falha na PRIMEIRA tentativa (nunca "ausente").
test('R5-01 código NÃO transitório (EISDIR/ENOTDIR/EMFILE) não é reintentado: falha explícita na 1ª tentativa', async () => {
  for (const code of ['EISDIR', 'ENOTDIR', 'EMFILE']) {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-read-retry-'));
    const store = new StateStore(root, { projectId: 'p-read' });
    await store.init('p-read');
    const original = fsp.readFile;
    let attempts = 0;
    (fsp as { readFile: unknown }).readFile = (async (path: unknown, options: unknown) => {
      if (String(path).endsWith('runtime.json')) { attempts++; throw Object.assign(new Error(`${code} (injetado)`), { code }); }
      return original.call(fsp, path as never, options as never);
    }) as typeof fsp.readFile;
    try { await assert.rejects(() => store.read(), (e: unknown) => e instanceof StateCorruptError && new RegExp(code).test((e as Error).message)); }
    finally { (fsp as { readFile: unknown }).readFile = original; }
    assert.equal(attempts, 1, `${code}: uma única tentativa`);
  }
});
