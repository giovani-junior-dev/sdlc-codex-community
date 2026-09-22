import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRuntime, validateRuntime, STAGES, type Runtime, type Stage } from '../../src/contracts.js';

// R5-11 — relações obrigatórias do schema: operação aceita exige runId+revisão coerentes
// (ou marca 'legacy' de migração explícita); linkedTaskMessageId aponta task do mesmo run.

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const now = () => new Date().toISOString();
const attemptsZero = (): Record<Stage, number> => Object.fromEntries(STAGES.map(s => [s, 0])) as Record<Stage, number>;

function base(): Runtime {
  const r = emptyRuntime(UUID);
  r.revision = 3;
  r.runs = [
    { runId: 'r1', slug: 's1', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'review', revision: 1, attempts: attemptsZero(), gapFailures: {}, status: 'running', history: [] },
    { runId: 'r2', slug: 's2', workflow: 'feature', intentPath: 'i', planPath: 'p', stage: 'build', revision: 0, attempts: attemptsZero(), gapFailures: {}, status: 'done', history: [] },
  ];
  const msg = (messageId: string, type: 'task' | 'question' | 'answer' | 'notify', extra: Record<string, unknown> = {}) => ({
    messageId, projectId: UUID, runId: 'r1', from: 'planner', to: 'dev', targetThreadId: 't', targetGenerationId: 'g',
    type, body: 'x', createdAt: now(), ...extra,
  }) as Runtime['messages'][number];
  r.messages = [
    msg('task1', 'task', { stage: 'review', revision: 1 }),
    msg('notify1', 'notify'),
    msg('q1', 'question', { from: 'dev', to: 'planner' }),
    msg('task-other-run', 'task', { runId: 'r2' }),
  ];
  r.deliveries = r.messages.map(m => ({ deliveryId: `d-${m.messageId}`, messageId: m.messageId, status: 'pending' as const, updatedAt: now() }));
  r.operations = { op1: { operationId: 'op1', accepted: true, status: 'running', runId: 'r1', revision: 1 } };
  return r;
}

test('R5-11 operação aceita sem runId é rejeitada', () => {
  const r = base();
  r.operations = { op1: { operationId: 'op1', accepted: true, status: 'running', revision: 1 } };
  assert.throws(() => validateRuntime(r), /operations\[op1\].*runId/);
});

test('R5-11 operação aceita sem revisão é rejeitada', () => {
  const r = base();
  r.operations = { op1: { operationId: 'op1', accepted: true, status: 'running', runId: 'r1' } };
  assert.throws(() => validateRuntime(r), /operations\[op1\].*revis/);
});

test('R5-11 operação aceita com revisão maior que a da execução é incoerente', () => {
  const r = base();
  r.operations = { op1: { operationId: 'op1', accepted: true, status: 'running', runId: 'r1', revision: 9 } };
  assert.throws(() => validateRuntime(r), /operations\[op1\].*revis/);
});

test('R5-11 operação aceita completa e coerente é válida', () => {
  assert.doesNotThrow(() => validateRuntime(base()));
});

test('R5-11 operação legada marcada (migração explícita) sem runId é lida, mas continua marcada', () => {
  const r = base();
  r.operations = { old: { operationId: 'old', accepted: true, status: 'done', provenance: 'legacy' } };
  const v = validateRuntime(r);
  assert.equal(v.operations.old.provenance, 'legacy');
});

test('R5-11 provenance desconhecida é rejeitada', () => {
  const r = base();
  (r.operations.op1 as unknown as Record<string, unknown>).provenance = 'moderna';
  assert.throws(() => validateRuntime(r), /provenance/);
});

test('R5-11 linkedTaskMessageId apontando notify é rejeitado', () => {
  const r = base();
  r.messages.find(m => m.messageId === 'q1')!.linkedTaskMessageId = 'notify1';
  assert.throws(() => validateRuntime(r), /linkedTaskMessageId.*task/);
});

test('R5-11 linkedTaskMessageId apontando question é rejeitado', () => {
  const r = base();
  r.messages.find(m => m.messageId === 'notify1')!.linkedTaskMessageId = 'q1';
  assert.throws(() => validateRuntime(r), /linkedTaskMessageId.*task/);
});

test('R5-11 linkedTaskMessageId apontando task de outro run é rejeitado', () => {
  const r = base();
  r.messages.find(m => m.messageId === 'q1')!.linkedTaskMessageId = 'task-other-run';
  assert.throws(() => validateRuntime(r), /linkedTaskMessageId.*(run|execu)/);
});

test('R5-11 linkedTaskMessageId de uma task para si mesma / task com vínculo é rejeitado', () => {
  const r = base();
  r.messages.find(m => m.messageId === 'task1')!.linkedTaskMessageId = 'task1';
  assert.throws(() => validateRuntime(r), /linkedTaskMessageId/);
});

test('R5-11 linkedTaskMessageId apontando task do mesmo run é aceito', () => {
  const r = base();
  r.messages.find(m => m.messageId === 'q1')!.linkedTaskMessageId = 'task1';
  assert.doesNotThrow(() => validateRuntime(r));
});

// Revisão independente A / F4 — a marca 'legacy' só descreve operação SEM identificação completa.
test('R5-11 provenance legacy em operação que já tem runId e revisão é rejeitada', () => {
  const r = base();
  r.operations = { op1: { operationId: 'op1', accepted: true, status: 'running', runId: 'r1', revision: 1, provenance: 'legacy' } };
  assert.throws(() => validateRuntime(r), /legacy.*incompat/);
});
