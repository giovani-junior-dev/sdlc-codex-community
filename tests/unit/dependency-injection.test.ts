import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * C01 / critério de aceite — proteção testável contra escape de dependências falsas.
 * Um teste configurado com runner falso deve falhar se qualquer componente tentar
 * usar dependência real fora da composição autorizada. A composição de adaptadores
 * reais (NodeProcessRunner/HerdrProcessAdapter) só pode ocorrer em src/cli.ts e
 * sempre a partir de `deps.runner ?? ...` / `deps.herdr ?? ...`. Este teste varre
 * o código-fonte e reprova qualquer construção fora desse padrão — reproduzindo
 * exatamente a regressão reprovada na revisão (dispatcher criando
 * `new NodeProcessRunner()` internamente).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
// Compilado: <root>/dist/tests/unit/*.js → src em ../../../src.
const SRC = [join(HERE, '..', '..', '..', 'src'), join(HERE, '..', '..', 'src')]
  .find(candidate => { try { return existsSync(join(candidate, 'cli.ts')); } catch { return false; } }) ?? join(HERE, '..', '..', '..', 'src');
const REAL_ADAPTERS = ['new NodeProcessRunner(', 'new HerdrProcessAdapter('];

async function sourceFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

test('adaptadores reais só são construídos na composição da CLI, a partir do runner injetado', async () => {
  const files = await sourceFiles(SRC);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const rel = file.replace(/\\/g, '/').split('/src/')[1];
    for (const needle of REAL_ADAPTERS) {
      const occurrences = text.split(needle).length - 1;
      if (!occurrences) continue;
      assert.equal(rel, 'cli.ts', `${needle} fora da composição: ${rel} (${occurrences}x) — injete a dependência`);
      if (needle === 'new NodeProcessRunner(') {
        const guarded = text.split('deps.runner ?? new NodeProcessRunner(').length - 1;
        assert.equal(guarded, occurrences, `NodeProcessRunner sem o guard deps.runner ?? em cli.ts`);
      } else {
        const guarded = text.split('deps.herdr ?? new HerdrProcessAdapter(').length - 1;
        assert.equal(guarded, occurrences, `HerdrProcessAdapter sem o guard deps.herdr ?? em cli.ts`);
      }
    }
  }
});

test('adaptadores de transporte/git usam exclusivamente o runner injetado (cli.ts)', async () => {
  const text = await readFile(join(SRC, 'cli.ts'), 'utf8');
  // Toda construção CodexTransport/GitAdapter/GhAdapter em cli.ts deve receber a
  // variável `runner` (nunca outra expressão) — nada de transporte paralelo.
  for (const m of text.matchAll(/new CodexTransport\(([^)]*)\)/g)) {
    assert.equal(m[1].trim(), 'runner', `CodexTransport com dependência não injetada: ${m[0]}`);
  }
  for (const m of text.matchAll(/new GitAdapter\(([^)]*)\)/g)) {
    assert.equal(m[1].trim(), 'runner', `GitAdapter com dependência não injetada: ${m[0]}`);
  }
  for (const m of text.matchAll(/new GhAdapter\(([^)]*)\)/g)) {
    assert.equal(m[1].trim(), 'runner', `GhAdapter com dependência não injetada: ${m[0]}`);
  }
});

test('up não resolve Codex nativo quando o adaptador Herdr foi injetado', async () => {
  const text = await readFile(join(SRC, 'cli.ts'), 'utf8');
  assert.match(
    text,
    /const nativeCodexExecutable = process\.platform === 'win32' && !deps\.herdr/,
    'a composição de teste com Herdr injetado deve permanecer independente da instalação local do Codex',
  );
});
