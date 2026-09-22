import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyRuntime, validateRuntime, STAGES, type Runtime, type Stage } from '../../src/contracts.js';
import { validateConfig } from '../../src/project/config.js';

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SHA256 = 'a'.repeat(64);

function attemptsZero(): Record<Stage, number> {
  return Object.fromEntries(STAGES.map(s => [s, 0])) as Record<Stage, number>;
}

/** Runtime válido mínimo: um run feature em build, uma sessão planner ready, mensagem+entrega+evidência+operação consistentes. */
function validRuntime(): Runtime {
  const r = emptyRuntime(UUID);
  r.revision = 3;
  r.sessions = [{
    role: 'planner', threadId: 'tp', generationId: 'gp', projectId: UUID, cwd: 'c',
    status: 'ready', lastEventAt: new Date().toISOString(),
  }];
  r.runs = [{
    runId: 'r1', slug: 's1', workflow: 'feature', intentPath: 'i', planPath: 'p',
    stage: 'build', revision: 1, attempts: attemptsZero(), gapFailures: {}, status: 'running',
    history: [],
  }];
  r.messages = [{
    messageId: 'm1', projectId: UUID, runId: 'r1', from: 'planner', to: 'dev',
    targetThreadId: 'td', targetGenerationId: 'gd', type: 'task', stage: 'build', revision: 0,
    body: 'executar', createdAt: new Date().toISOString(),
  }];
  r.deliveries = [{ deliveryId: 'd1', messageId: 'm1', status: 'pending', updatedAt: new Date().toISOString() }];
  r.evidence = [{
    id: 'e1', requirementId: 'req', result: 'pass', procedure: 'p', timestamp: new Date().toISOString(),
    runId: 'r1', stage: 'build',
  }];
  r.operations = { op1: { operationId: 'op1', accepted: true, status: 'running', runId: 'r1', revision: 1 } };
  return r;
}

const clone = <T,>(value: T): T => structuredClone(value);

// ---------- C03: runs — contadores, aprovação, compatibilidade workflow/estágio ----------

test('C03 run sem attempts é rejeitado', () => {
  const r = clone(validRuntime());
  delete (r.runs[0] as unknown as Record<string, unknown>).attempts;
  assert.throws(() => validateRuntime(r), /attempts/);
});

test('C03 attempts com valor negativo é rejeitado', () => {
  const r = clone(validRuntime());
  r.runs[0].attempts = { ...attemptsZero(), build: -1 };
  assert.throws(() => validateRuntime(r), /attempts\[build\]/);
});

test('C03 attempts com chave que não é estágio é rejeitado', () => {
  const r = clone(validRuntime());
  (r.runs[0].attempts as Record<string, number>)['nope'] = 1;
  assert.throws(() => validateRuntime(r), /attempts chave inválida/);
});

test('C03 gapFailures com count negativo é rejeitado', () => {
  const r = clone(validRuntime());
  r.runs[0].gapFailures = { build: { gapId: 'G1', count: -1 } };
  assert.throws(() => validateRuntime(r), /gapFailures\[build\]\.count/);
});

test('C03 gapFailures com gapId vazio é rejeitado', () => {
  const r = clone(validRuntime());
  r.runs[0].gapFailures = { review: { gapId: '', count: 1 } };
  assert.throws(() => validateRuntime(r), /gapId/);
});

test('C03 aprovação sem approvedBy é rejeitada', () => {
  const r = clone(validRuntime());
  r.runs[0].approval = { intentPath: 'i', planPath: 'p', approvedAt: new Date().toISOString(), approvedBy: '' };
  assert.throws(() => validateRuntime(r), /approval\.approvedBy/);
});

test('C03 aprovação com data inválida é rejeitada', () => {
  const r = clone(validRuntime());
  r.runs[0].approval = { intentPath: 'i', planPath: 'p', approvedAt: 'não é data', approvedBy: 'planner' };
  assert.throws(() => validateRuntime(r), /approval\.approvedAt/);
});

test('C03 aprovação com intentHash que não é sha256 é rejeitada', () => {
  const r = clone(validRuntime());
  r.runs[0].approval = {
    intentPath: 'i', planPath: 'p', approvedAt: new Date().toISOString(), approvedBy: 'planner',
    intentHash: 'not-a-sha256',
  };
  assert.throws(() => validateRuntime(r), /intentHash deve ser sha256/);
});

test('C03 aprovação com planHash curto é rejeitada', () => {
  const r = clone(validRuntime());
  r.runs[0].approval = {
    intentPath: 'i', planPath: 'p', approvedAt: new Date().toISOString(), approvedBy: 'planner',
    planHash: 'abc123',
  };
  assert.throws(() => validateRuntime(r), /planHash deve ser sha256/);
});

test('C03 aprovação com planVersion vazio é rejeitada', () => {
  const r = clone(validRuntime());
  r.runs[0].approval = {
    intentPath: 'i', planPath: 'p', approvedAt: new Date().toISOString(), approvedBy: 'planner',
    planVersion: '',
  };
  assert.throws(() => validateRuntime(r), /planVersion/);
});

test('C03 aprovação completa com hashes sha256 e planVersion é aceita', () => {
  const r = clone(validRuntime());
  r.runs[0].approval = {
    intentPath: 'i', planPath: 'p', approvedAt: new Date().toISOString(), approvedBy: 'planner',
    intentHash: SHA256, planHash: SHA256, planVersion: 'v1',
  };
  assert.doesNotThrow(() => validateRuntime(r));
});

test('C03 review-only no estágio pr é rejeitado', () => {
  const r = clone(validRuntime());
  r.runs[0].workflow = 'review-only';
  r.runs[0].stage = 'pr';
  assert.throws(() => validateRuntime(r), /incompatível com workflow/);
});

test('C03 hotfix no estágio e2e é rejeitado', () => {
  const r = clone(validRuntime());
  r.runs[0].workflow = 'hotfix';
  r.runs[0].stage = 'e2e';
  assert.throws(() => validateRuntime(r), /incompatível com workflow/);
});

test('C03 duas execuções com status running são rejeitadas', () => {
  const r = clone(validRuntime());
  r.runs.push({
    runId: 'r2', slug: 's2', workflow: 'review-only', intentPath: 'i', planPath: 'p',
    stage: 'review', revision: 0, attempts: attemptsZero(), gapFailures: {}, status: 'running', history: [],
  });
  assert.throws(() => validateRuntime(r), /mais de uma execução com status 'running'/);
});

test('C03 runId duplicado é rejeitado', () => {
  const r = clone(validRuntime());
  r.runs.push({ ...clone(validRuntime()).runs[0] });
  assert.throws(() => validateRuntime(r), /runId duplicado/);
});

// ---------- C03: mensagens, entregas, evidências, sessões, operações ----------

test('C03 mensagem referenciando run inexistente é rejeitada', () => {
  const r = clone(validRuntime());
  r.messages[0].runId = 'run-que-nao-existe';
  assert.throws(() => validateRuntime(r), /runId sem execução/);
});

test('C03 mensagem com projectId divergente é rejeitada', () => {
  const r = clone(validRuntime());
  r.messages[0].projectId = randomUUID();
  assert.throws(() => validateRuntime(r), /projectId divergente/);
});

test('C03 mensagem com messageId duplicado é rejeitada', () => {
  const r = clone(validRuntime());
  r.messages.push({ ...clone(r.messages[0]) });
  assert.throws(() => validateRuntime(r), /messageId duplicado/);
});

test('C03 mensagem com revision negativa é rejeitada', () => {
  const r = clone(validRuntime());
  r.messages[0].revision = -1;
  assert.throws(() => validateRuntime(r), /revision inválida/);
});

test('C03 mensagem com correlationId numérico é rejeitada', () => {
  const r = clone(validRuntime());
  (r.messages[0] as unknown as Record<string, unknown>).correlationId = 42;
  assert.throws(() => validateRuntime(r), /correlationId/);
});

test('C03 delivery com messageId inexistente é rejeitada', () => {
  const r = clone(validRuntime());
  r.deliveries[0].messageId = 'm-inexistente';
  assert.throws(() => validateRuntime(r), /messageId sem mensagem/);
});

test('C03 deliveryId duplicado é rejeitado', () => {
  const r = clone(validRuntime());
  r.deliveries.push({ ...clone(r.deliveries[0]) });
  assert.throws(() => validateRuntime(r), /deliveryId duplicado/);
});

test('C03 delivery com status inválido é rejeitada', () => {
  const r = clone(validRuntime());
  (r.deliveries[0] as unknown as Record<string, unknown>).status = 'voando';
  assert.throws(() => validateRuntime(r), /status/);
});

test('C03 delivery com claimReleased não booleano é rejeitada', () => {
  const r = clone(validRuntime());
  (r.deliveries[0] as unknown as Record<string, unknown>).claimReleased = 'sim';
  assert.throws(() => validateRuntime(r), /claimReleased/);
});

test('C03 evidência referenciando run inexistente é rejeitada', () => {
  const r = clone(validRuntime());
  r.evidence[0].runId = 'run-que-nao-existe';
  assert.throws(() => validateRuntime(r), /runId sem execução/);
});

test('C03 evidência com id duplicado é rejeitada', () => {
  const r = clone(validRuntime());
  r.evidence.push({ ...clone(r.evidence[0]) });
  assert.throws(() => validateRuntime(r), /id duplicado/);
});

test('C03 evidência com line negativa é rejeitada', () => {
  const r = clone(validRuntime());
  r.evidence[0].line = -3;
  assert.throws(() => validateRuntime(r), /line/);
});

test('C03 duas sessões ready para o mesmo papel são rejeitadas', () => {
  const r = clone(validRuntime());
  r.sessions.push({ ...clone(r.sessions[0]), threadId: 'tp2', generationId: 'gp2' });
  assert.throws(() => validateRuntime(r), /mais de uma sessão 'ready' para papel planner/);
});

test('C03 gerações históricas (ready + interrupted) do mesmo papel coexistem', () => {
  const r = clone(validRuntime());
  r.sessions.push({ ...clone(r.sessions[0]), threadId: 'tp0', generationId: 'gp0', status: 'interrupted' });
  assert.doesNotThrow(() => validateRuntime(r));
});

test('C03 sessão com requestedModel numérico é rejeitada', () => {
  const r = clone(validRuntime());
  (r.sessions[0] as unknown as Record<string, unknown>).requestedModel = 7;
  assert.throws(() => validateRuntime(r), /requestedModel/);
});

test('C03 sessão com projectId divergente é rejeitada', () => {
  const r = clone(validRuntime());
  r.sessions[0].projectId = randomUUID();
  assert.throws(() => validateRuntime(r), /projectId divergente/);
});

test('C03 sessão duplicada (mesmo papel/geração/thread) é rejeitada', () => {
  const r = clone(validRuntime());
  r.sessions.push({ ...clone(r.sessions[0]) });
  assert.throws(() => validateRuntime(r), /sessions\[\] duplicado/);
});

test('C03 operação com status vazio é rejeitada', () => {
  const r = clone(validRuntime());
  (r.operations.op1 as unknown as Record<string, unknown>).status = '';
  assert.throws(() => validateRuntime(r), /operations\[op1\]/);
});

test('C03 operação com accepted não booleano é rejeitada', () => {
  const r = clone(validRuntime());
  (r.operations.op1 as unknown as Record<string, unknown>).accepted = 'yes';
  assert.throws(() => validateRuntime(r), /accepted/);
});

test('C03 operação referenciando run inexistente é rejeitada', () => {
  const r = clone(validRuntime());
  r.operations.op1.runId = 'run-que-nao-existe';
  assert.throws(() => validateRuntime(r), /runId sem execução/);
});

test('C03 operação com operationId divergente da chave é rejeitada', () => {
  const r = clone(validRuntime());
  r.operations.op1.operationId = 'outro';
  assert.throws(() => validateRuntime(r), /operationId inválido/);
});

// ---------- C03: forma do runtime ----------

test('C03 runtime sem arrays obrigatórios é rejeitado', () => {
  const r = clone(validRuntime()) as unknown as Record<string, unknown>;
  delete r.sessions;
  assert.throws(() => validateRuntime(r), /sessions deve ser array/);
});

test('C03 runtime com revision negativa é rejeitado', () => {
  const r = clone(validRuntime());
  r.revision = -1;
  assert.throws(() => validateRuntime(r), /revision/);
});

test('C03 runtime com evento sem kind é rejeitado', () => {
  const r = clone(validRuntime());
  r.events = [{ at: new Date().toISOString(), kind: '', detail: 'x' } as Runtime['events'][number]];
  assert.throws(() => validateRuntime(r), /events\[\]/);
});

test('C03 runtime válido de referência é aceito', () => {
  assert.doesNotThrow(() => validateRuntime(validRuntime()));
});

// ---------- R4-03: schema relacional (decisões M0-F2 nº2, nº7 e nº8) ----------

/** Mensagem question válida (dev -> planner) para casos de answer. */
function addQuestion(r: Runtime, overrides: Partial<Runtime['messages'][number]> = {}): Runtime['messages'][number] {
  const q: Runtime['messages'][number] = {
    messageId: 'q1', projectId: UUID, runId: 'r1', from: 'dev', to: 'planner',
    targetThreadId: 'tp', targetGenerationId: 'gp', type: 'question', stage: 'build', revision: 0,
    body: 'pergunta?', createdAt: new Date().toISOString(), ...overrides,
  };
  r.messages.push(q);
  return q;
}

/** Answer válida: planner responde à pergunta q1 (correlationId = messageId da question). */
function addAnswer(r: Runtime, overrides: Partial<Runtime['messages'][number]> = {}): Runtime['messages'][number] {
  const a: Runtime['messages'][number] = {
    messageId: 'a1', projectId: UUID, runId: 'r1', from: 'planner', to: 'dev',
    targetThreadId: 'td', targetGenerationId: 'gd', type: 'answer', stage: 'build', revision: 0,
    body: 'resposta.', createdAt: new Date().toISOString(), correlationId: 'q1', ...overrides,
  };
  r.messages.push(a);
  return a;
}

test('R4-03 answer válida contra question existente é aceita', () => {
  const r = clone(validRuntime());
  addQuestion(r);
  addAnswer(r);
  assert.doesNotThrow(() => validateRuntime(r));
});

test('R4-03 answer sem correlationId é rejeitada', () => {
  const r = clone(validRuntime());
  addQuestion(r);
  addAnswer(r, { correlationId: undefined });
  assert.throws(() => validateRuntime(r), /answer exige correlationId/);
});

test('R4-03 answer referenciando mensagem inexistente é rejeitada', () => {
  const r = clone(validRuntime());
  addAnswer(r, { correlationId: 'não-existe' });
  assert.throws(() => validateRuntime(r), /answer sem pergunta correspondente/);
});

test('R4-03 answer correlacionada a mensagem que não é question é rejeitada', () => {
  const r = clone(validRuntime());
  addAnswer(r, { correlationId: 'm1' }); // m1 é task
  assert.throws(() => validateRuntime(r), /answer sem pergunta correspondente/);
});

test('R4-03 answer de papel diferente do destinatário da pergunta é rejeitada', () => {
  const r = clone(validRuntime());
  addQuestion(r, { to: 'tester-e2e' });
  addAnswer(r); // answer vem de planner, pergunta foi para tester-e2e
  assert.throws(() => validateRuntime(r), /pergunta dirigida a tester-e2e/);
});

test('R4-03 answer e question de execuções diferentes são rejeitadas', () => {
  const r = clone(validRuntime());
  addQuestion(r, { runId: 'r1' });
  addAnswer(r, { runId: undefined, correlationId: 'q1' });
  assert.doesNotThrow(() => validateRuntime(r)); // só um lado tem runId: compatível por decisão nº8
  const r2 = clone(validRuntime());
  r2.runs.push({
    runId: 'r2', slug: 's2', workflow: 'review-only', intentPath: 'i', planPath: 'p',
    stage: 'review', revision: 0, attempts: attemptsZero(), gapFailures: {}, status: 'blocked', history: [],
  });
  addQuestion(r2, { runId: 'r1' });
  addAnswer(r2, { runId: 'r2' });
  assert.throws(() => validateRuntime(r2), /pergunta de outra execução/);
});

test('R4-03 linkedTaskMessageId sem mensagem é rejeitado', () => {
  const r = clone(validRuntime());
  r.messages[0].linkedTaskMessageId = 'mensagem-inexistente';
  assert.throws(() => validateRuntime(r), /linkedTaskMessageId sem mensagem/);
});

test('R4-03 linkedTaskMessageId existente é aceito', () => {
  const r = clone(validRuntime());
  addQuestion(r, { linkedTaskMessageId: 'm1' });
  assert.doesNotThrow(() => validateRuntime(r));
});

test('R4-03 duas deliveries para o mesmo messageId são rejeitadas', () => {
  const r = clone(validRuntime());
  r.deliveries.push({ deliveryId: 'd2', messageId: 'm1', status: 'enqueued', updatedAt: new Date().toISOString() });
  assert.throws(() => validateRuntime(r), /mais de uma entrega para messageId m1/);
});

test('R4-03 received sem claimant é rejeitado', () => {
  const r = clone(validRuntime());
  r.deliveries[0].status = 'received';
  assert.throws(() => validateRuntime(r), /received exige claim/);
});

test('R4-03 received com claimedBy e claimedAt é aceito', () => {
  const r = clone(validRuntime());
  r.deliveries[0].status = 'received';
  r.deliveries[0].claimedBy = 'dev:g1';
  r.deliveries[0].claimedAt = new Date().toISOString();
  assert.doesNotThrow(() => validateRuntime(r));
});

test('R4-03 claimedBy sem claimedAt é rejeitado (claim só em par)', () => {
  const r = clone(validRuntime());
  r.deliveries[0].status = 'received';
  r.deliveries[0].claimedBy = 'dev:g1';
  assert.throws(() => validateRuntime(r), /claimedBy e claimedAt devem vir em par/);
});

test('R4-03 completed sem trilha de conclusão (claim) é rejeitado', () => {
  const r = clone(validRuntime());
  r.deliveries[0].status = 'completed';
  assert.throws(() => validateRuntime(r), /completed exige claim/);
});

test('R4-03 pending/enqueued/failed/uncertain com claim são rejeitados', () => {
  for (const status of ['pending', 'enqueued', 'failed', 'uncertain'] as const) {
    const r = clone(validRuntime());
    r.deliveries[0].status = status;
    r.deliveries[0].claimedBy = 'dev:g1';
    r.deliveries[0].claimedAt = new Date().toISOString();
    assert.throws(() => validateRuntime(r), /não admite claim/, status);
  }
});

test('R4-03 failed/uncertain com claimReleased são rejeitados (contexto preservado)', () => {
  const r = clone(validRuntime());
  r.deliveries[0].status = 'failed';
  r.deliveries[0].nativeMessageId = 'nat-1'; // contexto do transporte preservado
  (r.deliveries[0] as { claimReleased?: boolean }).claimReleased = true;
  assert.throws(() => validateRuntime(r), /não admite claimReleased/);
});

test('R4-03 operação aceita com status arbitrário é rejeitada (enum fechado)', () => {
  const r = clone(validRuntime());
  (r.operations.op1 as unknown as Record<string, unknown>).status = 'transition';
  assert.throws(() => validateRuntime(r), /inválido para operação aceita/);
});

test('R4-03 operação aceita com RunStatus é aceita', () => {
  for (const status of ['running', 'done', 'blocked', 'exhausted', 'thrash'] as const) {
    const r = clone(validRuntime());
    r.operations.op1.status = status;
    assert.doesNotThrow(() => validateRuntime(r), status);
  }
});

test('R4-03 operação recusada com status diferente de rejected é rejeitada', () => {
  const r = clone(validRuntime());
  r.operations.op1.accepted = false;
  r.operations.op1.status = 'done';
  assert.throws(() => validateRuntime(r), /inválido para operação recusada/);
});

test('R4-03 operação recusada sem error é rejeitada', () => {
  const r = clone(validRuntime());
  r.operations.op1 = { operationId: 'op1', accepted: false, status: 'rejected' };
  assert.throws(() => validateRuntime(r), /exige error/);
});

test('R4-03 operação recusada com error é aceita', () => {
  const r = clone(validRuntime());
  r.operations.op1 = { operationId: 'op1', accepted: false, status: 'rejected', error: 'estágio divergente' };
  assert.doesNotThrow(() => validateRuntime(r));
});

test('R4-03 payloadHash inválido é rejeitado (decisão M0-F2 nº2)', () => {
  const r = clone(validRuntime());
  r.operations.op1.payloadHash = 'not-a-sha256';
  assert.throws(() => validateRuntime(r), /payloadHash deve ser sha256/);
});

test('R4-03 payloadHash sha256 é aceito', () => {
  const r = clone(validRuntime());
  r.operations.op1.payloadHash = SHA256;
  assert.doesNotThrow(() => validateRuntime(r));
});

test('R4-03 evidência com provenance inválida é rejeitada', () => {
  const r = clone(validRuntime());
  (r.evidence[0] as unknown as Record<string, unknown>).provenance = 'imported';
  assert.throws(() => validateRuntime(r), /provenance inválida/);
});

test('R4-03 evidência com provenance legacy é aceita (decisão M0-F2 nº7)', () => {
  const r = clone(validRuntime());
  r.evidence[0].provenance = 'legacy';
  assert.doesNotThrow(() => validateRuntime(r));
});

test('R4-03 schemaVersion 3 é rejeitado; v1 legado estruturalmente válido ainda valida', () => {
  const r3 = clone(validRuntime()) as unknown as Record<string, unknown>;
  r3.schemaVersion = 3;
  assert.throws(() => validateRuntime(r3), /schemaVersion/);
  const legacy = clone(validRuntime()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 1;
  assert.doesNotThrow(() => validateRuntime(legacy));
});

// ---------- C03: configuração ----------

function validConfig(): Record<string, unknown> {
  return { schemaVersion: 1, projectId: UUID, projectName: 'P', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'] };
}

test('C03 config com projectId que não é UUID é rejeitada', () => {
  assert.throws(() => validateConfig({ ...validConfig(), projectId: 'nao-e-uuid' }), /projectId deve ser UUID/);
});

test('C03 config com check shell não booleano é rejeitada', () => {
  const c = validConfig();
  c.checks = { build: { executable: 'npm', args: ['run', 'build'], shell: 'sim' } };
  assert.throws(() => validateConfig(c), /shell deve ser boolean/);
});

test('C03 config com check cwd numérico é rejeitada', () => {
  const c = validConfig();
  c.checks = { unit: { executable: 'npm', args: ['test'], cwd: 42 } };
  assert.throws(() => validateConfig(c), /cwd deve ser string/);
});

test('C03 config com check args não vetor de strings é rejeitada', () => {
  const c = validConfig();
  c.checks = { lint: { executable: 'npm', args: ['run', 7] } };
  assert.throws(() => validateConfig(c), /args deve ser vetor/);
});

test('C03 config com modelo numérico é rejeitada', () => {
  const c = validConfig();
  c.models = { dev: { model: 123 } };
  assert.throws(() => validateConfig(c), /modelo inválido/);
});

test('C03 config com effort inválido é rejeitada', () => {
  const c = validConfig();
  c.models = { reviewer: { effort: 'turbo' } };
  assert.throws(() => validateConfig(c), /effort inválido/);
});

test('C03 config com modelo para papel desconhecido é rejeitada', () => {
  const c = validConfig();
  c.models = { janitor: { model: 'gpt' } };
  assert.throws(() => validateConfig(c), /papel desconhecido/);
});

test('C03 config com check desconhecido é rejeitada', () => {
  const c = validConfig();
  c.checks = { deploy: { executable: 'npm', args: [] } };
  assert.throws(() => validateConfig(c), /check desconhecido/);
});

test('C03 config válida de referência é aceita', () => {
  const c = validateConfig({
    ...validConfig(),
    checks: { build: { executable: 'npm', args: ['run', 'build'], cwd: '.sdlc-codex', shell: false } },
    models: { dev: { model: 'gpt-5', effort: 'high' } },
  });
  assert.equal(c.projectId, UUID);
  assert.equal(c.prBase, 'main');
});
