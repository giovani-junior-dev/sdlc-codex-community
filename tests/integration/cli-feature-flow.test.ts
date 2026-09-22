import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { StateStore } from '../../src/state/store.js';
import { validateRuntime } from '../../src/contracts.js';
import { captureCodeSnapshot } from '../../src/evidence/snapshot.js';
import type { HerdrAdapter } from '../../src/adapters/herdr.js';
import type { Message, Role, SessionRecord, Stage } from '../../src/contracts.js';
import { FULL_CHECKS, FlowHarness, FlowProject, HEAD, InstantHerdr, adoptProject, io, sha256, writeApproval, writeRubricFile, type QueueRec } from './flow-fixtures.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555503';

// M4-F2: checks REAIS configurados (executados pelo produto via comando `check`);
// o runner falso aprova as bordas externas — nunca checks vazios nem evidência
// fabricada no arquivo de evidências (R4-13).
const CONFIG = {
  schemaVersion: 1, projectId: PROJECT_ID, projectName: 'Feat', prBase: 'main',
  checks: FULL_CHECKS, models: {}, protectedPaths: ['.git'],
};

// Critério de entrega (R4-13): cenário feature completo pela CLI com adaptadores
// de produção e falsos nas bordas — adoção → time → início com aprovação real →
// kickoff despachado e envelope conferido → receive com identidade → checks do
// produto com log durável em disco → rubrica humana contra manifesto → next por
// estágio (incl. review fail → correção), conversa correlacionada, substituição
// de geração + recover, transporte incerto + recover, replay, PR fake, revisão,
// documentação e done com notificação ao planner — afirmando envelopes, cwd/argv,
// logs/hash, revisões, contagem de efeitos externos, histórico e estado final.
test('feature completa via CLI: envelopes, checks reais, correção, conversa, gerações, recover, PR e done', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-feat-'));
  const SLUG = 'feat-1';
  const harness = new FlowHarness();
  const deps = { runner: harness.runner, herdr: new InstantHerdr(root, PROJECT_ID) as HerdrAdapter };
  const store = () => new StateStore(join(root, '.sdlc-codex'), { projectId: PROJECT_ID });
  const run = async () => (await store().read()).runs.find(r => r.slug === SLUG)!;
  const actor = async (role: Role): Promise<SessionRecord> => {
    const s = (await store().read()).sessions.find(x => x.role === role && x.status === 'ready');
    assert.ok(s?.threadId, `sessão ${role} pronta`);
    return s;
  };
  const worktree = join(root, '.sdlc-codex', 'worktrees', SLUG);
  await adoptProject(root, CONFIG, harness.runner);
  await writeApproval(root);

  // adopt → up: time completo feature e efeito Git externo verificável (worktree do dev).
  let x = io();
  assert.equal(await runCli(['up', SLUG, '--workflow', 'feature', '--project', root, '--json'], x.value, deps), 0, x.err.join('\n'));
  const upOut = JSON.parse(x.out[0]) as { partial: boolean; team: Array<{ role: Role; ready: boolean; generationId: string }> };
  assert.equal(upOut.partial, false);
  assert.deepEqual(upOut.team.map(t => t.role), ['planner', 'dev', 'reviewer', 'tester-e2e', 'document']);
  assert.ok(upOut.team.every(t => t.ready && t.generationId));
  const wtAdd = harness.runner.calls.find(c => c.executable === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
  assert.ok(wtAdd, 'worktree do dev criado via adaptador Git');
  assert.deepEqual(wtAdd.args.slice(0, 4), ['worktree', 'add', '-b', `sdlc/${SLUG}`]);
  assert.equal(wtAdd.args[4], worktree);
  assert.equal(wtAdd.args[5], 'main');
  assert.equal(wtAdd.cwd, root, 'git roda na raiz principal');

  // start com aprovação real dos hashes → kickoff despachado (C01, sem recover manual).
  const sendsBeforeStart = harness.queueSends();
  x = io();
  assert.equal(await runCli(['start', SLUG, '--intent', 'intent.md', '--plan', 'plan.md', '--approval', 'approval.json', '--workflow', 'feature', '--project', root, '--json'], x.value, deps), 0, x.err.join('\n'));
  const startOut = JSON.parse(x.out[0]) as { runId: string; dispatched: Array<{ messageId: string; status: string; nativeMessageId?: string }> };
  const runId = startOut.runId;
  assert.ok(startOut.dispatched.length >= 2, 'kickoff + cópia ao planner despachados no start');
  assert.ok(startOut.dispatched.every(d => d.status === 'enqueued' && d.nativeMessageId), 'todas enqueued com receipt nativo');
  assert.equal(harness.queueSends(), sendsBeforeStart + startOut.dispatched.length, 'transporte usado após o commit da transação');

  // Envelope do kickoff: conteúdo completo conferido contra a mensagem persistida.
  const kickoff = (await store().read()).messages.find(m => m.runId === runId && m.type === 'task' && m.to === 'dev')!;
  const dev0 = await actor('dev');
  const planner = await actor('planner');
  const kickRec = harness.envelopes.find(r => r.envelope.messageId === kickoff.messageId)!;
  assertEnvelope(kickRec, kickoff, dev0.threadId!);
  assert.equal(kickRec.args[0], 'queue');
  assert.equal(kickRec.args[1], '--thread');
  assert.equal(kickRec.args[3], '--message');
  const copyNotify = (await store().read()).messages.find(m => m.runId === runId && m.type === 'notify' && m.to === 'planner' && m.stage === 'build')!;
  assertEnvelope(harness.envelopes.find(r => r.envelope.messageId === copyNotify.messageId)!, copyNotify, planner.threadId!);

  // receive da task com identidade vigente → claimed; repetição é duplicate.
  x = io();
  assert.equal(await runCli(['receive', kickoff.messageId, '--role', 'dev', '--thread', dev0.threadId!, '--generation', dev0.generationId, '--project', root, '--json'], x.value, deps), 0);
  const recvOut = JSON.parse(x.out[0]) as { action: string; status: string };
  assert.equal(recvOut.action, 'execute');
  let kickDelivery = (await store().read()).deliveries.find(d => d.messageId === kickoff.messageId)!;
  assert.equal(kickDelivery.status, 'received');
  assert.equal(kickDelivery.claimedBy, `dev:${dev0.generationId}`, 'received exige claim (R4-03)');
  x = io();
  assert.equal(await runCli(['receive', kickoff.messageId, '--role', 'dev', '--thread', dev0.threadId!, '--generation', dev0.generationId, '--project', root, '--json'], x.value, deps), 0);
  assert.equal((JSON.parse(x.out[0]) as { action: string }).action, 'duplicate');

  let opCounter = 0;
  const buildLogs = new Set<string>();

  // check do estágio: checks REAIS do produto; log durável em disco com hash;
  // cwd/argv do processo falso conferidos (cwd = worktree da execução, R4-14).
  async function productCheck(stage: Stage, sess: SessionRecord): Promise<unknown> {
    const toolBefore = harness.runner.calls.filter(c => c.executable === 'tool').length;
    const chk = io();
    assert.equal(await runCli(['check', SLUG, '--stage', stage, '--thread', sess.threadId!, '--generation', sess.generationId, '--project', root, '--json'], chk.value, deps), 0, `check ${stage}: ${chk.err.join('\n')} ${chk.out.join('')}`);
    const out = JSON.parse(chk.out[0]) as { checks: Array<{ name: string; status: string; evidenceId: string; logPath?: string }>; snapshot?: { commit: string; diffFingerprint: string } };
    assert.ok(out.snapshot?.diffFingerprint, 'check informa o snapshot verificado que a rubrica humana copia (R5-04)');
    assert.ok(out.checks.length > 0, `estágio ${stage} executa checks (nunca seleção vazia acidental)`);
    assert.ok(out.checks.every(c => c.status === 'approved' && c.logPath), `checks aprovados com log: ${JSON.stringify(out.checks)}`);
    const state = await store().read();
    const toolCalls = harness.runner.calls.filter(c => c.executable === 'tool').slice(toolBefore);
    for (const c of out.checks) {
      const ev = state.evidence.find(e => e.id === c.evidenceId)!;
      assert.equal(ev.check, c.name);
      assert.equal(ev.runId, runId, 'evidência mecânica vinculada à execução');
      assert.ok(!ev.imported, 'evidência de check nunca é importada');
      assert.ok(ev.codeSnapshot?.diffFingerprint, 'evidência mecânica carrega snapshot verificado (M4-F3)');
      assert.equal(ev.producer?.threadId, sess.threadId, 'produtor/identidade registrado');
      const content = await readFile(c.logPath!, 'utf8');
      assert.equal(sha256(content), ev.logHash, 'logHash confere com o arquivo em disco');
      assert.match(content, new RegExp(`check: ${c.name}`));
      assert.match(content, /exitCode: 0/);
      const call = toolCalls.find(t => t.args.join(' ') === CONFIG.checks[c.name as 'build'].args.join(' '));
      assert.ok(call, `check ${c.name} executado como processo externo`);
      assert.equal(call.cwd, worktree, 'cwd relativo/absoluto resolve contra o worktree da execução');
      if (c.name === 'build') {
        buildLogs.add(c.logPath!);
        assert.match(content, new RegExp(`cwd: ${worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      }
    }
    return out.snapshot;
  }

  // Rubrica humana importada: manifesto + log real íntegro (M4-F1) + proveniência completa (R5-05):
  // produtor = a sessão que apresenta o `next` e codeSnapshot copiado do payload de `check`.
  async function writeRubric(stage: Stage, ids: string[], snapshot: unknown, sess: SessionRecord, result: 'pass' | 'fail' = 'pass'): Promise<string> {
    return writeRubricFile({
      root, slug: SLUG, stage, ids, projectId: PROJECT_ID, run: await run(), sess, snapshot,
      commit: harness.git.head, result, timestamp: '2026-09-19T02:00:00Z',
    });
  }

  async function next(stage: Stage, verdict: 'pass' | 'fail', sess: SessionRecord, evidenceFile: string, extra: string[] = []): Promise<{ code: number; out: string; err: string; oid: string }> {
    const r = await run();
    const oid = `op-${++opCounter}`;
    const y = io();
    const code = await runCli(['next', SLUG, stage, verdict, '--revision', String(r.revision), '--operation-id', oid,
      '--evidence', evidenceFile, '--role', sess.role, '--thread', sess.threadId!, '--generation', sess.generationId,
      '--project', root, '--json', ...extra], y.value, deps);
    return { code, out: y.out.join(''), err: y.err.join(''), oid };
  }

  async function receiveTask(stage: Stage, sess: SessionRecord): Promise<Message> {
    const r = await run();
    const msg = (await store().read()).messages.find(m =>
      m.runId === r.runId && m.type === 'task' && m.stage === stage && m.revision === r.revision && m.to === sess.role);
    assert.ok(msg, `task de ${stage} na revisão ${r.revision}`);
    const y = io();
    assert.equal(await runCli(['receive', msg.messageId, '--role', sess.role, '--thread', sess.threadId!, '--generation', sess.generationId, '--project', root, '--json'], y.value, deps), 0, y.err.join('\n'));
    assert.equal((JSON.parse(y.out[0]) as { action: string }).action, 'execute');
    return msg;
  }

  // build → review (pass).
  let snap = await productCheck('build', dev0);
  let res = await next('build', 'pass', dev0, await writeRubric('build', ['REQ-1'], snap, dev0));
  assert.equal(res.code, 0, res.err);
  assert.equal((JSON.parse(res.out) as { status: string }).status, 'running');
  kickDelivery = (await store().read()).deliveries.find(d => d.messageId === kickoff.messageId)!;
  assert.equal(kickDelivery.status, 'completed', 'task concluída na mesma transação do next (R12)');
  assert.ok(kickDelivery.claimedBy, 'completed preserva a trilha de claim');
  const reviewer = await actor('reviewer');

  // review FAIL → retorno ao dev com nova task; gap registrado.
  const reviewTask = await receiveTask('review', reviewer);
  snap = await productCheck('review', reviewer);
  res = await next('review', 'fail', reviewer, await writeRubric('review', ['REQ-1', 'REQ-2'], snap, reviewer, 'fail'), ['--gap', 'REQ-2']);
  assert.equal(res.code, 0, res.err);
  let r = await run();
  assert.equal(r.stage, 'build', 'review reprovado volta ao build');
  assert.equal(r.revision, 2);
  assert.deepEqual(r.gapFailures.review, { gapId: 'REQ-2', count: 1 });
  const buildTask2 = (await store().read()).messages.find(m => m.runId === runId && m.type === 'task' && m.stage === 'build' && m.revision === 2)!;
  assert.equal((await store().read()).deliveries.find(d => d.messageId === buildTask2.messageId)?.status, 'enqueued');

  // Conversa correlacionada dev→planner→dev: não avança pipeline; finish-message conclui.
  const revBeforeTalk = (await run()).revision;
  await writeFile(join(root, 'q.txt'), 'dúvida sobre REQ-2');
  x = io();
  assert.equal(await runCli(['send', '--from', 'dev', '--to', 'planner', '--type', 'question', '--body-file', 'q.txt', '--project', root, '--json'], x.value, deps), 0);
  const qid = (JSON.parse(x.out[0]) as { messageId: string }).messageId;
  const qmsg = (await store().read()).messages.find(m => m.messageId === qid)!;
  const qRec = harness.envelopes.find(rec => rec.envelope.messageId === qid)!;
  assertEnvelope(qRec, qmsg, planner.threadId!);
  assert.equal(qRec.envelope.correlationId, '', 'question sem correlação');
  x = io();
  assert.equal(await runCli(['receive', qid, '--role', 'planner', '--thread', planner.threadId!, '--generation', planner.generationId, '--project', root, '--json'], x.value, deps), 0);
  assert.equal((JSON.parse(x.out[0]) as { action: string }).action, 'execute');
  await writeFile(join(root, 'a.txt'), 'resposta: manter escopo');
  x = io();
  assert.equal(await runCli(['send', '--from', 'planner', '--to', 'dev', '--type', 'answer', '--body-file', 'a.txt', '--reply-to', qid, '--project', root, '--json'], x.value, deps), 0);
  const ansid = (JSON.parse(x.out[0]) as { messageId: string }).messageId;
  const ansRec = harness.envelopes.find(rec => rec.envelope.messageId === ansid)!;
  assert.equal(ansRec.envelope.correlationId, qid, 'answer correlacionada à pergunta (R4-03)');
  assertEnvelope(ansRec, (await store().read()).messages.find(m => m.messageId === ansid)!, dev0.threadId!);
  x = io();
  assert.equal(await runCli(['receive', ansid, '--role', 'dev', '--thread', dev0.threadId!, '--generation', dev0.generationId, '--project', root, '--json'], x.value, deps), 0);
  x = io();
  assert.equal(await runCli(['finish-message', qid, '--role', 'planner', '--thread', planner.threadId!, '--generation', planner.generationId, '--project', root, '--json'], x.value, deps), 0);
  const qDelivery = (await store().read()).deliveries.find(d => d.messageId === qid)!;
  assert.equal(qDelivery.status, 'completed');
  assert.equal((await run()).revision, revBeforeTalk, 'perguntas não avançam estágio nem revisão');

  // Substituição de geração do dev: SessionEnd → recover pausa → relançamento
  // humano (up --roles) → recover remapeia para a geração vigente e reenvia.
  const sendsBeforeEnd = harness.queueSends();
  await writeFile(join(root, 'end.json'), JSON.stringify({ type: 'SessionEnd', session_id: dev0.threadId }));
  x = io();
  assert.equal(await runCli(['hook', 'SessionEnd', '--payload-file', 'end.json', '--project', root, '--json'], x.value, deps), 0);
  x = io();
  assert.equal(await runCli(['recover', '--limit', '10', '--project', root, '--json'], x.value, deps), 0);
  const paused = JSON.parse(x.out[0]) as Array<{ messageId: string; status: string }>;
  assert.ok(paused.some(p => p.messageId === buildTask2.messageId && p.status === 'paused'), 'entrega pausada sem sessão ready');
  assert.equal(harness.queueSends(), sendsBeforeEnd, 'recover com sessão indisponível não reenvia');
  x = io();
  assert.equal(await runCli(['up', SLUG, '--roles', 'dev', '--project', root, '--json'], x.value, deps), 0);
  const dev1 = await actor('dev');
  assert.notEqual(dev1.generationId, dev0.generationId, 'nova geração para o dev');
  const dev0Record = (await store().read()).sessions.find(s => s.threadId === dev0.threadId)!;
  // SessionEnd é o fato explícito de encerramento (registry.event(threadId) →
  // 'closed', semântica fixada em M5 e nos testes de hook); 'interrupted' seria
  // o rebaixo quando a geração anterior NÃO enviou SessionEnd (timeout/substituição
  // sem fechamento). Aqui o fechamento foi observado, logo 'closed' com auditoria.
  assert.equal(dev0Record.status, 'closed', 'geração encerrada por SessionEnd fecha com auditoria');
  assert.equal((await store().read()).sessions.filter(s => s.role === 'dev' && s.status === 'ready').length, 1, 'uma única sessão ready por papel');
  const sendsBeforeRemap = harness.queueSends();
  x = io();
  assert.equal(await runCli(['recover', '--limit', '10', '--project', root, '--json'], x.value, deps), 0);
  const remapped = JSON.parse(x.out[0]) as Array<{ messageId: string; status: string }>;
  assert.ok(remapped.some(p => p.messageId === buildTask2.messageId && p.status === 'enqueued'));
  assert.equal(harness.queueSends(), sendsBeforeRemap + 1, 'reenvio remapado consome exatamente um send');
  const afterRemap = await store().read();
  assert.equal(afterRemap.messages.find(m => m.messageId === buildTask2.messageId)!.targetThreadId, dev1.threadId);
  assert.ok(afterRemap.events.some(e => e.kind === 'delivery-remapped'));
  const remapRec = harness.envelopes.filter(rec => rec.envelope.messageId === buildTask2.messageId).at(-1)!;
  assertEnvelope(remapRec, afterRemap.messages.find(m => m.messageId === buildTask2.messageId)!, dev1.threadId!);
  assert.equal(afterRemap.runs.find(rr => rr.runId === runId)!.revision, 2, 'recover não repete transição do pipeline');

  // Geração antiga nunca conclui trabalho da nova — evidência de importação válida
  // (revisão vigente) isola a rejeição na identidade do ator.
  const sendsBeforeOld = harness.queueSends();
  r = await run();
  // Rubrica íntegra (produtor = a própria geração antiga, snapshot da árvore atual): a importação passa e
  // a rejeição vem SÓ da identidade do ator.
  const oldSnapshot = await captureCodeSnapshot(harness.runner, worktree);
  const oldGenFile = await writeRubricFile({
    root, slug: SLUG, stage: 'build', ids: ['REQ-1'], projectId: PROJECT_ID, run: r, sess: dev0, snapshot: oldSnapshot,
    commit: HEAD, idOf: () => 'ev-oldgen', timestamp: '2026-09-19T02:00:00Z',
  });
  const fpOld = { evidence: (await store().read()).evidence.length, messages: (await store().read()).messages.length };
  x = io();
  assert.equal(await runCli(['next', SLUG, 'build', 'pass', '--revision', String(r.revision), '--operation-id', 'op-oldgen',
    '--evidence', oldGenFile, '--role', 'dev', '--thread', dev0.threadId!, '--generation', dev0.generationId, '--project', root, '--json'], x.value, deps), 3);
  assert.match(x.err.join('\n'), /não autorizada|divergente|obsoleto/);
  assert.equal(harness.queueSends(), sendsBeforeOld, 'rejeição por ator obsoleto não despacha nada');
  const afterOld = await store().read();
  assert.equal(afterOld.evidence.length, fpOld.evidence, 'evidência da geração antiga não é mesclada');
  assert.equal(afterOld.messages.length, fpOld.messages, 'nenhuma task/notify criada pela rejeição');
  assert.equal((await run()).revision, r.revision, 'revisão preservada');

  // Correção pelo dev (geração vigente): build pass. Logs anteriores preservados.
  await receiveTask('build', dev1);
  const logCountBeforeRetry = buildLogs.size;
  snap = await productCheck('build', dev1);
  assert.equal(buildLogs.size, logCountBeforeRetry + 1, 'retry grava NOVO log (imutabilidade, R4-14)');
  for (const p of buildLogs) {
    const content = await readFile(p, 'utf8');
    assert.match(content, /check: build/, 'log da tentativa anterior preservado após retry');
  }
  res = await next('build', 'pass', dev1, await writeRubric('build', ['REQ-1'], snap, dev1));
  assert.equal(res.code, 0, res.err);

  // Transporte incerto em torno do queue: fail de review => uncertain; recover
  // reenvia sem repetir a transição.
  harness.queueMode = 'uncertain';
  const reviewTask3 = await receiveTask('review', reviewer);
  snap = await productCheck('review', reviewer);
  res = await next('review', 'fail', reviewer, await writeRubric('review', ['REQ-1', 'REQ-2'], snap, reviewer, 'fail'), ['--gap', 'REQ-3']);
  assert.equal(res.code, 0, res.err);
  harness.queueMode = 'enqueued';
  r = await run();
  assert.equal(r.stage, 'build');
  const buildTask4 = (await store().read()).messages.find(m => m.runId === runId && m.type === 'task' && m.stage === 'build' && m.revision === r.revision)!;
  const uncertainDelivery = (await store().read()).deliveries.find(d => d.messageId === buildTask4.messageId)!;
  assert.equal(uncertainDelivery.status, 'uncertain', 'sem receipt => uncertain, nunca enqueued presumido');
  // reviewTask3 já foi recebida (receive) antes do fail — a transição de next a
  // CONCLUI na mesma gravação (completeLinkedTask, R12): 'completed' é o correto.
  // A incerteza de transporte afeta apenas o despacho NOVO (buildTask4 acima).
  assert.equal((await store().read()).deliveries.find(d => d.messageId === reviewTask3.messageId)?.status, 'completed');
  const revBeforeRecover = (await run()).revision;
  const sendsBeforeRecover = harness.queueSends();
  x = io();
  assert.equal(await runCli(['recover', '--limit', '10', '--project', root, '--json'], x.value, deps), 0);
  const requeued = JSON.parse(x.out[0]) as Array<{ messageId: string; status: string }>;
  assert.ok(requeued.some(p => p.messageId === buildTask4.messageId && p.status === 'enqueued'));
  assert.ok(harness.queueSends() > sendsBeforeRecover, 'recover reenvia entregas uncertain');
  r = await run();
  assert.equal(r.revision, revBeforeRecover, 'recover não repete a transição do pipeline');
  assert.equal(r.stage, 'build');

  // build → review → e2e (todos pass).
  await receiveTask('build', dev1);
  snap = await productCheck('build', dev1);
  res = await next('build', 'pass', dev1, await writeRubric('build', ['REQ-1'], snap, dev1));
  assert.equal(res.code, 0, res.err);
  await receiveTask('review', reviewer);
  snap = await productCheck('review', reviewer);
  res = await next('review', 'pass', reviewer, await writeRubric('review', ['REQ-1', 'REQ-2'], snap, reviewer));
  assert.equal(res.code, 0, res.err);
  const tester = await actor('tester-e2e');
  await receiveTask('e2e', tester);
  snap = await productCheck('e2e', tester);
  res = await next('e2e', 'pass', tester, await writeRubric('e2e', ['REQ-1', 'REQ-3'], snap, tester));
  assert.equal(res.code, 0, res.err);

  // PR (M6-F2): pedido inválido gera ZERO chamadas ao gh (R4-04); pedido válido
  // reutiliza a PR existente — exatamente ZERO create.
  await receiveTask('pr', dev1);
  snap = await productCheck('pr', dev1);
  const prRubric = await writeRubric('pr', ['REQ-1'], snap, dev1);
  const ghCallsBefore = harness.runner.calls.filter(c => c.executable === 'gh').length;
  // Pedido inválido: revisão deliberadamente divergente => pré-validação pura
  // reprova ANTES de qualquer efeito externo.
  x = io();
  assert.equal(await runCli(['next', SLUG, 'pr', 'pass', '--revision', '999', '--operation-id', 'op-invalido',
    '--evidence', prRubric, '--role', 'dev', '--thread', dev1.threadId!, '--generation', dev1.generationId, '--project', root, '--json'], x.value, deps), 3);
  assert.match(x.err.join('\n'), /estágio ou revisão divergente/);
  assert.equal(harness.runner.calls.filter(c => c.executable === 'gh').length, ghCallsBefore, 'R4-04: ZERO chamadas ao gh em pedido inválido');
  r = await run();
  assert.equal(r.stage, 'pr', 'sem transição em pedido inválido');
  // PR existente (ABERTA) para branch/base: reconciliada por leitura, sem create; head remoto == HEAD.
  harness.prs.push({ url: 'https://github.com/acme/feat/pull/7', headRefName: `sdlc/${SLUG}`, baseRefName: 'main', headRefOid: HEAD, number: 7, state: 'OPEN' });
  res = await next('pr', 'pass', dev1, prRubric);
  assert.equal(res.code, 0, res.err);
  assert.equal(harness.ghCreateCalls, 0, 'PR existente reutilizada: exatamente ZERO create');
  r = await run();
  assert.equal(r.pullRequest?.url, 'https://github.com/acme/feat/pull/7');
  assert.equal(r.pullRequest?.commit, HEAD);
  assert.equal(r.stage, 'pr-review');
  assert.equal((await store().read()).operations['op-invalido'].accepted, false, 'rejeição registrada para replay');

  // pr-review → document → done com notificação ao planner.
  await receiveTask('pr-review', reviewer);
  snap = await productCheck('pr-review', reviewer);
  // REQ-2 é aplicável só a 'review' no manifesto — o gate rejeitaria rubrica com
  // REQ-2 aqui (proteção M4-F3 testada em evidence-import). pr-review cobre REQ-1.
  // R5-07: pr-review OBSERVA a PR atual (gh pr view por URL registrada) e persiste o snapshot aprovado.
  const viewsBeforePrReview = harness.ghViewCalls;
  res = await next('pr-review', 'pass', reviewer, await writeRubric('pr-review', ['REQ-1'], snap, reviewer));
  assert.equal(res.code, 0, res.err);
  assert.ok(harness.ghViewCalls > viewsBeforePrReview, 'pr-review consultou a PR (gh pr view)');
  assert.ok((await run()).approvedSnapshot?.diffFingerprint, 'pr-review persiste o snapshot aprovado (R5-07)');
  const document = await actor('document');
  await receiveTask('document', document);
  snap = await productCheck('document', document);
  const viewsBeforeClose = harness.ghViewCalls;
  res = await next('document', 'pass', document, await writeRubric('document', ['REQ-1'], snap, document));
  assert.equal(res.code, 0, res.err);
  assert.ok(harness.ghViewCalls > viewsBeforeClose, 'fechamento reobserva a PR (R5-07)');
  assert.equal((JSON.parse(res.out) as { status: string }).status, 'done');

  // Estado final persistido: histórico completo, revisão monotônica, PR, notify.
  const finalState = await store().read();
  const finalRun = finalState.runs.find(rr => rr.runId === runId)!;
  assert.equal(finalRun.status, 'done');
  assert.equal(finalRun.stage, 'document');
  assert.equal(finalRun.revision, 10, 'revisão da execução: 10 transições aceitas');
  assert.deepEqual(finalRun.history.map(h => `${h.stage}:${h.result}`), [
    'build:pass', 'review:fail', 'build:pass', 'review:fail', 'build:pass',
    'review:pass', 'e2e:pass', 'pr:pass', 'pr-review:pass', 'document:pass',
  ]);
  assert.ok(finalState.messages.some(m => m.to === 'planner' && m.type === 'notify' && /concluída/.test(m.body)), 'planner notificado do fechamento');
  const doneNotify = finalState.messages.find(m => m.to === 'planner' && m.type === 'notify' && /concluída/.test(m.body))!;
  const doneRec = harness.envelopes.find(rec => rec.envelope.messageId === doneNotify.messageId)!;
  assertEnvelope(doneRec, doneNotify, planner.threadId!);

  // Fronteira: relatório de status reflete o estado terminal.
  x = io();
  assert.equal(await runCli(['status', SLUG, '--project', root, '--json'], x.value, deps), 0);
  assert.equal((JSON.parse(x.out[0]) as { runs: Array<{ status: string }> }).runs[0].status, 'done');

  // Consistência de envelopes: TODO send é `codex queue --thread <uuid> --message
  // <envelope>` e cada envelope bate com a mensagem persistida (conteúdo).
  const byId = new Map(finalState.messages.map(m => [m.messageId, m]));
  for (const rec of harness.envelopes) {
    assert.equal(rec.args[0], 'queue');
    assert.equal(rec.args[1], '--thread');
    assert.equal(rec.args[2], rec.threadId);
    assert.equal(rec.args[3], '--message');
    assert.equal(rec.args[4], rec.raw, 'mensagem inteira como UM argumento (M2-F1)');
    const msg = byId.get(rec.envelope.messageId);
    assert.ok(msg, 'envelope referencia mensagem persistida');
    assertEnvelope(rec, msg, rec.threadId);
  }
  // Contagem exata de efeitos externos: 0 create; 26 sends
  // (start 2; 9 transições não-terminais ×2; done 1; conversa 2; remap 1; recover 2).
  assert.equal(harness.ghCreateCalls, 0);
  assert.equal(harness.queueSends(), 26, `sends: ${harness.queueSends()}`);
  // Toda entrega encerrada carrega o receipt nativo; contrato final válido.
  for (const d of finalState.deliveries) {
    if (['enqueued', 'received', 'completed'].includes(d.status)) assert.ok(d.nativeMessageId, `receipt nativo em ${d.status}`);
  }
  assert.doesNotThrow(() => validateRuntime(finalState), 'estado final satisfaz o contrato (validateRuntime)');
});

function assertEnvelope(rec: QueueRec, msg: Message, expectedThread: string): void {
  assert.equal(rec.threadId, expectedThread, 'thread do envelope = sessão destinatária');
  assert.equal(rec.envelope.messageId, msg.messageId);
  assert.equal(rec.envelope.projectId, msg.projectId);
  assert.equal(rec.envelope.from, msg.from);
  assert.equal(rec.envelope.type, msg.type);
  assert.equal(rec.envelope.body, msg.body);
  assert.equal(rec.envelope.runId ?? null, msg.runId ?? null);
  assert.equal(rec.envelope.stage ?? null, msg.stage ?? null);
  assert.equal(rec.envelope.revision ?? null, msg.revision ?? null);
}

// C11 pela CLI pública: receive com checkpoint -> interrupção -> substituição ->
// recover --claim -> resume com checkpoint -> conclusão via next (sem finish manual da task).
test('claim: checkpoint, interrupção, recover --claim e resume pela geração vigente', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-claim-'));
  const harness = new FlowHarness();
  const deps = { runner: harness.runner, herdr: new InstantHerdr(root, PROJECT_ID) as HerdrAdapter };
  const store = () => new StateStore(join(root, '.sdlc-codex'), { projectId: PROJECT_ID });
  const actor = async (role: Role) => {
    const s = (await store().read()).sessions.find(x => x.role === role && x.status === 'ready');
    assert.ok(s?.threadId);
    return s;
  };
  await adoptProject(root, CONFIG, harness.runner);
  await writeApproval(root);
  let x = io();
  assert.equal(await runCli(['up', 'claim-1', '--workflow', 'feature', '--project', root, '--json'], x.value, deps), 0);
  x = io();
  assert.equal(await runCli(['start', 'claim-1', '--intent', 'intent.md', '--plan', 'plan.md', '--approval', 'approval.json', '--workflow', 'feature', '--project', root, '--json'], x.value, deps), 0);

  const task = (await store().read()).messages.find(m => m.type === 'task' && m.to === 'dev')!;
  const dev0 = await actor('dev');
  await writeFile(join(root, 'ckpt.txt'), 'estado intermediário do build');
  x = io();
  assert.equal(await runCli(['receive', task.messageId, '--role', 'dev', '--thread', dev0.threadId!, '--generation', dev0.generationId, '--checkpoint', 'ckpt.txt', '--project', root, '--json'], x.value, deps), 0);
  assert.match(x.out[0], /execute/);
  assert.equal((await store().read()).deliveries.find(d => d.messageId === task.messageId)!.checkpoint, 'estado intermediário do build');

  // Interrupção da sessão + substituição humana.
  await writeFile(join(root, 'end.json'), JSON.stringify({ type: 'SessionEnd', session_id: dev0.threadId }));
  x = io();
  assert.equal(await runCli(['hook', 'SessionEnd', '--payload-file', 'end.json', '--project', root, '--json'], x.value, deps), 0);
  x = io();
  assert.equal(await runCli(['up', 'claim-1', '--roles', 'dev', '--project', root, '--json'], x.value, deps), 0);
  const dev1 = await actor('dev');

  // recover --claim valida identidade, remapeia e devolve resume com checkpoint.
  x = io();
  assert.equal(await runCli(['recover', '--claim', task.messageId, '--role', 'dev', '--thread', dev1.threadId!, '--generation', dev1.generationId, '--project', root, '--json'], x.value, deps), 0, x.err.join('\n'));
  const claimOut = JSON.parse(x.out[0]) as Array<{ action: string; checkpoint?: string }>;
  assert.equal(claimOut[0].action, 'resume');
  assert.match(claimOut[0].checkpoint ?? '', /estado intermediário/);

  // receive pela geração vigente retoma com o checkpoint preservado.
  x = io();
  assert.equal(await runCli(['receive', task.messageId, '--role', 'dev', '--thread', dev1.threadId!, '--generation', dev1.generationId, '--project', root, '--json'], x.value, deps), 0);
  assert.match(x.out[0], /resume/);

  // Conclusão da task ocorre junto do next (finish-message não conclui task).
  // M4-F2: check executado pelo produto antes da rubrica importada.
  const chk = io();
  assert.equal(await runCli(['check', 'claim-1', '--stage', 'build', '--thread', dev1.threadId!, '--generation', dev1.generationId, '--project', root, '--json'], chk.value, deps), 0, chk.err.join('\n'));
  const claimSnapshot = (JSON.parse(chk.out[0]) as { snapshot: unknown }).snapshot;
  assert.ok(claimSnapshot, 'check informa o snapshot copiado pela rubrica');
  const run = (await store().read()).runs.find(r => r.slug === 'claim-1')!;
  const claimFile = await writeRubricFile({
    root, slug: 'claim-1', stage: 'build', ids: ['REQ-1'], projectId: PROJECT_ID, run, sess: dev1, snapshot: claimSnapshot,
    commit: HEAD, idOf: () => 'ev-claim-req', timestamp: '2026-09-19T03:00:00Z',
  });
  x = io();
  assert.equal(await runCli(['next', 'claim-1', 'build', 'pass', '--revision', String(run.revision), '--operation-id', 'op-claim',
    '--evidence', claimFile, '--role', 'dev', '--thread', dev1.threadId!, '--generation', dev1.generationId, '--project', root, '--json'], x.value, deps), 0, x.err.join('\n'));
  const afterNext = await store().read();
  assert.equal(afterNext.deliveries.find(d => d.messageId === task.messageId)?.status, 'completed', 'task concluída na mesma transação do next');
});

// C09/R4-05 pela CLI: evidência obsoleta (commit antigo) é rejeitada; --commit
// divergente falha antes; evidência válida no HEAD verificado avança.
test('next recusa evidência obsoleta e --commit que diverge do HEAD verificado', async () => {
  const p = await FlowProject.create({ projectId: PROJECT_ID, slug: 'stale-1', name: 'Feat' });
  await p.boot();
  const dev = await p.actor('dev');
  // check executado pelo produto no HEAD verificado (build+lint aprovados, logs reais).
  const chk = await p.check('build', dev);
  assert.equal(chk.code, 0, chk.err);

  // Evidência de commit antigo (rubrica e snapshot coerentes ENTRE SI, mas obsoletos diante do HEAD
  // verificado): a importação passa e o GATE recusa (exit 3), estado preservado.
  const staleSnapshot = { ...(chk.payload.snapshot as Record<string, unknown>), commit: 'deadbeef' };
  const staleFile = await p.rubric('build', ['REQ-1'], staleSnapshot, { sess: dev, commit: 'deadbeef', timestamp: '2026-09-19T04:00:00Z' });
  const beforeStale = await p.fingerprint();
  const stale = await p.next('build', 'pass', staleFile, { sess: dev, opId: 'op-stale' });
  assert.equal(stale.code, 3);
  assert.match(stale.err, /obsolet|deadbeef|snapshot/);
  const afterStale = await p.state();
  assert.equal(afterStale.runs.find(r => r.slug === 'stale-1')!.stage, 'build');
  // Rejeição sem transição E sem mesclar evidência: operação registrada como rejected.
  assert.ok(!afterStale.evidence.some(e => e.commit === 'deadbeef'), 'evidência obsoleta não é mesclada ao estado');
  assert.equal(afterStale.operations['op-stale'].accepted, false);
  assert.equal(afterStale.operations['op-stale'].status, 'rejected');
  assert.equal((await p.fingerprint()).evidence, beforeStale.evidence);
  assert.equal((await p.fingerprint()).messages, beforeStale.messages, 'nenhuma task/notify criada');

  // R5-05: commit da rubrica que diverge do commit do codeSnapshot (incoerente ENTRE SI) é recusado
  // já na importação (exit 3) — não há "preenchimento" de commit retroativo.
  const incoherent = await p.rubric('build', ['REQ-1'], chk.payload.snapshot, { sess: dev, commit: 'deadbeef' });
  const inc = await p.next('build', 'pass', incoherent, { sess: dev, opId: 'op-incoerente' });
  assert.equal(inc.code, 3);
  assert.match(inc.err, /diverge do commit do codeSnapshot/);

  // --commit divergente do HEAD verificado: falha de argumento (exit 2) antes de qualquer escrita.
  const okFile = await p.rubric('build', ['REQ-1'], chk.payload.snapshot, { sess: dev, timestamp: '2026-09-19T04:00:00Z' });
  const opsBefore = Object.keys((await p.state()).operations).length;
  const wrongCommit = await p.next('build', 'pass', okFile, { sess: dev, opId: 'op-commit', extra: ['--commit', 'outro123'] });
  assert.equal(wrongCommit.code, 2);
  assert.equal(Object.keys((await p.state()).operations).length, opsBefore, '--commit divergente não grava operação');

  // Evidência válida no HEAD verificado (snapshot copiado do check): passa.
  const ok = await p.next('build', 'pass', okFile, { sess: dev, opId: 'op-ok' });
  assert.equal(ok.code, 0, ok.err);
  assert.equal((await p.state()).runs.find(r => r.slug === 'stale-1')!.stage, 'review');
});

// ---------------------------------------------------------------------------
// M7-F1 (R4-13) — variantes de workflow e identidade de execução na fronteira
// pública: hotfix sem e2e/document, review-only sem PR, reuso de slug com run
// terminal antigo, e dois projetos independentes em paralelo. Tudo com falsos;
// checks reais do produto e rubricas com log íntegro — nada de checks vazios.
// ---------------------------------------------------------------------------

test('variantes: hotfix sem e2e/document, review-only sem PR, reuso de slug e dois projetos', async () => {
  // Projeto A: hotfix.
  const a = await FlowProject.create({ projectId: PROJECT_ID, name: 'Feat' });
  const hx = 'hx-1';
  const runA = () => a.run(hx);
  const hxId = await a.boot(hx, 'hotfix');
  const devA = await a.actor('dev');

  // build pass (checks reais aprovados com log: afirmado em FlowProject.pass).
  await a.receiveTask('build', devA, hx);
  let res = await a.pass('build', { sess: devA, slug: hx });
  assert.equal(res.code, 0, res.err);

  // Projeto B (review-only) executa EM PARALELO com A parado em review:
  // independência de estado entre projetos. review-only tem matriz mecânica vazia por design
  // (só rubrica humana); o snapshot ainda é informado por `check` e copiado pela rubrica.
  const b = await FlowProject.create({ projectId: PROJECT_ID, name: 'Feat' });
  const ro = 'ro-1';
  await b.boot(ro, 'review-only');
  const revB = await b.actor('reviewer');
  await b.receiveTask('review', revB, ro);
  const resB = await b.pass('review', { sess: revB, slug: ro });
  assert.equal(resB.code, 0, resB.err);
  const runB = (await b.state()).runs.find(r => r.slug === ro)!;
  assert.equal(runB.status, 'done', 'review-only conclui no único estágio');
  assert.equal(runB.history.map(h => h.stage).join(','), 'review');
  assert.equal(b.harness.ghCreateCalls + b.harness.ghListCalls + b.harness.ghViewCalls, 0, 'review-only NUNCA toca o gh (nem create, nem list, nem view)');
  // A não foi afetado pelo projeto B.
  assert.equal((await runA()).status, 'running');
  assert.equal((await runA()).stage, 'review');

  // A: review pass → pr (PR criada exatamente uma vez) → pr-review → done.
  const revA = await a.actor('reviewer');
  await a.receiveTask('review', revA, hx);
  res = await a.pass('review', { sess: revA, slug: hx });
  assert.equal(res.code, 0, res.err);
  await a.receiveTask('pr', devA, hx);
  res = await a.pass('pr', { sess: devA, slug: hx });
  assert.equal(res.code, 0, res.err);
  assert.equal(a.harness.ghCreateCalls, 1, 'hotfix cria exatamente uma PR');
  const r1 = await runA();
  assert.equal(r1.stage, 'pr-review');
  assert.ok(r1.pullRequest?.url, 'PR vinculada à execução');
  await a.receiveTask('pr-review', revA, hx);
  const viewsBefore = a.harness.ghViewCalls;
  res = await a.pass('pr-review', { sess: revA, slug: hx });
  assert.equal(res.code, 0, res.err);
  assert.ok(a.harness.ghViewCalls > viewsBefore, 'hotfix fecha em pr-review OBSERVANDO a PR (R5-07)');
  const rDone = await runA();
  assert.equal(rDone.status, 'done', 'hotfix fecha em pr-review (sem e2e/document)');
  assert.deepEqual(rDone.history.map(h => `${h.stage}:${h.result}`), [
    'build:pass', 'review:pass', 'pr:pass', 'pr-review:pass',
  ]);
  assert.equal(rDone.runId, hxId);

  // Reuso de slug (R4-07 pela fronteira): novo run no mesmo projeto/slug após
  // terminal — o antigo permanece done e o novo NÃO é bloqueado por ele.
  const hx2Id = await a.boot(hx, 'hotfix');
  assert.notEqual(hx2Id, hxId, 'nova execução = novo runId');
  const runs = (await a.state()).runs.filter(r => r.slug === hx);
  assert.equal(runs.length, 2);
  const oldRun = runs.find(r => r.runId === hxId)!;
  const newRun = runs.find(r => r.runId === hx2Id)!;
  assert.equal(oldRun.status, 'done', 'run terminal antigo preservado intacto');
  assert.equal(newRun.status, 'running');
  assert.equal(newRun.stage, 'build');
  assert.deepEqual(oldRun.history.map(h => h.stage), ['build', 'review', 'pr', 'pr-review'], 'histórico antigo imutável');
  // O novo run avança de fato (não fica bloqueado pelo slug histórico).
  const devA2 = await a.actor('dev');
  await a.receiveTask('build', devA2, hx);
  res = await a.pass('build', { sess: devA2, slug: hx });
  assert.equal(res.code, 0, res.err);
  assert.equal((await a.run(hx)).stage, 'review', 'novo run progrediu — identidade única da execução (R4-07)');
  const stateA = await a.state();
  const stateB = await b.state();
  assert.doesNotThrow(() => validateRuntime(stateA));
  assert.doesNotThrow(() => validateRuntime(stateB));
});
