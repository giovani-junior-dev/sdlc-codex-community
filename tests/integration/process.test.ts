import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { NodeProcessRunner, FakeProcessRunner } from '../../src/adapters/process.js';

// R08: argumentos efetivos em subprocesso Node inofensivo (não só no fake).
test('processo real preserva aspas, espaços, quebras, cifrão e unicode', async () => {
  const runner = new NodeProcessRunner();
  const text = `aspas ' " "duplas" quebra\nlinha cifrão $HOME backtick \`x\` acentuação ãõ cigarro 🚀 caminho com espaço`;
  const r = await runner.run(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', text], { timeoutMs: 15000 });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout.trim()), [text]);
});

// R08: UTF-8 dividido entre chunks não corrompe (payload grande força múltiplos chunks).
test('utf-8 fragmentado decodifica intacto', async () => {
  const runner = new NodeProcessRunner();
  const text = '🚀'.repeat(5000) + 'ãõç'.repeat(5000);
  const r = await runner.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', text], { timeoutMs: 15000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, text);
});

test('timeout mata processo e falha; exit não-zero falha', async () => {
  const runner = new NodeProcessRunner();
  const t = await runner.run(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { timeoutMs: 300 });
  assert.equal(t.timedOut, true);
  const f = await runner.run(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 10000 });
  assert.equal(f.exitCode, 7);
  assert.equal(f.stdout, '');
});

test('fake preserva cada argumento como dado', async () => {
  const runner = new FakeProcessRunner((_e, args) => ({ exitCode: 0, stdout: JSON.stringify(args), stderr: '', timedOut: false, acceptedBeforeTimeout: false }));
  const text = `aspas ' "\nacentuação $HOME \`backtick\` caminho com espaço`;
  const result = await runner.run('fake', ['--message', text]);
  assert.deepEqual(JSON.parse(result.stdout), ['--message', text]);
  assert.deepEqual(runner.calls[0].args, ['--message', text]);
});

// M2-F2: stderr também é decodificado após concatenação de chunks (UTF-8
// fragmentado) e exit não-zero devolve stdout/stderr separados intactos.
// Payload (~100 KB) é montado DENTRO do filho: excede o buffer do pipe
// (força múltiplos chunks) e o argv não estoura o limite do CreateProcess.
test('stderr UTF-8 fragmentado decodifica intacto com exit não-zero', async () => {
  const runner = new NodeProcessRunner();
  const r = await runner.run(
    process.execPath,
    ['-e', "const s='erro: 🚀'.repeat(8000)+' ãõç'.repeat(8000);process.stderr.write(s);process.exitCode=3"],
    { timeoutMs: 15000 },
  );
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
  assert.equal(r.stderr, 'erro: 🚀'.repeat(8000) + ' ãõç'.repeat(8000));
  assert.equal(r.stdout, '');
});

// M2-F2: saída PARCIAL produzida antes do timeout é preservada (não descartada
// junto com a morte do processo) — distinta de saída completa com exit 0.
test('saída parcial antes do timeout é preservada', async () => {
  const runner = new NodeProcessRunner();
  const r = await runner.run(
    process.execPath,
    ['-e', 'process.stdout.write("parcial-🚀");setTimeout(function(){},30000)'],
    { timeoutMs: 500 },
  );
  assert.equal(r.timedOut, true);
  assert.equal(r.stdout, 'parcial-🚀');
});

// C04: sem consulta ao codex REAL — fixture de diretório temporário na frente do PATH.
test('resolveExecutable encontra shim no PATH do Windows', async (t) => {
  if (process.platform !== 'win32') return t.skip('somente Windows');
  const { resolveExecutable } = await import('../../src/adapters/process.js');
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-b-path-'));
  await writeFile(join(dir, 'sdlc-codex-fixture.cmd'), '@echo off\r\nexit /b 0\r\n');
  const env = { ...process.env, PATH: `${dir};${process.env.PATH ?? ''}` };
  const found = await resolveExecutable('sdlc-codex-fixture', env);
  assert.equal(await realpath(found), await realpath(join(dir, 'sdlc-codex-fixture.cmd')));
  void execFile;
});
