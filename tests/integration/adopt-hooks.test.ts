import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adopt } from '../../src/project/adopt.js';

// C05: projectId em UUID — validação de config endurecida pela Frente A.
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const CONFIG = { schemaVersion: 1, projectId: PROJECT_ID, projectName: 'P', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'] };

async function projectWith(extra: Record<string, string> = {}): Promise<{ root: string; cfg: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-b-adopt-'));
  const cfg = join(root, 'config.json');
  await writeFile(cfg, JSON.stringify(CONFIG));
  for (const [name, content] of Object.entries(extra)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return { root, cfg };
}

async function readHooks(root: string): Promise<any> {
  return JSON.parse(await readFile(join(root, '.codex', 'hooks.json'), 'utf8'));
}

const managedSessionStart = (root: string) => ({
  type: 'command', command: 'sdlc-codex hook SessionStart', timeout: 15,
  commandWindows: `"${process.execPath}" "${fileURLToPath(new URL('../../src/cli.js', import.meta.url))}" hook SessionStart`,
});

// C05: adoção repetida é idempotente (hooks mesclados não geram novo diff).
test('adoção com hooks é idempotente', async () => {
  const { root, cfg } = await projectWith({ 'AGENTS.md': 'instruções do usuário\n', '.gitignore': 'node_modules\n' });
  const first = await adopt(root, cfg, true);
  assert.equal(first.changed.length, 5); // config, AGENTS, hooks, gitignore, shim local
  const second = await adopt(root, cfg, true);
  assert.equal(second.changed.length, 0);
  assert.deepEqual(second.diff, []);
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /instruções do usuário/);
  const hooks = await readHooks(root);
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.deepEqual(hooks.hooks.SessionStart[0].hooks[0], managedSessionStart(root));
  const shim = await readFile(join(root, '.sdlc-codex', 'bin', 'sdlc-codex.cmd'), 'utf8');
  assert.match(shim, /node\.exe/i, 'shim fixa o runtime Node que executa a CLI');
  assert.match(shim, /cli\.js/i, 'shim aponta para o entrypoint desta instalação');
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /\.sdlc-codex\/bin\//, 'shim local e específico da máquina fica ignorado');
});

// C05: hooks externos e propriedades desconhecidas válidas são preservados.
test('adoção preserva hook personalizado e configuração adicional', async () => {
  const external = {
    version: 7,
    hooks: {
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'meu-logger --inicio', timeout: 9999 }] },
      ],
      Stop: [
        { hooks: [{ type: 'command', command: 'meu-logger --fim' }] },
      ],
    },
  };
  const { root, cfg } = await projectWith({ '.codex/hooks.json': JSON.stringify(external, null, 2) });
  const result = await adopt(root, cfg, true);
  assert.ok(result.changed.some(f => f.replace(/\\/g, '/').endsWith('.codex/hooks.json')));
  const hooks = await readHooks(root);
  assert.equal(hooks.version, 7, 'propriedade externa de topo preservada');
  // Externo preservado ANTES da entrada gerenciada.
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'meu-logger --inicio');
  assert.deepEqual(hooks.hooks.SessionStart[1].hooks[0], managedSessionStart(root));
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'meu-logger --fim');
  // Backup do preexistente.
  assert.equal((await readFile(join(root, '.codex', 'hooks.json.bak'), 'utf8')), JSON.stringify(external, null, 2));
  // Segunda adoção: nada muda.
  const again = await adopt(root, cfg, true);
  assert.equal(again.changed.length, 0);
});

// R4-12: entrada gerenciada desatualizada é ATUALIZADA NO LUGAR (mescla por
// ENTRADAS do matcher) — a entrada externa do mesmo matcher é preservada na
// posição original e o matcher não é descartado/recriado.
test('adoção atualiza entrada gerenciada desatualizada no lugar, sem tocar externas', async () => {
  const stale = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'sdlc-codex hook SessionStart', timeout: 100 }, { type: 'command', command: 'outro-hook-externo' }] },
      ],
    },
  };
  const { root, cfg } = await projectWith({ '.codex/hooks.json': JSON.stringify(stale) });
  await adopt(root, cfg, true);
  const hooks = await readHooks(root);
  assert.equal(hooks.hooks.SessionStart.length, 1, 'matcher único (misto), não recriado');
  assert.deepEqual(hooks.hooks.SessionStart[0].hooks[0], managedSessionStart(root), 'gerenciada substituída no lugar (posição original) pela definição vigente');
  assert.equal(hooks.hooks.SessionStart[0].hooks[1].command, 'outro-hook-externo', 'externa preservada');
  const again = await adopt(root, cfg, true);
  assert.equal(again.changed.length, 0, 'adoção repetida após atualização é no-op');
});

// R4-12 (núcleo): matcher MISTO (hook do usuário + gerenciado) preserva AMBOS.
test('matcher misto preserva hook do usuário e gerenciado após adoção', async () => {
  const mixed = {
    hooks: {
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'meu-logger --inicio', timeout: 9999 }, { type: 'command', command: 'sdlc-codex hook SessionStart', timeout: 15000 }] },
      ],
    },
  };
  const { root, cfg } = await projectWith({ '.codex/hooks.json': JSON.stringify(mixed) });
  await adopt(root, cfg, true);
  const hooks = await readHooks(root);
  assert.equal(hooks.hooks.SessionStart.length, 1, 'matcher misto continua único');
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup', 'propriedade do matcher preservada');
  assert.equal(hooks.hooks.SessionStart[0].hooks.length, 2, 'NENHUM hook perdido (R4-12)');
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'meu-logger --inicio', 'hook do usuário intacto, na posição original');
  assert.deepEqual(hooks.hooks.SessionStart[0].hooks[1], managedSessionStart(root), 'gerenciado canônico');
  const again = await adopt(root, cfg, true);
  assert.equal(again.changed.length, 0, 'idempotente após mescla');
});

// R4-12: comando do USUÁRIO que menciona o nome do produto como texto comum
// NÃO é classificado como gerenciado (identificação exata, não por substring).
test('comando do usuário com nome do produto só como texto é preservado', async () => {
  const user = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'meu-logger "ignorar sdlc-codex hook SessionStart"' }] },
        { hooks: [{ type: 'command', command: 'sdlc-codex hook SessionStart' }] },
      ],
      Stop: [
        { hooks: [{ type: 'command', command: 'echo sdlc-codex hook Stop > /dev/null' }] },
      ],
    },
  };
  const { root, cfg } = await projectWith({ '.codex/hooks.json': JSON.stringify(user) });
  await adopt(root, cfg, true);
  const hooks = await readHooks(root);
  const start = hooks.hooks.SessionStart;
  assert.equal(start.length, 2, 'dois matchers: externo intacto + gerenciado canônico');
  assert.equal(start[0].hooks[0].command, 'meu-logger "ignorar sdlc-codex hook SessionStart"', 'texto comum não vira gerenciado');
  assert.deepEqual(start[1].hooks[0], managedSessionStart(root));
  // Stop: comando do usuário com substring preservado E matcher canônico anexado.
  assert.equal(hooks.hooks.Stop.length, 2);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /^echo sdlc-codex hook Stop/);
  assert.equal(hooks.hooks.Stop[1].hooks[0].command, 'sdlc-codex hook Stop');
  const again = await adopt(root, cfg, true);
  assert.equal(again.changed.length, 0, 'idempotente: texto comum nunca é absorvido');
});

// R4-12: evento NÃO gerenciado (ex.: Notification) preservado intacto.
test('evento não gerenciado é preservado intacto', async () => {
  const withUnknown = {
    hooks: {
      Notification: [
        { hooks: [{ type: 'command', command: 'meu-notifier', timeout: 1234 }] },
      ],
    },
  };
  const { root, cfg } = await projectWith({ '.codex/hooks.json': JSON.stringify(withUnknown) });
  await adopt(root, cfg, true);
  const hooks = await readHooks(root);
  assert.deepEqual(hooks.hooks.Notification, withUnknown.hooks.Notification, 'evento externo intacto');
  // Gerenciados adicionados sem tocar o externo.
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.equal(hooks.hooks.Stop.length, 1);
  const again = await adopt(root, cfg, true);
  assert.equal(again.changed.length, 0);
});

// R4-09: interceptação real — PreToolUse gerenciado instalado (matcher Bash|apply_patch).
test('adoção instala PreToolUse gerenciado com matcher de ferramenta', async () => {
  const { root, cfg } = await projectWith();
  await adopt(root, cfg, true);
  const hooks = await readHooks(root);
  const pre = hooks.hooks.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length === 1, 'PreToolUse gerenciado instalado');
  assert.equal(pre[0].matcher, 'Bash|apply_patch');
  assert.deepEqual(pre[0].hooks[0], {
    type: 'command', command: 'sdlc-codex hook PreToolUse', timeout: 10,
    commandWindows: `"${process.execPath}" "${fileURLToPath(new URL('../../src/cli.js', import.meta.url))}" hook PreToolUse`,
  });
  const again = await adopt(root, cfg, true);
  assert.equal(again.changed.length, 0, 'idempotente');
});

// C05: JSON malformado préexistente → adopt FALHA e NÃO grava nada.
test('hooks.json malformado préexistente impede a adoção sem sobrescrever', async () => {
  const malformed = '{ "hooks": { "SessionStart": [ ';
  const { root, cfg } = await projectWith({ '.codex/hooks.json': malformed, 'AGENTS.md': 'conteudo\n' });
  await assert.rejects(() => adopt(root, cfg, true), /JSON malformado/);
  assert.equal(await readFile(join(root, '.codex', 'hooks.json'), 'utf8'), malformed, 'arquivo original intacto');
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'conteudo\n', 'nenhuma outra gravação aconteceu');
  await assert.rejects(() => readFile(join(root, '.sdlc-codex', 'config.json'), 'utf8'), /ENOENT/);
});

// C05: falha de BACKUP aborta a adoção sem sobrescrever o arquivo preexistente.
test('falha de backup aborta sem sobrescrever hooks.json', async (t) => {
  if (process.platform === 'linux') return t.skip('requer writeFile em diretório falhando');
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'externo' }] }] } });
  const { root, cfg } = await projectWith({ '.codex/hooks.json': original });
  // hooks.json.bak como DIRETÓRIO faz o backup falhar (EISDIR/EPERM).
  await mkdir(join(root, '.codex', 'hooks.json.bak'));
  await assert.rejects(() => adopt(root, cfg, true), /backup/);
  assert.equal(await readFile(join(root, '.codex', 'hooks.json'), 'utf8'), original, 'original preservado');
});

// C05: falha de backup do AGENTS.md aborta sem sobrescrever.
test('falha de backup aborta sem sobrescrever AGENTS.md', async (t) => {
  if (process.platform === 'linux') return t.skip('requer writeFile em diretório falhando');
  const { root, cfg } = await projectWith({ 'AGENTS.md': 'precioso\n' });
  await mkdir(join(root, 'AGENTS.md.bak'));
  await assert.rejects(() => adopt(root, cfg, true), /backup/);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'precioso\n');
});

// C05: .gitignore existente preservado com backup; bloco gerenciado não duplica.
test('adoção preserva .gitignore existente e não duplica bloco gerenciado', async () => {
  const { root, cfg } = await projectWith({ '.gitignore': 'node_modules\ndist/\n' });
  await adopt(root, cfg, true);
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /node_modules/);
  assert.match(ignore, /runtime\.json/);
  assert.equal((await readFile(join(root, '.gitignore.bak'), 'utf8')), 'node_modules\ndist/\n');
  await adopt(root, cfg, true);
  assert.equal((await readFile(join(root, '.gitignore'), 'utf8')).split('sdlc-codex:begin').length, 2);
});
