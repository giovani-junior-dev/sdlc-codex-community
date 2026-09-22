import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { StateStore } from '../../src/state/store.js';
import { FakeProcessRunner } from '../../src/adapters/process.js';
import type { HerdrAdapter } from '../../src/adapters/herdr.js';
import { FlowProject, InstantHerdr, io, sha256 } from './flow-fixtures.js';

const PROJECT_ID = '11111111-2222-3333-4444-555555555502';
const CONFIG = { schemaVersion: 1, projectId: PROJECT_ID, projectName: 'Flow', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'] };

function gitFake() {
  return new FakeProcessRunner((_, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'cat-file') return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'worktree') return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'show-ref') return { exitCode: 1, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
}

async function adoptProject(root: string): Promise<void> {
  const cfg = join(root, 'incoming.json');
  await writeFile(cfg, JSON.stringify(CONFIG));
  const x = io();
  assert.equal(await runCli(['adopt', '--config', cfg, '--project', root, '--apply', '--json'], x.value), 0);
}

// R06/R07/R13 + R5: fluxo público completo com dependências injetáveis e adaptadores falsos nas bordas.
// review-only (checks:{} é legítimo aqui: o método não exige check mecânico nesse workflow).
test('fluxo completo: adopt → up → start → next pass → done', async () => {
  const p = await FlowProject.create({
    projectId: PROJECT_ID, slug: 'demanda-1', workflow: 'review-only', checks: {}, name: 'Flow',
    approval: { entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }] },
  });
  // up: time completo do review-only; start com aprovação COBRINDO o manifesto (R5-05).
  const team = await p.up();
  assert.ok(team.length >= 1);
  await p.approve();
  const started = await p.start();
  assert.equal(started.code, 0, started.err);

  // Rubrica de revisão com proveniência completa (M4-F1 + R5): runId/stage/projectId/revisão/produtor,
  // log real íntegro (logHash confere) e codeSnapshot copiado do `check` (a importação nunca o preenche).
  const reviewer = await p.actor('reviewer');
  const chk = await p.check('review', reviewer);
  assert.equal(chk.code, 0, chk.err);
  assert.deepEqual(chk.payload.checks, [], 'review-only não executa check mecânico; o snapshot ainda é informado');
  assert.ok(chk.payload.snapshot, 'snapshot informado mesmo sem checks');

  // Identidade inválida (geração desconhecida): rejeitada SEM transição — a evidência é válida para a
  // identidade declarada, isolando a rejeição no ator (não na importação).
  const impostor = { ...reviewer, threadId: 'thread-reviewer', generationId: 'gen-x' };
  const badFile = await p.rubric('review', ['REQ-1'], chk.payload.snapshot, { sess: impostor });
  const before = await p.fingerprint();
  const bad = await p.next('review', 'pass', badFile, { sess: impostor, opId: 'op-bad' });
  assert.equal(bad.code, 3); // identidade inválida: rejeitada sem transição
  assert.match(bad.err, /não autorizada|divergente|obsoleto/);
  const afterBad = await p.fingerprint();
  assert.equal(afterBad.stage, before.stage);
  assert.equal(afterBad.revision, before.revision);
  assert.equal(afterBad.evidence, before.evidence, 'evidência da identidade inválida não é mesclada');
  assert.equal(afterBad.messages, before.messages, 'nenhuma task/notify criada');

  // Identidade vigente (geração registrada pelo hook): avança.
  const file = await p.rubric('review', ['REQ-1'], chk.payload.snapshot, { sess: reviewer });
  const okRes = await p.next('review', 'pass', file, { sess: reviewer, opId: 'op-1' });
  assert.equal(okRes.code, 0, okRes.err);
  assert.equal((JSON.parse(okRes.out) as { status: string }).status, 'done');

  // Replay do mesmo operationId (mesma revisão-base 0 e mesmo arquivo): idempotente, sem nova transição.
  const store = p.store();
  const revBefore = (await store.read()).revision;
  const replay = await p.next('review', 'pass', file, { sess: reviewer, opId: 'op-1', revision: 0 });
  assert.equal(replay.code, 0, replay.err);
  assert.equal((JSON.parse(replay.out) as { replay?: boolean }).replay, true);
  assert.equal((await store.read()).revision, revBefore);

  const x = io();
  assert.equal(await runCli(['status', 'demanda-1', '--project', p.root, '--json'], x.value, p.deps), 0);
  assert.match(x.out[0], /done/);
});

// R07 + R5-05: start rejeita workflow inexistente, arquivos ausentes, data inválida, aprovação sem
// vínculos, manifesto ausente/divergente e time vazio.
test('start valida workflow, arquivos, aprovação, manifesto e time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-start-'));
  await adoptProject(root);
  const deps = { runner: gitFake(), herdr: new InstantHerdr(root, PROJECT_ID) as HerdrAdapter };
  const startArgs = (extra: string[] = []) => ['start', 's', '--intent', 'i.md', '--plan', 'p.md', '--approval', 'a.json', ...extra, '--project', root];
  let x = io();
  assert.equal(await runCli(startArgs(['--workflow', 'inexistente']), x.value, deps), 2);
  x = io();
  assert.equal(await runCli(startArgs(), x.value, deps), 2); // arquivos ausentes
  const PLAN = 'y REQ-1\n';
  await writeFile(join(root, 'i.md'), 'x');
  await writeFile(join(root, 'p.md'), PLAN);
  await writeFile(join(root, 'a.json'), JSON.stringify({ approvedBy: 'h', approvedAt: 'data-errada' }));
  x = io();
  assert.equal(await runCli(startArgs(), x.value, deps), 2);
  // C08: aprovação sem hashes previamente registrados é recusada (exit 2).
  await writeFile(join(root, 'a.json'), JSON.stringify({ approvedBy: 'h', approvedAt: '2026-09-19T00:00:00Z', planVersion: 'plano-v1' }));
  x = io();
  assert.equal(await runCli(startArgs(), x.value, deps), 2);
  // C08: plano alterado após a aprovação invalida o hash registrado.
  const approvalBase = { approvedBy: 'h', approvedAt: '2026-09-19T00:00:00Z', planVersion: 'plano-v1', intentHash: sha256('x'), planHash: sha256(PLAN) };
  await writeFile(join(root, 'a.json'), JSON.stringify(approvalBase));
  await writeFile(join(root, 'p.md'), `${PLAN}ALTERADO\n`);
  x = io();
  assert.equal(await runCli(startArgs(), x.value, deps), 2);
  await writeFile(join(root, 'p.md'), PLAN);

  // R5-05 (substitui "aprovação íntegra sem manifesto inicia"): o manifesto é OBRIGATÓRIO no registro de
  // aprovação — hashes íntegros mas sem requirementsManifestPath/Hash não inicia (exit 2), e sem execução.
  x = io();
  assert.equal(await runCli(startArgs(['--workflow', 'review-only']), x.value, deps), 2);
  assert.match(x.err.join('\n'), /manifesto/i);
  const manifest = JSON.stringify({ schemaVersion: 1, planPath: 'p.md', planHash: sha256(PLAN), entries: [{ id: 'REQ-1', stage: 'any', mandatory: true }] });
  await writeFile(join(root, 'requirements.json'), manifest);
  // manifesto cujo hash difere do registrado na aprovação: recusado.
  await writeFile(join(root, 'a.json'), JSON.stringify({ ...approvalBase, requirementsManifestPath: 'requirements.json', requirementsManifestHash: sha256('outro') }));
  x = io();
  assert.equal(await runCli(startArgs(['--workflow', 'review-only']), x.value, deps), 2);
  assert.match(x.err.join('\n'), /manifesto/i);
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId: PROJECT_ID });
  assert.equal((await store.read().catch(() => ({ runs: [] }))).runs.length, 0, 'nenhuma execução criada pelas recusas');

  // Aprovação íntegra COM manifesto coberto: sem time, falha como indisponível (4).
  await writeFile(join(root, 'a.json'), JSON.stringify({ ...approvalBase, requirementsManifestPath: 'requirements.json', requirementsManifestHash: sha256(manifest) }));
  x = io();
  assert.equal(await runCli(startArgs(['--workflow', 'review-only']), x.value, deps), 4); // time vazio
});

// R01/R07: doctor e status são somente leitura — nunca criam estado.
test('doctor não cria, recupera ou altera estado', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-doc-'));
  const x = io();
  await runCli(['doctor', '--project', root, '--json'], x.value, { runner: gitFake() });
  const parsed = JSON.parse(x.out[0]) as { checks: { runtime: { readable: boolean } } };
  assert.equal(parsed.checks.runtime.readable, false);
  await assert.rejects(() => stat(join(root, '.sdlc-codex', 'runtime.json')));
  // status sobre corrupção não destrói nada
  await adoptProject(root);
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId: PROJECT_ID });
  await store.init(PROJECT_ID);
  const before = await readFile(store.backupPath, 'utf8');
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(store.runtimePath, '{quebrado');
  const y = io();
  assert.equal(await runCli(['status', '--project', root, '--json'], y.value), 1);
  assert.equal(await readFile(store.backupPath, 'utf8'), before);
});
