import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIo } from '../../src/cli.js';
import { adopt } from '../../src/project/adopt.js';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import type { Role } from '../../src/contracts.js';

// R4-09 — regressão na FRONTEIRA PÚBLICA: o comando instalado
// (`sdlc-codex hook <evento>`, stdin JSON) precisa PRESERVAR a decisão da
// política: deny sai como exit 2 + stderr + permissionDecision "deny" no JSON
// do stdout (formato wire do Codex 0.155.1), nunca como exit 0 com contexto.
// São simulações contratuais com fixtures temporárias — NÃO é hook live.

const PROJECT_ID = '99999999-8888-4777-9666-555555555555';
const SESSION_ID = '11112222-3333-4444-8555-666677778888';

function ioCapture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: v => out.push(v), stderr: v => err.push(v) }, out, err };
}

async function adoptedProject(extraConfig: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-hookcli-'));
  const cfg = join(root, 'config.json');
  await writeFile(cfg, JSON.stringify({
    schemaVersion: 1, projectId: PROJECT_ID, projectName: 'P', prBase: 'main',
    checks: {}, models: {}, protectedPaths: ['.git'],
    ...extraConfig,
  }));
  await adopt(root, cfg, true);
  return root;
}

async function registerSession(root: string, sessionId = SESSION_ID, role: Role = 'dev'): Promise<void> {
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId: PROJECT_ID });
  await store.init(PROJECT_ID);
  const registry = new SessionRegistry(store);
  const launch = await registry.prepare({ projectId: PROJECT_ID, role, cwd: root });
  const result = await runCli(['hook', 'SessionStart', '--project', root], ioCapture().io, {
    stdin: async () => JSON.stringify({
      hook_event_name: 'SessionStart', session_id: sessionId, cwd: root,
      project_id: PROJECT_ID, role, token: launch.token,
    }),
  });
  assert.equal(result, 0, 'SessionStart via CLI registra a sessão');
}

/** Roda `sdlc-codex hook <event>` via CLI com payload no stdin. */
async function hookCli(root: string, event: string, payload: Record<string, unknown>) {
  const { io, out, err } = ioCapture();
  const code = await runCli(['hook', event, '--project', root], io, {
    stdin: async () => JSON.stringify(payload),
  });
  let parsed: any;
  try { parsed = JSON.parse(out[0] ?? ''); } catch { parsed = undefined; }
  return { code, out, err, wire: parsed?.hookSpecificOutput, raw: out[0] ?? '' };
}

test('PreToolUse allow: comando git autorizado → exit 0 + permissionDecision allow', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const r = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: root,
    tool_name: 'Bash', tool_input: { command: 'git status' },
  });
  assert.equal(r.code, 0, `stderr: ${r.err.join(' | ')}`);
  assert.equal(r.wire.hookEventName, 'PreToolUse');
  assert.equal(r.wire.permissionDecision, 'allow');
  assert.equal(r.err.length, 0);
});

test('PreToolUse deny: apply_patch em caminho protegido → exit 2 + stderr + deny no JSON', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const r = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: root,
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: .sdlc-codex/runtime.json' },
  });
  assert.equal(r.code, 2, 'deny precisa sair como exit 2 (R4-09)');
  assert.equal(r.wire.permissionDecision, 'deny');
  assert.match(r.wire.permissionDecisionReason, /caminho protegido/);
  assert.match(r.err.join('\n'), /caminho protegido/, 'razão também no stderr (mecanismo exit-2 do runtime)');
});

test('PreToolUse deny: protectedPaths custom da config são respeitados', async () => {
  const root = await adoptedProject({ protectedPaths: ['.git', 'secrets/'] });
  await registerSession(root);
  const denied = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: root,
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: secrets/key.txt' },
  });
  assert.equal(denied.code, 2);
  assert.match(denied.wire.permissionDecisionReason, /caminho protegido/);
  // Fora do protegido custom: allow.
  const allowed = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: root,
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/app.ts' },
  });
  assert.equal(allowed.code, 0, `stderr: ${allowed.err.join(' | ')}`);
  assert.equal(allowed.wire.permissionDecision, 'allow');
});

test('PreToolUse deny: push para branch protegida (prBase) é humano', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const r = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: root,
    tool_name: 'Bash', tool_input: { command: 'git push origin main' },
  });
  assert.equal(r.code, 2);
  assert.match(r.wire.permissionDecisionReason, /branch protegida/);
  // push da branch de trabalho continua autorizado.
  const ok = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: root,
    tool_name: 'Bash', tool_input: { command: 'git push origin sdlc/demanda' },
  });
  assert.equal(ok.code, 0);
});

test('PreToolUse sem ferramenta no payload: contexto puro, exit 0, sem decisão', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const r = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: root, role: 'dev',
  });
  assert.equal(r.code, 0);
  assert.equal(r.wire.permissionDecision, undefined, 'sem ferramenta não há decisão de ferramenta');
  assert.match(r.wire.additionalContext, /Você é o papel dev/);
});

test('PreToolUse com sessão não registrada falha fechado (deny)', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const r = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: '00000000-0000-0000-0000-000000000000', cwd: root,
    tool_name: 'Bash', tool_input: { command: 'git status' },
  });
  assert.equal(r.code, 2);
  assert.match(r.wire.permissionDecisionReason, /não registrada/);
});

test('PreToolUse resolve config do projeto principal a partir de worktree/subdiretório', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const sub = join(root, 'worktrees', 'demanda-x', 'src');
  await mkdir(sub, { recursive: true });
  // R5-09: o caminho da ação resolve contra o cwd do payload; o protegido, contra a raiz
  // principal. `../../../.sdlc-codex/runtime.json` de <raiz>/worktrees/demanda-x/src é o
  // runtime.json REAL da raiz (o relativo `.sdlc-codex/runtime.json` apontaria para um
  // arquivo dentro do subdiretório, que a política antiga negava por resolver os dois
  // lados contra a mesma base).
  const r = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: sub,
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: ../../../.sdlc-codex/runtime.json' },
  });
  assert.equal(r.code, 2, 'protectedPaths resolvidos contra o checkout principal mesmo a partir de subdiretório');
  assert.match(r.wire.permissionDecisionReason, /caminho protegido/);
});

test('PreToolUse sem configuração localizável NEGA (falha fechada, nunca relaxa)', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const foreign = await mkdtemp(join(tmpdir(), 'sdlc-foreign-'));
  const r = await hookCli(root, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: foreign,
    tool_name: 'Bash', tool_input: { command: 'git status' },
  });
  assert.equal(r.code, 2, 'sem config o padrão é negar, não permitir');
  assert.match(r.wire.permissionDecisionReason, /falha fechada/);
});

test('payload inválido e evento desconhecido falham com exit não zero', async () => {
  const root = await adoptedProject();
  const bad = ioCapture();
  const badCode = await runCli(['hook', 'PreToolUse', '--project', root], bad.io, { stdin: async () => 'não-json' });
  assert.equal(badCode, 2);
  assert.match(bad.err.join('\n'), /JSON inválido/);
  const unknown = await hookCli(root, 'Bogus', { hook_event_name: 'Bogus' });
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err.join('\n'), /não suportado/);
});

test('evento de contexto via CLI: exit 0, additionalContext com persona e política informativa', async () => {
  const root = await adoptedProject();
  await registerSession(root, SESSION_ID, 'planner');
  const r = await hookCli(root, 'UserPromptSubmit', {
    hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID, cwd: root, role: 'planner',
    prompt: 'continue',
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: .git/config' },
  });
  assert.equal(r.code, 0, 'evento de contexto nunca bloqueia');
  assert.equal(r.wire.hookEventName, 'UserPromptSubmit');
  assert.match(r.wire.additionalContext, /Você é o papel planner/);
  assert.match(r.wire.additionalContext, /NEGADA — caminho protegido/);
});

test('PostToolUse nunca bloqueia ação (auditoria apenas), mesmo com política negativa', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const r = await hookCli(root, 'PostToolUse', {
    hook_event_name: 'PostToolUse', session_id: SESSION_ID, cwd: root,
    tool_name: 'Bash', tool_input: { command: 'git push origin main' },
  });
  assert.equal(r.code, 0, 'PostToolUse não afirma proteção inexistente sobre ação já executada');
  assert.equal(r.wire.permissionDecision, undefined);
});

test('SessionStart via --payload-file registra e devolve additionalContext', async () => {
  const root = await adoptedProject();
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId: PROJECT_ID });
  await store.init(PROJECT_ID);
  const registry = new SessionRegistry(store);
  const launch = await registry.prepare({ projectId: PROJECT_ID, role: 'reviewer', cwd: root });
  const payloadPath = join(root, 'payload.json');
  await writeFile(payloadPath, JSON.stringify({
    hook_event_name: 'SessionStart', session_id: SESSION_ID, cwd: root,
    project_id: PROJECT_ID, role: 'reviewer', token: launch.token,
  }));
  const { io, out } = ioCapture();
  const code = await runCli(['hook', 'SessionStart', '--project', root, '--payload-file', 'payload.json'], io);
  assert.equal(code, 0);
  const wire = JSON.parse(out[0]).hookSpecificOutput;
  assert.equal(wire.hookEventName, 'SessionStart');
  assert.match(wire.additionalContext, /Você é o papel reviewer/);
});

// R4-09: exercitar o COMANDO INSTALADO de verdade (subprocesso node <cli.js>),
// com payload real no stdin e verificação de exit code do processo — não só
// runCli/handleHook diretos. Caminho do binário relativo a este teste compilado.
test('comando instalado: PreToolUse deny preserva exit 2 no processo real', async () => {
  const root = await adoptedProject();
  await registerSession(root);
  const cliJs = new URL('../../src/cli.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd: root,
    tool_name: 'Bash', tool_input: { command: 'git push --force origin sdlc/x' },
  });
  const { spawn } = await import('node:child_process');
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliJs, 'hook', 'PreToolUse', '--project', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    child.stdin.write(payload);
    child.stdin.end();
  });
  assert.equal(result.code, 2, 'exit code do processo real preserva o deny');
  assert.match(result.stderr, /force-push|gate humano/);
  const wire = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(wire.permissionDecision, 'deny');
  assert.match(wire.permissionDecisionReason, /force-push/);
});
