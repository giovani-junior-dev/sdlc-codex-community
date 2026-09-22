import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../src/cli.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, value: { stdout: (v: string) => out.push(v), stderr: (v: string) => err.push(v) } };
}

test('help retorna zero e documenta comandos', async () => {
  const x = io();
  assert.equal(await runCli(['--help'], x.value), 0);
  for (const cmd of ['doctor', 'adopt', 'up', 'status', 'start', 'send', 'receive', 'finish-message', 'check', 'next', 'recover', 'hook']) {
    assert.match(x.out[0], new RegExp(cmd));
  }
});

test('comando desconhecido retorna código 2', async () => {
  const x = io();
  assert.equal(await runCli(['wat'], x.value), 2);
  assert.match(x.err[0], /desconhecido/);
});

test('hook sem payload retorna erro explícito, nunca sucesso vazio', async () => {
  const x = io();
  const code = await runCli(['hook', 'SessionStart', '--project', 'C:\\missing', '--payload-file', 'C:\\missing\\p.json'], x.value);
  assert.ok([1, 2].includes(code));
});

test('start sem argumentos obrigatórios retorna código 2', async () => {
  const x = io();
  assert.equal(await runCli(['start'], x.value, { stdin: async () => '' }), 2);
});
