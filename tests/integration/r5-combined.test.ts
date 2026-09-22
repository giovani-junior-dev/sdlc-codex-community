import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { World } from './r5-harness.js';

// M6-F1 — combinações de falhas: as garantias NÃO dependem da ordem incidental das
// validações (qualquer subconjunto de fatos ausentes/adulterados reprova, sem efeito externo).

test('R5-03+R5-04+R5-05 snapshot indisponível + manifesto adulterado: rejeitado em qualquer ordem, zero efeito', async () => {
  const w = await World.create();
  await w.boot();
  await w.seedStage('pr');
  const c = await w.check('pr');
  const file = await w.rubric('pr', w.rubricIds('pr'), c.payload.snapshot);
  // manifesto adulterado depois do start
  const m = JSON.parse(await readFile(join(w.root, 'requirements.json'), 'utf8')) as { entries: Array<Record<string, unknown>> };
  m.entries[0].mandatory = false;
  await writeFile(join(w.root, 'requirements.json'), JSON.stringify(m));
  // ... e o Git indisponível ao mesmo tempo
  w.edges.gitFail.add('status');
  const before = await w.fingerprintState();
  const r = await w.next('pr', 'pass', file);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(w.edges.ghCreateCalls, 0);
  assert.equal(w.edges.ghListCalls, 0);
  assert.deepEqual(await w.fingerprintState(), before);
  // restaurar SÓ o Git: o manifesto adulterado continua reprovando
  w.edges.gitFail.clear();
  const r2 = await w.next('pr', 'pass', file);
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /manifesto/i);
  assert.equal(w.edges.ghCreateCalls, 0);
  assert.deepEqual(await w.fingerprintState(), before);
});

test('R5-03+R5-05 config vazia + rubrica sem proveniência + PR fechada: cada fato ausente reprova sozinho', async () => {
  const w = await World.create({ checks: 'none' });
  await w.boot();
  await w.seedStage('pr');
  const before = await w.fingerprintState();
  for (const omit of [undefined, 'producer', 'projectId', 'snapshot'] as const) {
    const r = await w.pass('pr', { skipCheck: true, omit });
    assert.notEqual(r.code, 0, `omit=${String(omit)}: ${r.out}`);
  }
  assert.equal(w.edges.ghCreateCalls, 0);
  assert.equal((await w.fingerprintState()).stage, before.stage);
});

test('R5-11 operationId legado (sem runId/revisão) nunca é replay aceito: conflito sem gravar nem avançar', async () => {
  const w = await World.create();
  await w.boot();
  await w.store().mutate(s => ({
    state: { ...s, operations: { ...s.operations, 'op-legado': { operationId: 'op-legado', accepted: true, status: 'running', provenance: 'legacy' as const } } },
    result: undefined,
  }));
  const c = await w.check('build');
  const file = await w.rubric('build', w.rubricIds('build'), c.payload.snapshot);
  const before = await w.fingerprintState();
  const r = await w.next('build', 'pass', file, [], 'op-legado');
  assert.equal(r.code, 3, `${r.out} ${r.err}`);
  assert.match(r.err, /legado/i);
  assert.deepEqual(await w.fingerprintState(), before, 'nada gravado, nada avançou');
  // com operationId novo o fluxo moderno completo segue normal
  const ok = await w.next('build', 'pass', file, [], 'op-novo');
  assert.equal(ok.code, 0, ok.err);
});

test('R5-11 estado persistido com operação aceita moderna sem runId é recusado na leitura (store)', async () => {
  const w = await World.create();
  await w.boot();
  const path = join(w.root, '.sdlc-codex', 'runtime.json');
  const raw = JSON.parse(await readFile(path, 'utf8')) as { operations: Record<string, unknown> };
  raw.operations['op-x'] = { operationId: 'op-x', accepted: true, status: 'running', revision: 1 };
  await writeFile(path, JSON.stringify(raw));
  await assert.rejects(() => w.state(), /runId|operations\[op-x\]|inválid/i);
});
