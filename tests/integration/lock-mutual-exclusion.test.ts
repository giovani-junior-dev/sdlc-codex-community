/**
 * M1-F2 — Regressões de exclusão mútua do estado por projeto (R5-01 / R5-02).
 *
 * Substitui tests/integration/lock-recovery-race.test.ts, que exercitava o protocolo
 * da rodada 4 (manager lock + quarentena + marcador de recuperação). A reprodução
 * determinística dos dois defeitos contra aquele código está em
 * docs/validation/round-5/m1-race-red.log; o protocolo novo está em
 * docs/validation/round-5/m1-lock-protocol.md.
 *
 * Regras destes testes: liveness com subprocesso Node REAL que morre (child.kill()),
 * concorrência medida por contador real (ENTER/EXIT em arquivo compartilhado, máximo
 * simultâneo <= 1), conteúdo persistido conferido, nenhuma execução aleatória como prova.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StateStore, StateConflictError, lockTestHooks } from '../../src/state/store.js';
import type { Runtime } from '../../src/contracts.js';

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** C02.5: nenhuma remoção recursiva sem confirmar que o alvo é temporário deste teste. */
async function safeRm(root: string): Promise<void> {
  const target = resolve(root);
  assert.ok(
    target.startsWith(resolve(tmpdir())) && basename(target).startsWith('sdlc-r5-'),
    `recusa remover caminho fora do temporário do teste: ${target}`,
  );
  await rm(target, { recursive: true, force: true });
}

async function fresh(projectId: string, lockWaitMs = 10_000): Promise<{ root: string; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-r5-'));
  const store = new StateStore(root, { projectId, lockWaitMs });
  await store.init(projectId);
  return { root, store };
}

function childScript(): string {
  return fileURLToPath(new URL('./lock-child.js', import.meta.url));
}

interface Child { proc: ReturnType<typeof spawn>; out: () => string; dead: Promise<void> }

function startChild(root: string, mode: string, logFile?: string, holdMs?: number): Child {
  const args = [childScript(), root, mode, ...(logFile ? [logFile] : []), ...(holdMs !== undefined ? [String(holdMs)] : [])];
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout?.on('data', d => { out += String(d); });
  proc.stderr?.on('data', d => { out += String(d); });
  const dead = new Promise<void>(r => proc.on('exit', () => r()));
  return { proc, out: () => out, dead };
}

async function waitFor(check: () => boolean, what: string, tries = 1_200): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) await delay(10);
  assert.ok(check(), `condição não alcançada: ${what}`);
}

/** PID garantidamente morto (subprocesso Node real já encerrado). */
async function deadPid(): Promise<number> {
  const probe = await execFileAsync(process.execPath, ['-e', 'console.log(process.pid)']);
  return Number(probe.stdout.trim());
}

/**
 * Planta os artefatos EXATOS que o protocolo da rodada 4 usava como autoridade,
 * todos com dono comprovadamente morto: state.lock, state.lock.manager e
 * state.lock.recover. No protocolo novo nada disso autoriza nem impede coisa alguma.
 */
async function plantLegacyArtifacts(root: string): Promise<number> {
  const pid = await deadPid();
  for (const dir of ['state.lock', 'state.lock.manager', 'state.lock.recover']) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'owner.json'), JSON.stringify({
      pid, processStartMs: Date.now() - 10_000, token: `legado-${dir}`,
      acquiredAt: new Date().toISOString(), ownerIdentity: `${pid}:0:legado`,
    }), 'utf8');
  }
  return pid;
}

/** Máximo simultâneo REAL dentro da seção crítica, a partir do log ENTER/EXIT. */
async function maxConcurrency(logFile: string): Promise<{ max: number; trace: string[] }> {
  const trace = (await readFile(logFile, 'utf8')).split('\n').filter(l => l.trim().length);
  let depth = 0; let max = 0;
  for (const line of trace) {
    if (line.startsWith('ENTER')) { depth++; max = Math.max(max, depth); }
    else if (line.startsWith('EXIT')) depth--;
  }
  return { max, trace };
}

function appendEvent(kind: string, detail: string) {
  return (s: Runtime): { state: Runtime; result: undefined } => ({
    state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind, detail }] },
    result: undefined,
  });
}

function resetHooks(): void {
  lockTestHooks.afterAuthorityAcquired = undefined;
  lockTestHooks.afterLockAcquired = undefined;
  lockTestHooks.afterLeftoversObserved = undefined;
  lockTestHooks.beforeRuntimeRename = undefined;
  lockTestHooks.beforeLegacyBackup = undefined;
}

test('R5-01 lockStatus sob rajada não torna reutilizável a autoridade da seção crítica', async () => {
  const { root, store } = await fresh('status-storm', 8_000);
  try {
    const moduleUrl = new URL('../../src/state/store.js', import.meta.url).href;
    const authority = await (store as unknown as { authorityName(): Promise<string> }).authorityName();
    const holderScript = `
      const { StateStore } = await import(${JSON.stringify(moduleUrl)});
      const s = new StateStore(${JSON.stringify(root)}, { projectId: 'status-storm', lockWaitMs: 8000 });
      await s.mutate(async state => { console.log('HOLDER_IN'); await new Promise(r => setTimeout(r, 5500)); return { state, result: undefined }; });
    `;
    const greedyScript = `
      const { open } = await import('node:fs/promises');
      const { constants } = await import('node:fs');
      const end = Date.now() + 4300; let reused = 0;
      while (Date.now() < end) {
        try {
          const h = await open(${JSON.stringify(authority)}, 0x10000000 | constants.O_CREAT | constants.O_RDWR, 0o600);
          reused++; await h.close();
        } catch {}
      }
      console.log('REUSED ' + reused);
    `;
    const proberScript = `
      const { StateStore } = await import(${JSON.stringify(moduleUrl)});
      const s = new StateStore(${JSON.stringify(root)}, { projectId: 'status-storm' });
      const end = Date.now() + 4000;
      while (Date.now() < end) await Promise.all(Array.from({ length: 30 }, () => s.lockStatus()));
    `;
    const runScript = (script: string) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout.on('data', d => { output += String(d); });
      proc.stderr.on('data', d => { output += String(d); });
      return { proc, output: () => output, done: new Promise<number | null>(resolve => proc.on('exit', resolve)) };
    };
    const holder = runScript(holderScript);
    await waitFor(() => holder.output().includes('HOLDER_IN'), 'detentor entrou');
    const greedy = runScript(greedyScript);
    const prober = runScript(proberScript);
    assert.equal(await greedy.done, 0, greedy.output());
    assert.equal(await prober.done, 0, prober.output());
    assert.equal(await holder.done, 0, holder.output());
    const reused = Number(/REUSED (\d+)/.exec(greedy.output())?.[1] ?? -1);
    assert.equal(reused, 0, 'uma sonda jamais pode tornar o nome da autoridade reutilizável enquanto o detentor vive');
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// R5-01 — leftovers de dono morto não autorizam ninguém; escritores reais serializam.
// Corrida A do plano traduzida para o protocolo novo: nenhuma observação anterior
// é usada para agir, então "A pausa e retoma" não desloca B em nenhum ponto.
// Repetido 3x para checar flake (não como prova estatística: cada rodada é
// determinística no que afirma — máximo simultâneo <= 1 e conteúdo conferido).
// ---------------------------------------------------------------------------
test('R5-01 três escritores reais com leftovers do protocolo antigo: máximo simultâneo 1 e três revisões', async () => {
  for (let round = 1; round <= 3; round++) {
    const { root, store } = await fresh(`r5-01-${round}`);
    try {
      await plantLegacyArtifacts(root);
      const logFile = join(root, 'meter.log');
      await writeFile(logFile, '', 'utf8');

      const children = [1, 2, 3].map(() => startChild(root, 'write-slow', logFile, 250));
      await Promise.all(children.map(c => c.dead));
      for (const c of children) assert.match(c.out(), /DONE/, `filho falhou: ${c.out()}`);

      const { max, trace } = await maxConcurrency(logFile);
      assert.equal(max, 1, `rodada ${round}: máximo simultâneo na seção crítica\n${trace.join('\n')}`);
      assert.equal(trace.length, 6, `rodada ${round}: 3 ENTER + 3 EXIT\n${trace.join('\n')}`);

      // Conteúdo persistido: nenhuma mutação perdida, revisões estritamente sucessivas.
      const after = await store.read();
      assert.equal(after.revision, 3, `rodada ${round}: uma revisão por escritor`);
      assert.equal(after.events.filter(e => e.kind === 'w').length, 3);
      assert.equal(new Set(after.events.filter(e => e.kind === 'w').map(e => e.detail)).size, 3, 'um evento por PID');
    } finally { await safeRm(root); }
  }
});

// ---------------------------------------------------------------------------
// R5-01 — detentor VIVO em subprocesso: ninguém entra enquanto ele segura; ao
// morrer, o próximo entra de imediato (sem TTL, sem sonda de PID, sem timeout).
// ---------------------------------------------------------------------------
test('R5-01 detentor vivo bloqueia; morte do detentor libera imediatamente', async () => {
  const { root, store } = await fresh('r5-01-vivo');
  try {
    const holder = startChild(root, 'hold');
    await waitFor(() => holder.out().includes('LOCKED'), 'filho entrou na seção crítica');

    // Sonda somente-leitura enxerga o detentor real.
    const held = await store.lockStatus();
    assert.equal(held.held, 'yes');
    assert.equal(held.info?.pid, holder.proc.pid, 'informação aponta o PID do detentor');

    let entered = false;
    const pending = store.mutate(s => { entered = true; return appendEvent('depois', 'x')(s); });
    await delay(400);
    assert.equal(entered, false, 'nenhum outro escritor entra enquanto o detentor vive');
    assert.equal((await store.read()).revision, 0, 'estado intocado durante a espera');

    const mortoEm = Date.now();
    holder.proc.kill();
    await holder.dead;
    await pending;
    const esperou = Date.now() - mortoEm;
    assert.ok(entered, 'o próximo escritor entrou após a morte do detentor');
    assert.ok(esperou < 2_000, `liberação imediata após a morte (esperou ${esperou} ms)`);
    assert.equal((await store.read()).revision, 1);

    // O owner.json do detentor morto é inerte: foi sobrescrito, não consultado.
    const status = await store.lockStatus();
    assert.equal(status.held, 'no');
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// R5-02 — recuperação explícita participa da MESMA exclusão: com detentor vivo
// ela falha fechada e não remove nada (nem o lock, nem os leftovers).
// ---------------------------------------------------------------------------
test('R5-02 recuperação explícita nunca remove lock vivo; após a morte do detentor limpa os leftovers', async () => {
  const { root } = await fresh('r5-02-vivo');
  try {
    await plantLegacyArtifacts(root);
    const holder = startChild(root, 'hold');
    await waitFor(() => holder.out().includes('LOCKED'), 'filho entrou na seção crítica');

    const antes = JSON.parse(await readFile(join(root, 'state.lock', 'owner.json'), 'utf8')) as { pid: number };
    assert.equal(antes.pid, holder.proc.pid, 'informação em disco é a do detentor vivo');

    const recover = new StateStore(root, { projectId: 'r5-02-vivo', lockWaitMs: 400 });
    await assert.rejects(() => recover.recoverStaleLocks(), StateConflictError);

    // Nada foi tocado: lock do detentor intacto e leftovers preservados.
    const depois = JSON.parse(await readFile(join(root, 'state.lock', 'owner.json'), 'utf8')) as { pid: number };
    assert.deepEqual(depois, antes, 'informação do detentor vivo preservada');
    for (const dir of ['state.lock.manager', 'state.lock.recover']) {
      assert.ok(await stat(join(root, dir)).then(() => true, () => false), `${dir} preservado na recusa`);
    }
    assert.equal((await recover.read()).revision, 0, 'estado intocado na recusa');

    holder.proc.kill();
    await holder.dead;
    const cleanup = await recover.recoverStaleLocks();
    assert.deepEqual(cleanup.removed, ['state.lock.manager', 'state.lock.recover']);
    for (const dir of ['state.lock.manager', 'state.lock.recover']) {
      assert.equal(await stat(join(root, dir)).then(() => true, () => false), false, `${dir} removido`);
    }
    assert.equal((await recover.read()).revision, 0, 'limpeza não altera o estado');
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// R5-02 — dois recuperadores simultâneos + um escritor: seção crítica serial.
// ---------------------------------------------------------------------------
test('R5-02 dois recuperadores e um escritor simultâneos: máximo simultâneo 1', async () => {
  for (let round = 1; round <= 3; round++) {
    const { root, store } = await fresh(`r5-02-conc-${round}`);
    try {
      await plantLegacyArtifacts(root);
      const logFile = join(root, 'meter.log');
      await writeFile(logFile, '', 'utf8');

      const children = [
        startChild(root, 'recover', logFile, 200),
        startChild(root, 'recover', logFile, 200),
        startChild(root, 'write-slow', logFile, 200),
      ];
      await Promise.all(children.map(c => c.dead));
      assert.match(children[0]!.out(), /RECOVER/, children[0]!.out());
      assert.match(children[1]!.out(), /RECOVER/, children[1]!.out());
      assert.match(children[2]!.out(), /DONE/, children[2]!.out());

      const { max, trace } = await maxConcurrency(logFile);
      assert.equal(max, 1, `rodada ${round}: máximo simultâneo\n${trace.join('\n')}`);
      assert.equal(trace.length, 6, `rodada ${round}: 3 ENTER + 3 EXIT\n${trace.join('\n')}`);

      // Exatamente um recuperador encontra os leftovers; o outro encontra a limpeza feita.
      const removidos = [children[0]!, children[1]!]
        .map(c => JSON.parse(/RECOVER (\{.*\})/.exec(c.out())![1]!) as { removed: string[] });
      assert.equal(removidos.filter(r => r.removed.includes('state.lock.manager')).length, 1,
        'nenhum leftover é removido duas vezes');
      assert.equal((await store.read()).revision, 1, 'a mutação do escritor sobreviveu');
    } finally { await safeRm(root); }
  }
});

// ---------------------------------------------------------------------------
// Crash ANTES de gravar a informação: a autoridade é do SO, não do owner.json.
// ---------------------------------------------------------------------------
test('R5-01 crash antes de gravar owner.json: exclusão mantida e liberada na morte', async () => {
  const { root, store } = await fresh('r5-01-sem-info');
  try {
    const holder = startChild(root, 'hold-before-info');
    await waitFor(() => holder.out().includes('AUTHORITY'), 'filho obteve a autoridade');

    const status = await store.lockStatus();
    assert.equal(status.held, 'yes', 'autoridade detida mesmo sem informação em disco');
    assert.equal(status.info, undefined, 'nenhuma informação gravada ainda');

    const bloqueado = new StateStore(root, { projectId: 'r5-01-sem-info', lockWaitMs: 300 });
    await assert.rejects(() => bloqueado.mutate(appendEvent('nao', 'x')), StateConflictError);
    assert.equal((await store.read()).revision, 0, 'estado intocado');

    holder.proc.kill();
    await holder.dead;
    await store.mutate(appendEvent('depois', 'x'));
    assert.equal((await store.read()).revision, 1);
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// Crash com runtime.json.<uuid>.tmp em escrita (barreira real antes do rename).
// ---------------------------------------------------------------------------
test('R5-01 crash com temporário em escrita: principal e backup íntegros, sem revisão sem intenção', async () => {
  const { root, store } = await fresh('r5-01-temp');
  try {
    await store.mutate(appendEvent('base', 'um'));
    const principalAntes = await readFile(store.runtimePath, 'utf8');

    const holder = startChild(root, 'hold-temp');
    await waitFor(() => holder.out().includes('TEMP '), 'filho parou com o temporário gravado');
    holder.proc.kill();
    await holder.dead;

    // O principal não trocou: o rename é o único ponto de troca. O backup pode ter
    // avançado para a cópia do principal atual (passo legítimo anterior ao rename),
    // mas continua sendo uma versão VÁLIDA — nunca lixo nem estado vazio.
    assert.equal(await readFile(store.runtimePath, 'utf8'), principalAntes, 'principal íntegro');
    const backupDepois = JSON.parse(await readFile(store.backupPath, 'utf8')) as Runtime;
    assert.equal(backupDepois.projectId, 'r5-01-temp');
    assert.ok(backupDepois.revision <= 1, `backup é versão válida anterior ou igual (rev ${backupDepois.revision})`);
    const lido = await store.read();
    assert.equal(lido.revision, 1, 'nenhuma revisão gravada sem intenção persistida');
    assert.equal(lido.events.filter(e => e.kind === 'tmp').length, 0, 'mutação interrompida não vazou');

    // O temporário órfão é lixo inerte, listado e removido pela limpeza explícita.
    const orfaos = (await readdir(root)).filter(f => /^runtime\.json\..+\.tmp$/.test(f));
    assert.equal(orfaos.length, 1, `temporário órfão presente: ${orfaos.join(',')}`);
    const status = await store.lockStatus();
    assert.equal(status.held, 'no');
    assert.deepEqual(status.leftovers, ['state.lock', ...orfaos].sort());
    const cleanup = await store.recoverStaleLocks();
    assert.deepEqual(cleanup.removed, orfaos);
    assert.equal((await store.read()).revision, 1, 'limpeza não altera o estado');
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// Liberação tardia: release NUNCA remove a informação de outro detentor.
// Modelo: durante a seção crítica, a informação em disco é substituída pela de um
// detentor seguinte (é o que aconteceria se o pipe deste processo tivesse caído).
// ---------------------------------------------------------------------------
test('R5-01 liberação tardia não remove a informação do detentor seguinte', async (t) => {
  t.after(resetHooks);
  const { root, store } = await fresh('r5-01-tardia');
  try {
    const substituto = { pid: process.pid, processStartMs: 1, token: 'detentor-seguinte', acquiredAt: new Date().toISOString() };
    lockTestHooks.afterLockAcquired = async () => {
      await writeFile(join(root, 'state.lock', 'owner.json'), JSON.stringify(substituto), 'utf8');
    };
    await store.mutate(appendEvent('tardia', 'x'));
    resetHooks();

    const restante = JSON.parse(await readFile(join(root, 'state.lock', 'owner.json'), 'utf8')) as { token: string };
    assert.equal(restante.token, 'detentor-seguinte', 'informação do detentor seguinte preservada pelo release tardio');
    assert.equal((await store.read()).revision, 1, 'a mutação concluiu normalmente');
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// Timeout com detentor vivo: erro explícito e estado byte a byte intocado.
// ---------------------------------------------------------------------------
test('R5-01 timeout com detentor vivo: StateConflictError e estado intocado', async () => {
  const { root, store } = await fresh('r5-01-timeout');
  try {
    await store.mutate(appendEvent('base', 'um'));
    const principal = await readFile(store.runtimePath, 'utf8');
    const backup = await readFile(store.backupPath, 'utf8');

    const holder = startChild(root, 'hold');
    await waitFor(() => holder.out().includes('LOCKED'), 'detentor vivo');
    const ocupado = new StateStore(root, { projectId: 'r5-01-timeout', lockWaitMs: 300 });

    const inicio = Date.now();
    await assert.rejects(
      () => ocupado.mutate(appendEvent('nunca', 'x')),
      (e: unknown) => e instanceof StateConflictError && /detida por outro detentor/.test((e as Error).message),
    );
    assert.ok(Date.now() - inicio >= 300, 'esperou o lockWaitMs antes de desistir');
    const snapshot = await ocupado.read();
    await assert.rejects(() => ocupado.write({ ...snapshot, revision: snapshot.revision + 1 }, snapshot.revision), StateConflictError);

    assert.equal(await readFile(store.runtimePath, 'utf8'), principal, 'principal intocado');
    assert.equal(await readFile(store.backupPath, 'utf8'), backup, 'backup intocado');
    holder.proc.kill();
    await holder.dead;
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// recoverBackup também passa pela mesma exclusão.
// ---------------------------------------------------------------------------
test('R5-01 recoverBackup sob a mesma exclusão: recusa com detentor vivo, funciona depois', async () => {
  const { root, store } = await fresh('r5-01-backup');
  try {
    await store.mutate(appendEvent('v1', 'um'));
    await store.mutate(appendEvent('v2', 'dois'));
    const backupEsperado = JSON.parse(await readFile(store.backupPath, 'utf8')) as Runtime;
    assert.equal(backupEsperado.revision, 1, 'backup é a gravação válida anterior');

    const holder = startChild(root, 'hold');
    await waitFor(() => holder.out().includes('LOCKED'), 'detentor vivo');
    const bloqueado = new StateStore(root, { projectId: 'r5-01-backup', lockWaitMs: 300 });
    await assert.rejects(() => bloqueado.recoverBackup(), StateConflictError);
    assert.equal((await store.read()).revision, 2, 'principal intocado na recusa');

    holder.proc.kill();
    await holder.dead;
    const recuperado = await bloqueado.recoverBackup();
    assert.equal(recuperado.revision, 1);
    assert.equal((await store.read()).revision, 1, 'principal restaurado a partir do backup');
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// CAS: duas revisões concorrentes sobre a mesma base — uma aceita, outra recusada.
// ---------------------------------------------------------------------------
test('R5-01 duas revisões concorrentes na mesma base: uma aceita, outra StateConflictError', async () => {
  const { root, store } = await fresh('r5-01-cas');
  try {
    const base = await store.read();
    const a = new StateStore(root, { projectId: 'r5-01-cas', lockWaitMs: 10_000 });
    const b = new StateStore(root, { projectId: 'r5-01-cas', lockWaitMs: 10_000 });
    const snapshot = (detail: string): Runtime => ({
      ...base, revision: base.revision + 1,
      events: [...base.events, { at: new Date().toISOString(), kind: 'cas', detail }],
    });
    const resultados = await Promise.allSettled([
      a.write(snapshot('a'), base.revision),
      b.write(snapshot('b'), base.revision),
    ]);
    const ok = resultados.filter(r => r.status === 'fulfilled');
    const falhou = resultados.filter(r => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exatamente uma gravação aceita');
    assert.equal(falhou.length, 1, 'exatamente uma recusada');
    assert.ok((falhou[0] as PromiseRejectedResult).reason instanceof StateConflictError);

    const final = await store.read();
    assert.equal(final.revision, base.revision + 1, 'nenhuma revisão perdida nem inflada');
    assert.equal(final.events.filter(e => e.kind === 'cas').length, 1);
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// Isolamento por projeto: chave derivada do root canônico.
// ---------------------------------------------------------------------------
test('R5-01 projeto A não bloqueia projeto B; caminhos equivalentes do mesmo projeto serializam', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sdlc-r5-'));
  try {
    const rootA = join(base, 'a');
    const rootB = join(base, 'b');
    const a = new StateStore(rootA, { projectId: 'pa', lockWaitMs: 10_000 });
    const b = new StateStore(rootB, { projectId: 'pb', lockWaitMs: 10_000 });
    await Promise.all([a.init(), b.init()]);

    // A está ocupado por um detentor vivo; B continua operando normalmente.
    const holder = startChild(rootA, 'hold');
    await waitFor(() => holder.out().includes('LOCKED'), 'detentor vivo em A');
    const inicio = Date.now();
    await b.mutate(appendEvent('b', 'x'));
    assert.ok(Date.now() - inicio < 2_000, 'projeto B não espera pelo lock do projeto A');
    assert.equal((await b.read()).revision, 1);
    assert.equal((await a.read()).revision, 0);

    // Mesmo projeto por caminho equivalente (caixa e barras diferentes): mesma chave.
    const equivalente = new StateStore(rootA.replace(/\\/g, '/').toUpperCase(), { lockWaitMs: 300 });
    await assert.rejects(() => equivalente.mutate(appendEvent('nunca', 'x')), StateConflictError);

    holder.proc.kill();
    await holder.dead;
    await a.mutate(appendEvent('a', 'x'));
    assert.equal((await a.read()).revision, 1);
  } finally { await safeRm(base); }
});

// ---------------------------------------------------------------------------
// lockStatus é somente leitura: não adquire, não remove, não escreve.
// ---------------------------------------------------------------------------
test('R5-02 lockStatus não adquire, não remove e não escreve', async () => {
  const { root, store } = await fresh('r5-02-status');
  try {
    await plantLegacyArtifacts(root);
    const antesDoStatus = (await readdir(root)).sort();

    const livre = await store.lockStatus();
    assert.equal(livre.held, 'no', 'sonda não vira detentora');
    assert.deepEqual(livre.leftovers, ['state.lock', 'state.lock.manager', 'state.lock.recover']);
    assert.equal(livre.info?.token, 'legado-state.lock', 'informação legada é exposta como dica, não como autoridade');

    // Duas sondas seguidas não mudam nada no disco.
    await store.lockStatus();
    assert.deepEqual((await readdir(root)).sort(), antesDoStatus, 'nenhum arquivo criado ou removido pela sonda');

    // E o leftover de dono morto não impede a aquisição real.
    await store.mutate(appendEvent('apos-status', 'x'));
    assert.equal((await store.read()).revision, 1);
  } finally { await safeRm(root); }
});

// ---------------------------------------------------------------------------
// Sanidade do schema 2 (portado de lock-recovery-race.test.ts).
// ---------------------------------------------------------------------------
test('R4-03 runtime novo persiste e carrega em schemaVersion 2', async () => {
  const { root, store } = await fresh('schema2');
  try {
    const state = await store.read();
    assert.equal(state.schemaVersion, 2);
    assert.equal((JSON.parse(await readFile(store.runtimePath, 'utf8')) as { schemaVersion: number }).schemaVersion, 2);
  } finally { await safeRm(root); }
});
