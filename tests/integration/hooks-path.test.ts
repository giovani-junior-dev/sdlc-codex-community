import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { adopt } from '../../src/project/adopt.js';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { handleHook } from '../../src/hooks/entry.js';

// C06: projectId em UUID (validação de config da Frente A).
const PROJECT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONFIG = { schemaVersion: 1, projectId: PROJECT_ID, projectName: 'P', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'] };

/** Percurso completo exigido por C06: adopt --apply → hooks.json instalado
 * (com entradas externas preservadas) → comando de hook instalado executado a
 * partir de payload realista → registro/contexto/política corretos. */
test('adopt → hooks instalado → payload → registro/contexto/política', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-b-path-'));
  const cfg = join(root, 'config.json');
  await writeFile(cfg, JSON.stringify(CONFIG));
  await mkdir(join(root, '.codex'), { recursive: true });
  // Hook externo préexistente que a adoção precisa preservar.
  await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'meu-logger --inicio', timeout: 4242 }] }] },
  }, null, 2));

  await adopt(root, cfg, true);

  // 1. Arquivo instalado existe, contém entradas gerenciadas e preserva as externas.
  const installed = JSON.parse(await readFile(join(root, '.codex', 'hooks.json'), 'utf8')) as any;
  const startCommands = installed.hooks.SessionStart.flatMap((m: any) => m.hooks).map((h: any) => h.command);
  assert.ok(startCommands.includes('meu-logger --inicio'), 'hook externo preservado');
  const startEntry = installed.hooks.SessionStart
    .flatMap((m: any) => m.hooks)
    .find((h: any) => h.command === 'sdlc-codex hook SessionStart');
  assert.ok(startEntry, 'entrada gerenciada instalada');
  assert.equal(startEntry.timeout, 15);
  for (const event of ['SessionEnd', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop']) {
    const cmd = installed.hooks[event]?.flatMap((m: any) => m.hooks ?? []).find((h: any) => h.command === `sdlc-codex hook ${event}`);
    assert.ok(cmd, `evento ${event} instalado`);
  }
  // R4-09: interceptação real de ferramenta instalada (matcher Bash|apply_patch).
  const pre = installed.hooks.PreToolUse?.flatMap((m: any) => m.hooks ?? []).find((h: any) => h.command === 'sdlc-codex hook PreToolUse');
  assert.ok(pre, 'PreToolUse gerenciado instalado');
  assert.equal(installed.hooks.PreToolUse[0].matcher, 'Bash|apply_patch');
  // O comando instalado é exatamente o caminho executável do hook (arg <evento>).
  const stopEntry = installed.hooks.Stop.flatMap((m: any) => m.hooks).find((h: any) => h.command === 'sdlc-codex hook Stop');
  assert.match(stopEntry.command, /^sdlc-codex hook (SessionStart|SessionEnd|PreCompact|PostCompact|UserPromptSubmit|Stop)$/);

  // 2. Execução do hook a partir do payload realista (stdin → handleHook, como
  //    o comando instalado faz: `sdlc-codex hook SessionStart` lê o JSON).
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId: PROJECT_ID });
  await store.init(PROJECT_ID);
  const registry = new SessionRegistry(store);
  const launch = await registry.prepare({ projectId: PROJECT_ID, role: 'planner', cwd: root });

  const out = await handleHook(registry, {
    type: 'SessionStart',
    session_id: '11112222-3333-4444-8555-666677778888',
    cwd: root,
    project_id: PROJECT_ID,
    role: 'planner',
    token: launch.token,
  });
  assert.equal(out.exitCode, 0);
  const start = JSON.parse(out.json).hookSpecificOutput;
  assert.equal(start.hookEventName, 'SessionStart');
  assert.match(start.additionalContext, /Você é o papel planner/);
  assert.match(start.additionalContext, /Persona: roles\/planner\.md/);
  assert.match(start.additionalContext, /aguardando confirmação de readiness/, 'apenas o hook observado: ainda não é a vigente');
  // Fato Herdr (M5-F1): launcher confirma readiness → geração vira 'ready'.
  await registry.confirmReady(launch.generationId);
  const readyOut = await handleHook(registry, {
    type: 'UserPromptSubmit', role: 'planner', cwd: root, prompt: 'ok',
  });
  assert.match(JSON.parse(readyOut.json).hookSpecificOutput.additionalContext, new RegExp(`Geração vigente: ${launch.generationId}`));

  // 3. SessionEnd pelo comando instalado fecha a sessão registrada.
  const end = await handleHook(registry, { type: 'SessionEnd', session_id: '11112222-3333-4444-8555-666677778888' });
  assert.equal(end.exitCode, 0);
  assert.equal(JSON.parse(end.json).hookSpecificOutput.hookEventName, 'SessionEnd');
  const afterEnd = await registry.state();
  assert.equal(afterEnd.sessions[0].status, 'closed');

  // 4. Evento de contexto (UserPromptSubmit) NÃO registra e devolve contexto +
  //    política INFORMATIVA embutida em additionalContext (apply_patch protegido).
  const sessionsBefore = afterEnd.sessions.length;
  const up = await handleHook(registry, {
    type: 'UserPromptSubmit',
    role: 'planner',
    cwd: root,
    prompt: 'qualquer',
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: .sdlc-codex/runtime.json' },
  });
  assert.equal(up.exitCode, 0, 'evento de contexto nunca bloqueia');
  const upOut = JSON.parse(up.json).hookSpecificOutput;
  assert.equal(upOut.hookEventName, 'UserPromptSubmit');
  assert.match(upOut.additionalContext, /NEGADA — caminho protegido/, 'veredito negativo informado no contexto');
  assert.match(upOut.additionalContext, /Você é o papel planner/);
  const afterUp = await registry.state();
  assert.equal(afterUp.sessions.length, sessionsBefore, 'evento de contexto nunca registra sessão');

  // 5. Evento desconhecido falha explicitamente em vez de cair em registro.
  await assert.rejects(() => handleHook(registry, { type: 'Bogus', session_id: 'x' }), /não suportado/);
});
