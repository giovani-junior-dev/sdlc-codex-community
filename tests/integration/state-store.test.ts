import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StateStore, StateCorruptError, StateConflictError, ProjectIdentityError, lockTestHooks } from '../../src/state/store.js';
import { emptyRuntime } from '../../src/contracts.js';

const execFileAsync = promisify(execFile);

/** C02.5: nenhuma remoção recursiva sem confirmar que o alvo é temporário deste teste. */
async function safeRm(root: string): Promise<void> {
  const target = resolve(root);
  assert.ok(
    target.startsWith(resolve(tmpdir())) && basename(target).startsWith('sdlc-a-'),
    `recusa remover caminho fora do temporário do teste: ${target}`,
  );
  await rm(target, { recursive: true, force: true });
}

async function fresh(projectId = 'a'): Promise<{ root: string; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  return { root, store: new StateStore(root, { projectId, lockWaitMs: 2000 }) };
}

/** Resolve o store.js compilado junto a ESTE teste (não o dist/ compartilhado). */
function storeModuleUrl(): string {
  return new URL('../../src/state/store.js', import.meta.url).href;
}

/** Planta um lock manual com o dono informado (para testes de liveness/recovery). */
async function plantLock(root: string, owner: { pid: number; processStartMs: number; token: string; ownerIdentity: string }, dirName = 'state.lock'): Promise<void> {
  const lockDir = join(root, dirName);
  await mkdir(lockDir);
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ acquiredAt: new Date().toISOString(), ...owner }));
}

// R01: init apaga estado recuperável — reprodução: backup válido + principal corrompido => init NÃO cria vazio.
test('R01 init não destrói principal corrompido com backup válido', async () => {
  const { store } = await fresh('p1');
  await store.init('p1');
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'seed1', detail: 'x' }] }, result: undefined }));
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'seed2', detail: 'y' }] }, result: undefined }));
  const backupBefore = await readFile(store.backupPath, 'utf8');
  assert.match(backupBefore, /seed1/); // backup = última gravação válida anterior
  await writeFile(store.runtimePath, '{corrompido');
  await assert.rejects(() => store.init('p1'), StateCorruptError);
  assert.equal(await readFile(store.backupPath, 'utf8'), backupBefore);
  const recovered = await store.recoverBackup();
  assert.ok(recovered.events.some(e => e.kind === 'seed1'));
  assert.equal((await store.read()).projectId, 'p1');
});

// R01: init em diretório novo cria; com ambos corrompidos recusa vazio.
test('R01 init cria somente estado realmente novo', async () => {
  const { store } = await fresh('novo');
  const created = await store.init('novo');
  assert.equal(created.projectId, 'novo');
  assert.equal(created.revision, 0);
  await writeFile(store.runtimePath, 'lixo');
  await writeFile(store.backupPath, 'lixo');
  await assert.rejects(() => store.init('novo'), StateCorruptError);
});

// C02: erro de leitura (diretório no lugar do arquivo) NUNCA equivale a "projeto novo".
test('C02 erro de leitura/permissão não vira criação de estado vazio', async () => {
  const { root, store } = await fresh('eio');
  await mkdir(store.runtimePath); // EISDIR ao ler
  await assert.rejects(() => store.init('eio'), StateCorruptError);
  await assert.rejects(() => store.read(), StateCorruptError);
  await assert.rejects(() => store.mutate(s => ({ state: s, result: undefined })), StateCorruptError);
  await safeRm(root);
});

// R02: recoverBackup nunca sobrescreve backup válido com principal corrompido.
test('R02 recover preserva backup íntegro diante de principal corrompido', async () => {
  const { store } = await fresh('p2');
  await store.init('p2');
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'keep1', detail: '1' }] }, result: undefined }));
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'keep2', detail: '2' }] }, result: undefined }));
  const backup = await readFile(store.backupPath, 'utf8');
  assert.match(backup, /keep1/);
  await writeFile(store.runtimePath, '{"schemaVersion":1,"revision":"nan"}');
  const recovered = await store.recoverBackup();
  assert.equal((await readFile(store.backupPath, 'utf8')), backup);
  assert.ok(recovered.events.some(e => e.kind === 'keep1'));
  assert.equal(recovered.projectId, 'p2');
});

// R02/S13/R4-02: write com snapshot obsoleto conflita contra revisão persistida;
// CAS obrigatório: snapshot renumerado (rev0 -> rev2) não apaga rev1.
test('R02/R4-02 write com snapshot obsoleto conflita contra revisão persistida', async () => {
  const { store } = await fresh('p3');
  await store.init('p3');
  const stale = await store.read(); // rev0
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'rev1', detail: 'x' }] }, result: undefined }));
  // rev1 gravado; snapshot rev0 renumerado para sucessora não tem expectedRevision válido.
  await assert.rejects(() => store.write({ ...stale }, stale.revision), StateConflictError);
  // C02/S13: a revisão gravada deve ser exatamente persistida + 1, com base correta.
  const persisted = await store.read();
  await store.write({ ...stale, revision: persisted.revision + 1 }, persisted.revision);
});

// R4-02: CAS obrigatório — snapshot rev0 -> mutate rev1 -> snapshot renumerado rev2
// é recusado com a base que ele conhece; rev1 permanece intacto.
test('R4-02 snapshot renumerado não apaga revisão anterior', async () => {
  const { store } = await fresh('p3-r4');
  await store.init('p3-r4');
  const snap0 = await store.read();
  await store.mutate(s => ({
    state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'vencedora', detail: 'rev1' }] },
    result: undefined,
  }));
  const renumerado = { ...snap0, revision: (await store.read()).revision + 1 };
  // A base que o snapshot obsoleto conhece (0) diverge da persistida (1): conflito.
  await assert.rejects(() => store.write(renumerado, snap0.revision), StateConflictError);
  const after = await store.read();
  assert.equal(after.revision, 1);
  assert.ok(after.events.some(e => e.kind === 'vencedora'), 'rev1 preservada');
});

// R4-02: write SEM revisão-base é impossível na API (expectedRevision obrigatório).
test('R4-02 write exige expectedRevision como parâmetro obrigatório', async () => {
  const { store } = await fresh('p3-req');
  await store.init('p3-req');
  const snap = await store.read();
  // @ts-expect-error - write sem expectedRevision não compila (revisão-base obrigatória)
  const attempt: Promise<unknown> = store.write({ ...snap, revision: 1 });
  // Mesmo se chamado por JS puro, a base ausente nunca casa com a persistida: conflito.
  await assert.rejects(attempt, StateConflictError);
});

// C02/S13: write com base divergente é recusado; sucessora correta é aceita.
test('C02 write com expectedRevision divergente conflita; base correta aceita', async () => {
  const { store } = await fresh('p3b');
  await store.init('p3b');
  const stale = await store.read();
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'bump', detail: 'x' }] }, result: undefined }));
  const persisted = (await store.read()).revision;
  // expectedRevision divergente da persistida: rejeitado.
  await assert.rejects(() => store.write({ ...stale, revision: persisted + 1 }, persisted + 7), StateConflictError);
  // sucessora correta com base correta: aceito.
  await store.write({ ...stale, revision: persisted + 1 }, persisted);
  assert.equal((await store.read()).revision, persisted + 1);
});

// C02/S13: primeira gravação em diretório vazio só aceita revisão 0 + base 0.
test('C02 write em estado inexistente exige revisão 0 e expectedRevision 0', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  try {
    const store = new StateStore(root, { projectId: 'vazio' });
    const state = { ...emptyRuntime('vazio'), revision: 5 };
    await assert.rejects(() => store.write(state, 0), StateConflictError);
    await store.write(emptyRuntime('vazio'), 0);
    assert.equal((await store.read()).revision, 0);
  } finally { await safeRm(root); }
});

// C02/S13: mutate impõe revisão sucessora derivada do persistido — revisão do chamador é ignorada.
test('C02 mutate grava revisão persistida + 1, nunca a revisão arbitrária do chamador', async () => {
  const { store } = await fresh('p3c');
  await store.init('p3c');
  const before = (await store.read()).revision;
  await store.mutate(s => ({ state: { ...s, revision: 999, events: [...s.events, { at: new Date().toISOString(), kind: 'bump', detail: 'x' }] }, result: undefined }));
  const after = await store.read();
  assert.equal(after.revision, before + 1);
  assert.equal(after.revision, 1);
});

// R4-02: mutação sem mudança efetiva é idempotente — não grava nem infla a revisão.
test('R4-02 mutate sem mudança é idempotente e não infla revision', async () => {
  const { store } = await fresh('p3-idem');
  await store.init('p3-idem');
  const before = await store.read();
  await store.mutate(s => ({ state: s, result: 'noop' }));
  const after = await store.read();
  assert.equal(after.revision, before.revision);
  // Com mudança real: revisão avança exatamente 1.
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'real', detail: 'y' }] }, result: 'real' }));
  assert.equal((await store.read()).revision, before.revision + 1);
});

// R02: falha intermediária preserva versão íntegra (temp órfão não vira estado).
test('R02 temp órfão nunca é lido como estado', async () => {
  const { store } = await fresh('p4');
  await store.init('p4');
  await writeFile(`${store.runtimePath}.dead.tmp`, '{"schemaVersion":1}');
  const state = await store.read();
  assert.equal(state.projectId, 'p4');
});

// C02: identidade — store de A recusa runtime 100% válido de B (sem arrays ausentes misturados).
test('C02 store de A recusa runtime íntegro de B em read/init/mutate/write/recover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  try {
    const foreign = emptyRuntime('projeto-b-100-valido');
    const json = JSON.stringify(foreign, null, 2) + '\n';
    await writeFile(join(root, 'runtime.json'), json);
    await writeFile(join(root, 'runtime.backup.json'), json);
    const store = new StateStore(root, { projectId: 'projeto-a' });
    for (const attempt of [
      () => store.read(),
      () => store.init('projeto-a'),
      () => store.mutate(s => ({ state: s, result: undefined })),
      () => store.write({ ...foreign, projectId: 'projeto-a', revision: 1 }, 0),
      () => store.recoverBackup(),
    ]) {
      await assert.rejects(attempt, (e: unknown) => {
        assert.ok(e instanceof ProjectIdentityError, `esperado ProjectIdentityError, veio ${(e as Error)?.name}: ${(e as Error)?.message}`);
        assert.match((e as Error).message, /projeto-b-100-valido/);
        assert.match((e as Error).message, /projeto-a/);
        return true;
      });
    }
    // Nada foi destruído: arquivos intactos.
    assert.equal(await readFile(join(root, 'runtime.json'), 'utf8'), json);
  } finally { await safeRm(root); }
});

// C02: store SEM projectId (uso do doctor) é tolerante na leitura e nunca é usado para mutar.
test('C02 store sem projectId lê runtime de qualquer projeto sem destruir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  try {
    const foreign = emptyRuntime('outro-projeto');
    await writeFile(join(root, 'runtime.json'), JSON.stringify(foreign));
    const probe = new StateStore(root); // doctor: somente leitura
    assert.equal((await probe.read()).projectId, 'outro-projeto');
    // init com projectId divergente do existente recusa explicitamente, mesmo sem opção.
    await assert.rejects(() => probe.init('esperado'), ProjectIdentityError);
  } finally { await safeRm(root); }
});

// R04: estado sem arrays obrigatórios é rejeitado sem destruição (identidade preservada: mesmo projeto).
test('R04 estado sem arrays obrigatórios é rejeitado sem destruição', async () => {
  const { store } = await fresh('proj-a');
  await store.init('proj-a');
  const broken = emptyRuntime('proj-a');
  delete (broken as unknown as Record<string, unknown>).sessions;
  await writeFile(store.runtimePath, JSON.stringify(broken));
  await writeFile(store.backupPath, JSON.stringify(broken));
  await assert.rejects(() => store.read(), StateCorruptError);
  await assert.rejects(() => store.init('proj-a'), StateCorruptError);
  await assert.rejects(() => store.mutate(s => ({ state: s, result: undefined })), StateCorruptError);
});

// R04: isolamento entre projetos.
test('R04 isolamento entre dois projetos', async () => {
  const base = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  try {
    const a = new StateStore(join(base, 'a'), { projectId: 'a' });
    const b = new StateStore(join(base, 'b'), { projectId: 'b' });
    await a.init();
    await b.init();
    await a.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'iso', detail: 'a' }] }, result: undefined }));
    assert.equal((await a.read()).revision, 1);
    assert.equal((await b.read()).projectId, 'b');
    assert.equal((await b.read()).revision, 0);
  } finally { await safeRm(base); }
});

// R03: concorrência com subprocessos Node locais — mesma revisão, só um vence.
test('R03 dois subprocessos disputando a mesma revisão: estado íntegro', async () => {
  const { root, store: parent } = await fresh('conc');
  await parent.init('conc');
  const rev0 = (await parent.read()).revision;
  const modUrl = storeModuleUrl();
  const script = `
    const { StateStore } = await import(${JSON.stringify(modUrl)});
    const store = new StateStore(${JSON.stringify(root)}, { lockWaitMs: 8000 });
    try {
      const n = await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'race', detail: String(process.pid) }] }, result: s.revision }));
      console.log('WIN ' + n);
    } catch (e) { console.log('LOSE ' + (e && e.name)); }
  `;
  const node = process.execPath;
  const [r1, r2] = await Promise.all([
    execFileAsync(node, ['--input-type=module', '-e', script]),
    execFileAsync(node, ['--input-type=module', '-e', script]),
  ]);
  const wins = [r1.stdout, r2.stdout].filter(o => o.includes('WIN')).length;
  assert.equal(wins, 2); // mutações seriadas pelo lock: ambas aplicam em sequência
  const after = await parent.read();
  assert.equal(after.revision, rev0 + 2);
  await safeRm(root);
});

// R02/R03: duas gravações write() com a mesma revisão esperada — só uma é aceita.
test('R02 escrita obsoleta perde: uma aceita, outra em conflito', async () => {
  const { root, store: parent } = await fresh('conf');
  await parent.init('conf');
  const snap = await parent.read();
  const modUrl = storeModuleUrl();
  const script = `
    const { StateStore } = await import(${JSON.stringify(modUrl)});
    const store = new StateStore(${JSON.stringify(root)}, { lockWaitMs: 8000 });
    const snap = ${JSON.stringify(snap)};
    snap.revision = snap.revision + 1;
    snap.events = [...snap.events, { at: new Date().toISOString(), kind: 'race', detail: String(process.pid) }];
    try {
      await store.write(snap, ${snap.revision});
      console.log('WIN');
    } catch (e) { console.log('LOSE ' + (e && e.name)); }
  `;
  const [r1, r2] = await Promise.all([
    execFileAsync(process.execPath, ['--input-type=module', '-e', script]),
    execFileAsync(process.execPath, ['--input-type=module', '-e', script]),
  ]);
  const wins = [r1.stdout, r2.stdout].filter(o => o.includes('WIN')).length;
  const loses = [r1.stdout, r2.stdout].filter(o => o.includes('StateConflictError')).length;
  assert.equal(wins, 1);
  assert.equal(loses, 1);
  await safeRm(root);
});

// S06/C02: lock de processo VIVO não é removido; após release, o store avança.
test('S06 lock de processo vivo é respeitado; release libera', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  try {
    const store = new StateStore(root, { projectId: 'lock-alive', lockWaitMs: 400 });
    await store.init('lock-alive');
    const modUrl = storeModuleUrl();
    const script = `
      const { StateStore } = await import(${JSON.stringify(modUrl)});
      const store = new StateStore(${JSON.stringify(root)}, { lockWaitMs: 8000 });
      await store.mutate(async s => {
        console.log('LOCKED');
        await new Promise(r => setTimeout(r, 1200));
        return { state: s, result: undefined };
      });
      console.log('RELEASED');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childOut = '';
    child.stdout.on('data', d => { childOut += d; });
    // Espera o filho estar segurando o lock.
    for (let i = 0; i < 200 && !childOut.includes('LOCKED'); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(childOut.includes('LOCKED'), 'filho adquiriu o lock');
    // PID vivo (e nascimento conferente): store deve conflitar, nunca remover o lock alheio.
    await assert.rejects(
      () => store.mutate(s => ({ state: s, result: undefined })),
      (e: unknown) => e instanceof StateConflictError,
    );
    await new Promise((resolveExit, rejectExit) => {
      child.on('exit', code => (code === 0 ? resolveExit(undefined) : rejectExit(new Error(`filho saiu com ${code}`))));
    });
    assert.ok(childOut.includes('RELEASED'));
    await store.mutate(s => ({ state: s, result: undefined })); // lock livre agora
  } finally { await safeRm(root); }
});

// S06/C02: crash do dono (sem release) — lock recuperado por PID + nascimento verificados.
test('S06 lock de processo encerrado é recuperado com estado íntegro', async () => {
  const { root, store } = await fresh('lock-dead');
  await store.init('lock-dead');
  const modUrl = storeModuleUrl();
  const script = `
    const { StateStore } = await import(${JSON.stringify(modUrl)});
    const store = new StateStore(${JSON.stringify(root)}, { lockWaitMs: 8000 });
    await store.mutate(async s => {
      console.log('LOCKED');
      await new Promise(() => setTimeout(() => {}, 3_600_000)); // timer mantém o filho vivo até o kill
      return { state: s, result: undefined };
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  child.stdout.on('data', d => { childOut += d; });
  for (let i = 0; i < 200 && !childOut.includes('LOCKED'); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(childOut.includes('LOCKED'), 'filho adquiriu o lock');
  child.kill(); // encerra SEM release — simula crash
  await new Promise(r => child.on('exit', () => r(undefined)));
  const rev0 = (await store.read()).revision;
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'pós-recuperação', detail: String(process.pid) }] }, result: undefined }));
  assert.equal((await store.read()).revision, rev0 + 1);
  await safeRm(root);
});

/**
 * R5-01 — MUDANÇA DELIBERADA de comportamento em relação a S06/C02.
 *
 * Os dois testes anteriores ("PID reuse não mantém lock" e "PID vivo com nascimento
 * conferente mantém lock") afirmavam que o owner.json em disco decidia quem detinha
 * o lock, com liveness por PID + nascimento. Era exatamente essa decisão por
 * observação que R5-01/R5-02 exploravam. A autoridade passou a ser a primitiva do
 * SO, então owner.json plantado não detém coisa alguma — VIVO ou MORTO, com PID
 * conferente ou não. Detentor de verdade (processo vivo segurando o pipe) continua
 * respeitado: ver "S06 lock de processo vivo é respeitado; release libera" acima e
 * tests/integration/lock-mutual-exclusion.test.ts.
 */
test('R5-01 owner.json plantado com PID VIVO e nascimento conferente não detém lock algum', async () => {
  const { root, store } = await fresh('lock-self');
  await store.init('lock-self');
  await plantLock(root, {
    pid: process.pid, // vivo
    processStartMs: Date.now() - Math.round(process.uptime() * 1000), // nascimento conferente
    token: 'self-token',
    ownerIdentity: `test:${process.pid}`,
  });
  // Nenhuma espera, nenhum conflito: a informação em disco não é autoridade.
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'apesar-do-pid-vivo', detail: 'x' }] }, result: undefined }));
  assert.equal((await store.read()).revision, 1);
  assert.equal((await store.lockStatus()).held, 'no', 'ninguém detém: não havia processo segurando a primitiva');
  await safeRm(root);
});

// R5-01/S06: dois escritores concorrentes em subprocessos reais sobre um leftover
// morto — ambos aplicam em sequência, nenhum desloca o outro.
test('S06 dois escritores simultâneos sobre leftover morto: ambos aplicam em sequência', async () => {
  const { root, store: parent } = await fresh('lock-race');
  await parent.init('lock-race');
  const rev0 = (await parent.read()).revision;
  // Obtém um PID garantidamente morto para plantar o lock obsoleto.
  const probe = await execFileAsync(process.execPath, ['-e', 'console.log(process.pid)']);
  const deadPid = Number(probe.stdout.trim());
  await plantLock(root, {
    pid: deadPid,
    processStartMs: Date.now() - 10_000,
    token: 'stale-token',
    ownerIdentity: 'stale:0',
  });
  const modUrl = storeModuleUrl();
  const script = `
    const { StateStore } = await import(${JSON.stringify(modUrl)});
    const store = new StateStore(${JSON.stringify(root)}, { lockWaitMs: 8000 });
    try {
      await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'rec-race', detail: String(process.pid) }] }, result: undefined }));
      console.log('WIN');
    } catch (e) { console.log('LOSE ' + (e && e.name)); }
  `;
  const [r1, r2] = await Promise.all([
    execFileAsync(process.execPath, ['--input-type=module', '-e', script]),
    execFileAsync(process.execPath, ['--input-type=module', '-e', script]),
  ]);
  const wins = [r1.stdout, r2.stdout].filter(o => o.includes('WIN')).length;
  assert.equal(wins, 2, `ambos devem aplicar em sequência: ${r1.stdout} / ${r2.stdout}`);
  const after = await parent.read();
  assert.equal(after.revision, rev0 + 2);
  assert.equal(after.projectId, 'lock-race');
  await safeRm(root);
});

// C02.5: falha induzida no rename — estado anterior permanece íntegro e legível.
test('C02.5 falha no rename preserva versão íntegra recuperável', async t => {
  const { root, store } = await fresh('fault-rename');
  await store.init('fault-rename');
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'keep', detail: '1' }] }, result: undefined }));
  const before = await store.read();
  const original = fsp.rename;
  t.after(() => { (fsp as unknown as Record<string, unknown>).rename = original; });
  (fsp as unknown as Record<string, unknown>).rename = (async () => {
    throw Object.assign(new Error('rename bloqueado para fault injection'), { code: 'EPERM' });
  }) as never;
  await assert.rejects(
    () => store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'fault-probe', detail: 'rename' }] }, result: undefined })),
    /rename bloqueado/,
  );
  (fsp as unknown as Record<string, unknown>).rename = original as never;
  const after = await store.read();
  assert.equal(after.revision, before.revision);
  assert.ok(after.events.some(e => e.kind === 'keep'));
  // backup também íntegro e recuperável
  const recovered = await store.recoverBackup();
  assert.ok(recovered.events.some(e => e.kind === 'keep'));
  await safeRm(root);
});

// C02.4: EPERM transitório no rename é superado pelo retry delimitado (causa: handle de AV/indexador).
test('C02.4 EPERM transitório no rename: retry delimitado preserva a gravação', async t => {
  const { root, store } = await fresh('fault-eperm');
  await store.init('fault-eperm');
  const original = fsp.rename;
  let calls = 0;
  t.after(() => { (fsp as unknown as Record<string, unknown>).rename = original; });
  (fsp as unknown as Record<string, unknown>).rename = ((oldP: string, newP: string, ...rest: unknown[]) => {
    calls++;
    if (calls === 1) return Promise.reject(Object.assign(new Error('EPERM transitório'), { code: 'EPERM' }));
    return (original as (...a: unknown[]) => Promise<void>)(oldP, newP, ...rest);
  }) as never;
  const rev0 = (await store.read()).revision;
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'fault-probe', detail: 'eperm' }] }, result: undefined }));
  assert.equal(calls, 2);
  assert.equal((await store.read()).revision, rev0 + 1);
  await safeRm(root);
});

// C02.5: falha na escrita do temporário — nada de estado vazio ou parcial.
test('C02.5 falha na escrita do temporário não corrompe o estado', async t => {
  const { root, store } = await fresh('fault-write');
  await store.init('fault-write');
  const before = await store.read();
  const original = fsp.writeFile;
  t.after(() => { (fsp as unknown as Record<string, unknown>).writeFile = original; });
  (fsp as unknown as Record<string, unknown>).writeFile = ((p: unknown, ...rest: unknown[]) => {
    if (String(p).endsWith('.tmp')) return Promise.reject(Object.assign(new Error('EIO no temp'), { code: 'EIO' }));
    return (original as (...a: unknown[]) => Promise<void>)(p as string, ...(rest as [string]));
  }) as never;
  await assert.rejects(
    () => store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'fault-probe', detail: 'temp' }] }, result: undefined })),
    /EIO no temp/,
  );
  (fsp as unknown as Record<string, unknown>).writeFile = original as never;
  const after = await store.read();
  assert.equal(after.revision, before.revision);
  assert.equal(after.projectId, 'fault-write');
  await safeRm(root);
});

// C02.5: falha na atualização do backup — principal íntegro, revisão inalterada.
test('C02.5 falha no backup preserva principal e backup íntegros', async t => {
  const { root, store } = await fresh('fault-backup');
  await store.init('fault-backup');
  const before = await store.read();
  const backupBefore = await readFile(store.backupPath, 'utf8');
  const original = fsp.copyFile;
  t.after(() => { (fsp as unknown as Record<string, unknown>).copyFile = original; });
  (fsp as unknown as Record<string, unknown>).copyFile = (async () => {
    throw Object.assign(new Error('copyFile bloqueado'), { code: 'EACCES' });
  }) as never;
  await assert.rejects(
    () => store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'fault-probe', detail: 'backup' }] }, result: undefined })),
    /copyFile bloqueado/,
  );
  (fsp as unknown as Record<string, unknown>).copyFile = original as never;
  const after = await store.read();
  assert.equal(after.revision, before.revision);
  assert.equal(await readFile(store.backupPath, 'utf8'), backupBefore);
  await safeRm(root);
});

// C02.5: falha na semeadura do backup no init — nenhum principal parcial é deixado para trás.
test('C02.5 falha na semeadura do backup não deixa principal parcial', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  try {
    const store = new StateStore(root, { projectId: 'fault-seed' });
    const original = fsp.writeFile;
    t.after(() => { (fsp as unknown as Record<string, unknown>).writeFile = original; });
    (fsp as unknown as Record<string, unknown>).writeFile = ((p: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith('runtime.backup.json')) {
        return Promise.reject(Object.assign(new Error('EIO no backup'), { code: 'EIO' }));
      }
      return (original as (...a: unknown[]) => Promise<void>)(p as string, ...(rest as [string]));
    }) as never;
    await assert.rejects(() => store.init('fault-seed'), /EIO/);
    (fsp as unknown as Record<string, unknown>).writeFile = original as never;
    // Nenhuma versão parcial: principal ausente (init falhou antes do rename) e backup ausente.
    await assert.rejects(() => fsp.stat(store.runtimePath));
    await assert.rejects(() => fsp.stat(store.backupPath));
  } finally { await safeRm(root); }
});

// ---------- R4-03: migração explícita schemaVersion 1 -> 2 (decisão M0-F2 nº7) ----------

/** Runtime v1 legado mínimo (schemaVersion 1, evidência sem provenance). */
function legacyV1Runtime(projectId: string): Record<string, unknown> {
  return {
    schemaVersion: 1, revision: 4, projectId, sessions: [], runs: [], messages: [],
    deliveries: [],
    evidence: [{ id: 'e-legado', requirementId: 'req', result: 'pass', procedure: 'p', timestamp: new Date().toISOString() }],
    operations: {}, events: [],
  };
}

test('R4-03 carga de estado v1 migra para v2 com backup e provenance legacy', async () => {
  const { root, store } = await fresh('migra');
  const legacy = legacyV1Runtime('migra');
  const raw = JSON.stringify(legacy, null, 2) + '\n';
  await writeFile(store.runtimePath, raw);
  const migrated = await store.read();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.revision, 4, 'revisão preservada, não inventada');
  assert.equal(migrated.evidence[0].provenance, 'legacy', 'evidência legada marcada sem inventar runId/revisão/timestamp');
  // Backup pré-migração preserva o original v1 intacto (cópia única).
  const backupCopy = await readFile(`${store.runtimePath}.v1-backup`, 'utf8');
  assert.equal(backupCopy, raw);
  assert.equal(await readFile(store.runtimePath, 'utf8'), raw, 'original não reescrito pela leitura');
  // Segunda leitura: backup não duplicado, migração idempotente.
  await store.read();
  const migrated2 = await store.read();
  assert.equal(migrated2.schemaVersion, 2);
  // Próxima gravação persiste v2.
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'pós-migração', detail: 'x' }] }, result: undefined }));
  const persisted = JSON.parse(await readFile(store.runtimePath, 'utf8')) as { schemaVersion: number };
  assert.equal(persisted.schemaVersion, 2);
  await safeRm(root);
});

test('R4-03 estado v1 inválido é recusado com erro explicativo, sem reparo silencioso', async () => {
  const { root, store } = await fresh('migra-invalida');
  const broken = legacyV1Runtime('migra-invalida') as Record<string, unknown>;
  delete broken.sessions; // estrutura inválida mesmo para v1
  await writeFile(store.runtimePath, JSON.stringify(broken));
  await assert.rejects(() => store.read(), StateCorruptError);
  await assert.rejects(() => store.mutate(s => ({ state: s, result: undefined })), StateCorruptError);
  await safeRm(root);
});

/**
 * R5-11: v1 com operações aceitas — sem runId/revisão viram provenance 'legacy'
 * (origem explícita, nada inventado); com runId + revisão coerentes NÃO recebem a
 * marca (já são modernas e não podem ser rebaixadas); recusadas nunca recebem.
 */
test('R5-11 migração v1 marca só a operação aceita sem runId/revisão como legacy', async () => {
  const { root, store } = await fresh('migra-ops');
  const legacy = legacyV1Runtime('migra-ops');
  legacy.runs = [{
    runId: 'run-1', slug: 'demanda', workflow: 'feature', intentPath: 'i.md', planPath: 'p.md',
    stage: 'build', revision: 3,
    attempts: { build: 0, review: 0, e2e: 0, pr: 0, 'pr-review': 0, document: 0 },
    gapFailures: {}, status: 'running', history: [],
  }];
  legacy.operations = {
    'OP-SEM-ID': { operationId: 'OP-SEM-ID', accepted: true, status: 'done' },
    'OP-SEM-REV': { operationId: 'OP-SEM-REV', accepted: true, status: 'done', runId: 'run-1' },
    'OP-MODERNA': { operationId: 'OP-MODERNA', accepted: true, status: 'done', runId: 'run-1', revision: 2 },
    'OP-RECUSADA': { operationId: 'OP-RECUSADA', accepted: false, status: 'rejected', error: 'motivo' },
  };
  await writeFile(store.runtimePath, JSON.stringify(legacy, null, 2) + '\n');

  const migrado = await store.read();
  assert.equal(migrado.schemaVersion, 2);
  assert.equal(migrado.operations['OP-SEM-ID']?.provenance, 'legacy', 'aceita sem runId nem revisão');
  assert.equal(migrado.operations['OP-SEM-ID']?.runId, undefined, 'runId NÃO foi inventado');
  assert.equal(migrado.operations['OP-SEM-REV']?.provenance, 'legacy', 'aceita com runId mas sem revisão');
  assert.equal(migrado.operations['OP-SEM-REV']?.revision, undefined, 'revisão NÃO foi inventada');
  assert.equal(migrado.operations['OP-MODERNA']?.provenance, undefined, 'aceita identificada não é rebaixada a legado');
  assert.equal(migrado.operations['OP-RECUSADA']?.provenance, undefined, 'recusada não é marcada');
  await safeRm(root);
});

test('R4-03 identidade do projeto é conferida também na migração v1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify(legacyV1Runtime('outro-projeto')));
    const store = new StateStore(root, { projectId: 'esperado' });
    await assert.rejects(() => store.read(), ProjectIdentityError);
  } finally { await safeRm(root); }
});
// ---------- R5-01/R5-02: exclusão mútua por primitiva do SO ----------
// Os testes do protocolo da rodada 4 (manager lock, marcador de recuperação,
// owner.json como autoridade, liveness por PID) foram substituídos: aquelas
// estruturas deixaram de existir como autoridade. A cobertura equivalente — e
// muito mais forte, com subprocessos reais e contador de concorrência — vive em
// tests/integration/lock-mutual-exclusion.test.ts. Aqui ficam só as asserções
// sobre a API do store que este arquivo já cobria.

/** PID garantidamente morto (subprocesso já encerrado). */
async function deadPid(): Promise<number> {
  const probe = await execFileAsync(process.execPath, ['-e', 'console.log(process.pid)']);
  return Number(probe.stdout.trim());
}

test('R5-01 leftover de dono morto é inerte: não bloqueia nem autoriza nada', async () => {
  const { root, store } = await fresh('leftover-morto');
  await store.init('leftover-morto');
  // Exatamente os artefatos que o protocolo anterior consultava para decidir.
  await plantLock(root, {
    pid: await deadPid(), processStartMs: Date.now() - 10_000,
    token: 'main-morto', ownerIdentity: 'morto:0',
  });
  await plantLock(root, {
    pid: await deadPid(), processStartMs: Date.now() - 10_000,
    token: 'mgr-morto', ownerIdentity: 'morto:1',
  }, 'state.lock.manager');

  // Aquisição normal entra de imediato: a autoridade é do SO, não do disco.
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'apesar-do-leftover', detail: 'x' }] }, result: undefined }));
  assert.equal((await store.read()).events.some(e => e.kind === 'apesar-do-leftover'), true);
  // O owner.json morto foi SOBRESCRITO pelo detentor real e removido no release.
  assert.equal(await access(join(root, 'state.lock')).then(() => true, () => false), false);
  await safeRm(root);
});

test('R5-01 diretório de lock sem owner.json não impede aquisição (ambiguidade deixou de existir)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-'));
  try {
    const store = new StateStore(root, { projectId: 'sem-info', lockWaitMs: 2_000 });
    await store.init('sem-info');
    await mkdir(join(root, 'state.lock'));
    await mkdir(join(root, 'state.lock.manager'));
    // No protocolo anterior isto era "ambíguo => fail closed até o timeout". Agora é
    // lixo inerte: a exclusão real não depende de diretório algum.
    await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'sem-info', detail: 'x' }] }, result: undefined }));
    assert.equal((await store.read()).revision, 1);
  } finally { await safeRm(root); }
});

test('R5-02 recoverStaleLocks remove só artefatos inertes e é idempotente', async () => {
  const { root, store } = await fresh('limpeza');
  await store.init('limpeza');
  await plantLock(root, {
    pid: await deadPid(), processStartMs: Date.now() - 10_000,
    token: 'mgr-morto', ownerIdentity: 'morto:0',
  }, 'state.lock.manager');
  await mkdir(join(root, 'state.lock.recover'));
  const orfao = join(root, 'runtime.json.00000000-0000-4000-8000-000000000000.tmp');
  await writeFile(orfao, '{}', 'utf8');

  const primeira = await store.recoverStaleLocks();
  assert.deepEqual(primeira.removed, [
    'runtime.json.00000000-0000-4000-8000-000000000000.tmp',
    'state.lock.manager',
    'state.lock.recover',
  ]);
  assert.equal(await access(orfao).then(() => true, () => false), false);
  // Idempotente: nada mais a remover, e o estado não é tocado em nenhum caso.
  const segunda = await store.recoverStaleLocks();
  assert.deepEqual(segunda.removed, []);
  assert.equal((await store.read()).revision, 0);
  await safeRm(root);
});

test('R5-02 lockStatus reporta ausência de detentor e lista os artefatos inertes', async () => {
  const { root, store } = await fresh('status');
  await store.init('status');
  const limpo = await store.lockStatus();
  assert.deepEqual(limpo, { held: 'no', leftovers: [] });

  await plantLock(root, {
    pid: await deadPid(), processStartMs: Date.now() - 10_000,
    token: 'main-morto', ownerIdentity: 'morto:0',
  });
  const comLixo = await store.lockStatus();
  assert.equal(comLixo.held, 'no', 'owner.json em disco NUNCA significa detentor');
  assert.equal(comLixo.info?.token, 'main-morto', 'informação exposta apenas como dica de diagnóstico');
  assert.deepEqual(comLixo.leftovers, ['state.lock']);
  await safeRm(root);
});

test('R5-F3 leitura v1 concorrente não sobrescreve o backup original criado pela migração', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-r5-v1-backup-race-'));
  const store = new StateStore(root, { projectId: 'v1-race' });
  const v1 = { ...emptyRuntime('v1-race'), schemaVersion: 1 };
  await writeFile(join(root, 'runtime.json'), JSON.stringify(v1));
  let resumeReader!: () => void;
  let readerPaused!: () => void;
  const paused = new Promise<void>(resolve => { readerPaused = resolve; });
  const resume = new Promise<void>(resolve => { resumeReader = resolve; });
  lockTestHooks.beforeLegacyBackup = async () => { readerPaused(); await resume; };
  try {
    const reader = store.read();
    await paused;
    lockTestHooks.beforeLegacyBackup = undefined;
    await store.mutate(s => ({
      state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'migrated', detail: 'writer' }] },
      result: undefined,
    }));
    const before = JSON.parse(await readFile(join(root, 'runtime.json.v1-backup'), 'utf8')) as { schemaVersion: number };
    assert.equal(before.schemaVersion, 1);
    resumeReader();
    await reader;
    const after = JSON.parse(await readFile(join(root, 'runtime.json.v1-backup'), 'utf8')) as { schemaVersion: number; events: unknown[] };
    assert.equal(after.schemaVersion, 1, 'a leitura atrasada deve preservar o snapshot v1 original');
    assert.equal(after.events.length, 0, 'estado v2 posterior não pode substituir o backup v1');
  } finally {
    lockTestHooks.beforeLegacyBackup = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

test('R5-F3 backup v1 incompleto faz a retomada falhar fechada', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-a-v1-partial-'));
  const store = new StateStore(root, { projectId: 'v1-partial' });
  const runtimePath = join(root, 'runtime.json');
  const legacyBackupPath = `${runtimePath}.v1-backup`;
  const v1 = { ...emptyRuntime('v1-partial'), schemaVersion: 1 };
  await writeFile(runtimePath, JSON.stringify(v1));

  // Estado deixado por uma publicação antiga/interrompida: o nome definitivo
  // existe, mas não contém o snapshot que deveria preservar.
  await writeFile(legacyBackupPath, '', 'utf8');
  assert.equal((await fsp.stat(legacyBackupPath)).size, 0, 'precondição: publicação interrompida deixou arquivo incompleto');

  await assert.rejects(
    () => store.mutate(state => ({ state, result: undefined })),
    /backup pré-migração existente.*inválido|backup v1.*inválido/,
  );
  assert.equal((JSON.parse(await readFile(runtimePath, 'utf8')) as { schemaVersion: number }).schemaVersion, 1);
});

test('R5-01 crash na seção crítica (subprocesso morto): próximo escritor entra sem intervenção', async () => {
  const { root, store } = await fresh('crash-cs');
  await store.init('crash-cs');
  const modUrl = storeModuleUrl();
  const script = `
    const { StateStore } = await import(${JSON.stringify(modUrl)});
    const store = new StateStore(${JSON.stringify(root)}, { lockWaitMs: 8000 });
    await store.mutate(async s => {
      console.log('LOCKED');
      await new Promise(() => setTimeout(() => {}, 3_600_000));
      return { state: s, result: undefined };
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  child.stdout.on('data', d => { childOut += d; });
  for (let i = 0; i < 400 && !childOut.includes('LOCKED'); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(childOut.includes('LOCKED'), 'filho na seção crítica');
  // Enquanto vive, ninguém entra.
  assert.equal((await store.lockStatus()).held, 'yes');
  child.kill();
  await new Promise(r => child.on('exit', () => r(undefined)));
  const rev0 = (await store.read()).revision;
  await store.mutate(s => ({ state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind: 'apos-crash', detail: 'x' }] }, result: undefined }));
  assert.equal((await store.read()).revision, rev0 + 1);
  await safeRm(root);
});
