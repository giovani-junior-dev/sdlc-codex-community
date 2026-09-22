import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRuntime, type CodeSnapshot, type PrIntent } from '../../src/contracts.js';
import { appendPrIntent, findActivePrIntent, latestPrIntent, PrLedgerError, PR_INTENT_RESERVED, PR_INTENT_UPDATED } from '../../src/pipeline/pr-intents.js';

const snapshot: CodeSnapshot = { commit: 'abc', diffFingerprint: 'fp', capturedAt: '2026-09-19T00:00:00Z', source: 'git-readonly' };
const intent = (over: Partial<PrIntent> = {}): PrIntent => ({
  intentId: 'op-1', operationId: 'op-1', runId: 'run-1', repo: 'acme/feat',
  base: 'main', branch: 'sdlc/fx', headCommit: 'abc', snapshot,
  status: 'reserved', createdAt: '2026-09-19T00:00:00Z', ...over,
});

test('ledger: reserva e atualizações devolvem a versão mais recente por operationId', () => {
  let state = emptyRuntime('p');
  state = appendPrIntent(state, intent(), PR_INTENT_RESERVED);
  state = appendPrIntent(state, intent({ status: 'executed', result: { url: 'https://x/pr/1', number: 1, checkedAt: '2026-09-19T01:00:00Z' } }), PR_INTENT_UPDATED);
  state = appendPrIntent(state, intent({ operationId: 'op-2', intentId: 'op-2', status: 'reserved' }), PR_INTENT_RESERVED);
  const latest = latestPrIntent(state, 'op-1');
  assert.equal(latest?.status, 'executed');
  assert.equal(latest?.result?.url, 'https://x/pr/1');
  assert.equal(latestPrIntent(state, 'op-2')?.status, 'reserved');
  assert.equal(latestPrIntent(state, 'op-inexistente'), undefined);
});

// R5-08: eventos de OUTROS tipos são ignorados; evento de PR inválido NUNCA é ignorado (ignorar autorizaria
// nova publicação) — falha fechada com PrLedgerError.
test('ledger: eventos de outros tipos são ignorados; evento de PR inválido falha fechado (R5-08)', () => {
  let state = emptyRuntime('p');
  state = { ...state, events: [...state.events, { at: '2026-09-19T00:00:00Z', kind: 'transition', detail: '{não é intenção' }] };
  assert.equal(latestPrIntent(state, 'op-1'), undefined);
  assert.equal(findActivePrIntent(state, 'run-1'), undefined);
  const broken = { ...state, events: [...state.events, { at: '2026-09-19T00:00:00Z', kind: PR_INTENT_RESERVED, detail: '"texto solto"' }] };
  assert.throws(() => latestPrIntent(broken, 'op-1'), PrLedgerError);
  assert.throws(() => findActivePrIntent(broken, 'run-1'), PrLedgerError);
});

test('findActivePrIntent: confirmed não bloqueia; reserved/executed/uncertain/conflict de OUTRA operação bloqueiam (R5-08)', () => {
  let state = emptyRuntime('p');
  const seq = (op: string, statuses: PrIntent['status'][]) => statuses.forEach((status, i) => {
    state = appendPrIntent(state, intent({ operationId: op, intentId: op, status }), i === 0 ? PR_INTENT_RESERVED : PR_INTENT_UPDATED);
  });
  seq('op-antiga', ['reserved', 'executed', 'confirmed']);
  assert.equal(findActivePrIntent(state, 'run-1'), undefined, 'reserved→executed→confirmed reduz para confirmed: NÃO bloqueia');
  seq('op-conf', ['reserved', 'conflict']);
  assert.equal(findActivePrIntent(state, 'run-1')?.operationId, 'op-conf', 'conflict (efeito desconhecido) BLOQUEIA até reconciliação');
  state = appendPrIntent(state, intent({ operationId: 'op-conf', intentId: 'op-conf', status: 'confirmed' }), PR_INTENT_UPDATED);
  assert.equal(findActivePrIntent(state, 'run-1'), undefined, 'reconciliado por leitura → confirmed');
  seq('op-ativa', ['reserved']);
  assert.equal(findActivePrIntent(state, 'run-1')?.operationId, 'op-ativa');
  assert.equal(findActivePrIntent(state, 'run-1', 'op-ativa'), undefined, 'a própria operação reexecutada não conflita consigo');
  assert.equal(findActivePrIntent(state, 'outro-run'), undefined, 'outro run não é afetado');
});
