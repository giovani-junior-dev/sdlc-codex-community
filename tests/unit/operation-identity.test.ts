import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, computePayloadHash, operationIdentityOf, sameOperationIdentity, type OperationPayload } from '../../src/pipeline/operation-identity.js';

const actor = { role: 'dev' as const, threadId: 't1', generationId: 'g1', projectId: 'p1' };
const base = (): OperationPayload => ({
  projectId: 'p1', runId: 'r1', stage: 'pr', operationId: 'op1', baseRevision: 3,
  actor,
  content: { verdict: 'pass', gapId: undefined, blockedReason: undefined, expectedCommit: undefined, evidenceFileHash: 'aaa' },
});

test('canonicalize é estável: ordem de chaves e undefined não alteram o resultado', () => {
  const a = canonicalize({ b: 2, a: 1, c: undefined });
  const b = canonicalize({ c: undefined, a: 1, b: 2 });
  assert.equal(a, b);
  assert.equal(canonicalize({ list: [{ y: 1, x: 2 }] }), canonicalize({ list: [{ x: 2, y: 1 }] }));
});

test('mesmo operationId com payload idêntico produz o mesmo hash (replay legítimo)', () => {
  assert.equal(computePayloadHash(base()), computePayloadHash(base()));
  const i1 = operationIdentityOf(base());
  const i2 = operationIdentityOf(base());
  assert.ok(sameOperationIdentity(i1, i2));
});

test('qualquer mudança semântica muda o payloadHash (conflito)', () => {
  const variants: Array<[string, (p: OperationPayload) => OperationPayload]> = [
    ['veredito', p => ({ ...p, content: { ...p.content, verdict: 'fail' } })],
    ['runId', p => ({ ...p, runId: 'r2' })],
    ['estágio', p => ({ ...p, stage: 'build' })],
    ['revisão-base', p => ({ ...p, baseRevision: 4 })],
    ['ator geração', p => ({ ...p, actor: { ...actor, generationId: 'g2' } })],
    ['ator papel', p => ({ ...p, actor: { ...actor, role: 'reviewer' } })],
    ['gapId', p => ({ ...p, content: { ...p.content, gapId: 'REQ-9' } })],
    ['commit esperado', p => ({ ...p, content: { ...p.content, expectedCommit: 'abc' } })],
    ['conteúdo do arquivo de evidências', p => ({ ...p, content: { ...p.content, evidenceFileHash: 'bbb' } })],
  ];
  const original = computePayloadHash(base());
  for (const [name, mutate] of variants) {
    assert.notEqual(computePayloadHash(mutate(base())), original, `${name} deve mudar o hash`);
    assert.equal(sameOperationIdentity(operationIdentityOf(base()), operationIdentityOf(mutate(base()))), false, `${name} não é mesma identidade`);
  }
});

test('campos ausentes vs undefined canonicalizam igual (robustez de payload)', () => {
  const withUndef = base();
  const without = base();
  delete (without.content as Record<string, unknown>).gapId;
  assert.equal(computePayloadHash(withUndef), computePayloadHash(without));
});
