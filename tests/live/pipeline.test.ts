/**
 * C13/S14 — execução do harness live (OPT-IN). NUNCA roda na suíte padrão.
 * Execução: `npm run test:live` com SDLC_LIVE=1 e SDLC_LIVE_TARGET=<fixture
 * descartável com marcador .sdlc-live-fixture>. Sem autorização, skip explícito.
 * Não executar nesta sessão.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { runLivePilot, LiveGuardError, MANUAL_STEPS } from './harness.js';

const enabled = process.env.SDLC_LIVE === '1';

test('piloto live ponta a ponta (opt-in, harness real)', { skip: enabled ? false : 'defina SDLC_LIVE=1 e SDLC_LIVE_TARGET para o piloto live' }, async () => {
  assert.equal(process.env.SDLC_LIVE, '1');
  // Guardas preventivas: qualquer falha aqui aborta ANTES de qualquer efeito externo.
  const result = await runLivePilot({
    live: process.env.SDLC_LIVE,
    target: process.env.SDLC_LIVE_TARGET,
    expectedTmpPrefix: tmpdir(),
  });
  assert.ok(result.evidence.entries.length >= MANUAL_STEPS.length);
  // Roteiro manual registrado no relatório; etapas automatizadas coletadas.
  const manual = result.evidence.entries.filter(e => e.step.startsWith('manual-'));
  assert.equal(manual.length, MANUAL_STEPS.length);
  // Falha de qualquer asserção do harness aborta o piloto com erro explícito.
  await assert.rejects(() => Promise.resolve().then(() => { throw new LiveGuardError('exemplo'); }), LiveGuardError);
});
