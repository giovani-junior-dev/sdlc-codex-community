/**
 * Sonda OPT-IN de transporte real contra o Codex instalado (C01/R08).
 * NUNCA roda na suíte padrão. Execução: `npm run test:live` com SDLC_LIVE=1.
 * Não executar nesta sessão — exige autorização explícita para qualquer
 * efeito externo, mesmo com UUID inexistente.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexTransport } from '../../src/adapters/codex.js';
import { NodeProcessRunner } from '../../src/adapters/process.js';

const enabled = process.env.SDLC_LIVE === '1';

test('codex real com thread inexistente retorna failed', { skip: enabled ? false : 'defina SDLC_LIVE=1 para sonda real' }, async () => {
  const out = await new CodexTransport(new NodeProcessRunner(), 'codex')
    .queue('00000000-0000-0000-0000-000000000000', 'probe-sem-efeito', 20000);
  assert.equal(out.status, 'failed');
});
