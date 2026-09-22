import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexTransport, parseQueueReceipt } from '../../src/adapters/codex.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';

function okJson(thread: string, id: string) {
  return new FakeProcessRunner(() => ({ exitCode: 0, stdout: JSON.stringify({ status: 'accepted', threadId: thread, nativeMessageId: id }), stderr: '', timedOut: false, acceptedBeforeTimeout: false }));
}

test('queue só confia em receipt estruturado correspondente', async () => {
  const runner = okJson('t1', 'm1');
  const out = await new CodexTransport(runner, 'fake').queue('t1', 'body');
  assert.equal(out.status, 'enqueued');
  assert.equal(out.receipt?.nativeMessageId, 'm1');
  assert.deepEqual(runner.calls[0].args, ['queue', '--thread', 't1', '--message', 'body']);
});

// R08: receipt textual observado "Queued message <id> for thread <id>."
test('receipt textual Queued message é reconhecido', async () => {
  const runner = new FakeProcessRunner(() => ({ exitCode: 0, stdout: 'Queued message msg-42 for thread t-9.', stderr: '', timedOut: false, acceptedBeforeTimeout: false }));
  const out = await new CodexTransport(runner).queue('t-9', 'x');
  assert.equal(out.status, 'enqueued');
  assert.equal(out.receipt?.nativeMessageId, 'msg-42');
});

test('thread divergente no receipt vira uncertain', () => {
  assert.equal(parseQueueReceipt('t1', 'Queued message m for thread OUTRA.'), undefined);
  assert.equal(parseQueueReceipt('t1', JSON.stringify({ status: 'accepted', threadId: 'outra', nativeMessageId: 'm' })), undefined);
});

test('exit zero sem receipt é uncertain; nonzero é failed', async () => {
  const u = new FakeProcessRunner(() => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, acceptedBeforeTimeout: false }));
  assert.equal((await new CodexTransport(u).queue('t', 'x')).status, 'uncertain');
  const f = new FakeProcessRunner(() => ({ exitCode: 7, stdout: '', stderr: 'bad', timedOut: false, acceptedBeforeTimeout: false }));
  assert.equal((await new CodexTransport(f).queue('t', 'x')).status, 'failed');
});

// M2-F2: timeout é SEMPRE uncertain (desfecho desconhecido — a mensagem pode
// ter sido enfileirada; nunca failed que induziria retry cego, e nunca
// enqueued sem receipt completo). A evidência de aceitação é ESTRITA
// (parseQueueReceipt no formato real), não a heurística solta /accept/i.
test('M2-F2: timeout com receipt observado na saída é uncertain com motivo de aceitação', async () => {
  const a = new FakeProcessRunner(() => ({ exitCode: null, stdout: 'Queued message nat-9 for thread t.', stderr: '', timedOut: true, acceptedBeforeTimeout: false }));
  const out = await new CodexTransport(a).queue('t', 'x');
  assert.equal(out.status, 'uncertain');
  assert.match(out.reason ?? '', /receipt de aceitação/);
});

test('M2-F2: timeout sem receipt é uncertain (sem retry presumido)', async () => {
  const b = new FakeProcessRunner(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true, acceptedBeforeTimeout: false }));
  const out = await new CodexTransport(b).queue('t', 'x');
  assert.equal(out.status, 'uncertain');
  assert.match(out.reason ?? '', /desfecho desconhecido/);
});

// M2-F2: texto com a palavra "accepted" mas SEM receipt estruturado nunca
// vira sucesso — a heurística solta foi removida do transporte.
test('M2-F2: stdout solto com "accepted" sem receipt não produz enqueued', async () => {
  const runner = new FakeProcessRunner(() => ({ exitCode: 0, stdout: 'message accepted by daemon', stderr: '', timedOut: false, acceptedBeforeTimeout: true }));
  const out = await new CodexTransport(runner).queue('t', 'x');
  assert.equal(out.status, 'uncertain');
  assert.equal(out.receipt, undefined);
});

// M2-F2: falha de SPAWN (exceção do runner) nunca vira enqueued.
test('M2-F2: erro de transporte (runner rejeita) é failed com motivo', async () => {
  const runner = new FakeProcessRunner(() => { throw new Error('spawn ENOENT'); });
  const out = await new CodexTransport(runner).queue('t', 'x');
  assert.equal(out.status, 'failed');
  assert.match(out.reason ?? '', /falha ao iniciar processo/);
});

test('threadId vazio nunca é inferido: failed explícito', async () => {
  const out = await new CodexTransport(okJson('t', 'm')).queue('', 'x');
  assert.equal(out.status, 'failed');
});

// Sondas reais contra o CLI instalado foram movidas para tests/live/ (opt-in
// SDLC_LIVE=1): a suíte padrão nunca invoca Codex/Herdr reais, mesmo com UUID
// inexistente (C01).
