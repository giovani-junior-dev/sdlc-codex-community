import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runCli, type CliIo } from '../../src/cli.js';
import { adopt } from '../../src/project/adopt.js';
import { StateStore } from '../../src/state/store.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { checkPolicy } from '../../src/hooks/policy.js';
import type { Role } from '../../src/contracts.js';

// R5-09 — regressões na FRONTEIRA PÚBLICA (runCli hook PreToolUse com payload
// real do Codex): a política precisa extrair caminhos pela GRAMÁTICA do
// apply_patch, resolver o protegido contra a RAIZ principal e o caminho da
// ação contra o cwd do payload. Nenhum teste aplica patch: os arquivos reais
// do projeto temporário são conferidos byte a byte após cada decisão.
// Simulações contratuais com fixtures temporárias — NÃO é hook live.

// O launcher exporta esta variável nas tabs reais; aqui a raiz vem do cwd do payload.
delete process.env.SDLC_CODEX_PROJECT_ROOT;

const PROJECT_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const SESSION_ID = '21212222-3333-4444-8555-666677778888';
const IS_WIN = process.platform === 'win32';

function ioCapture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: v => out.push(v), stderr: v => err.push(v) }, out, err };
}

/** Projeto adotado com arquivos reais que NENHUM teste pode alterar. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-r509-'));
  const cfg = join(root, 'config.json');
  await writeFile(cfg, JSON.stringify({
    schemaVersion: 1, projectId: PROJECT_ID, projectName: 'P', prBase: 'main', checks: {}, models: {},
    protectedPaths: ['AGENTS.md', 'protected', 'docs', 'área restrita'],
  }));
  await adopt(root, cfg, true);
  for (const [rel, body] of [
    ['AGENTS.md', 'agents-original'], ['protected/config.json', 'cfg-original'],
    ['protected-other/x.txt', 'livre'], ['protected2/x.txt', 'livre'], ['src/a.ts', 'export {}'],
    ['docs/relatório final.md', 'doc-original'], ['área restrita/dados.txt', 'dados-original'],
  ] as const) {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), body);
  }
  return root;
}

async function registerSession(root: string, cwd = root, role: Role = 'dev'): Promise<void> {
  const store = new StateStore(join(root, '.sdlc-codex'), { projectId: PROJECT_ID });
  await store.init(PROJECT_ID);
  const registry = new SessionRegistry(store);
  const launch = await registry.prepare({ projectId: PROJECT_ID, role, cwd });
  const code = await runCli(['hook', 'SessionStart', '--project', root], ioCapture().io, {
    stdin: async () => JSON.stringify({
      hook_event_name: 'SessionStart', session_id: SESSION_ID, cwd,
      project_id: PROJECT_ID, role, token: launch.token,
    }),
  });
  assert.equal(code, 0, 'SessionStart via CLI registra a sessão');
}

/** Árvore de arquivos (caminho relativo → conteúdo), sem o diretório operacional. */
async function tree(root: string, dir = root, acc: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.sdlc-codex' || entry.name === 'config.json' && dir === root) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await tree(root, full, acc);
    else if (entry.isFile()) acc[relative(root, full)] = await readFile(full, 'utf8');
  }
  return acc;
}

const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const upd = (path: string): string => `*** Update File: ${path}\n@@\n-a\n+b`;

async function preToolUse(root: string, cwd: string, tool: string, toolInput: Record<string, unknown>) {
  const { io, out, err } = ioCapture();
  const code = await runCli(['hook', 'PreToolUse', '--project', root], io, {
    stdin: async () => JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: SESSION_ID, cwd, tool_name: tool, tool_input: toolInput,
    }),
  });
  let wire: any;
  try { wire = JSON.parse(out[0] ?? '').hookSpecificOutput; } catch { wire = undefined; }
  return { code, wire, err: err.join('\n') };
}

async function expectDeny(root: string, cwd: string, command: unknown, reason: RegExp, tool = 'apply_patch'): Promise<void> {
  const before = await tree(root);
  const r = await preToolUse(root, cwd, tool, { command });
  assert.equal(r.code, 2, `deny esperado (exit 2), obtido ${r.code}; wire=${JSON.stringify(r.wire)}`);
  assert.equal(r.wire?.permissionDecision, 'deny');
  assert.match(r.wire.permissionDecisionReason, reason);
  assert.match(r.err, reason, 'razão também no stderr');
  assert.deepEqual(await tree(root), before, 'nenhum arquivo real modificado');
}

async function expectAllow(root: string, cwd: string, command: unknown, tool = 'apply_patch'): Promise<void> {
  const before = await tree(root);
  const r = await preToolUse(root, cwd, tool, { command });
  assert.equal(r.code, 0, `allow esperado; wire=${JSON.stringify(r.wire)} stderr=${r.err}`);
  assert.equal(r.wire?.permissionDecision, 'allow');
  assert.deepEqual(await tree(root), before, 'a política nunca aplica o patch');
}

const PROT = /caminho protegido/;

test('R5-09 AGENTS.md protegido na raiz (nome sem barra) é negado; Add/Delete/Update/Move to', async () => {
  const root = await fixture();
  await registerSession(root);
  await expectDeny(root, root, patch(upd('AGENTS.md')), PROT);
  await expectDeny(root, root, patch('*** Add File: AGENTS.md\n+x'), PROT);
  await expectDeny(root, root, patch('*** Delete File: AGENTS.md'), PROT);
  // Rename PARA dentro do protegido e DE dentro do protegido.
  await expectDeny(root, root, patch(`${upd('src/a.ts')}\n*** Move to: protected/a.ts`), PROT);
  await expectDeny(root, root, patch(`${upd('protected/config.json')}\n*** Move to: src/b.ts`), PROT);
  // Forma shell com heredoc (matcher Bash) também é interceptada.
  await expectDeny(root, root,
    `apply_patch <<'EOF'\n${patch(upd('AGENTS.md'))}\nEOF`, PROT, 'Bash');
  // argv do shell em vetor: o patch dentro do argumento do `-lc` é lido igual.
  await expectDeny(root, root,
    ['bash', '-lc', `apply_patch <<'EOF'\n${patch(upd('AGENTS.md'))}\nEOF`], PROT, 'Bash');
});

test('R5-09 ../protected/config.json a partir de src é negado; caminho absoluto também', async () => {
  const root = await fixture();
  await registerSession(root);
  const src = join(root, 'src');
  await expectDeny(root, src, patch(upd('../protected/config.json')), PROT);
  await expectDeny(root, src, patch(upd('../AGENTS.md')), PROT);
  await expectDeny(root, root, patch(upd(join(root, 'protected', 'config.json'))), PROT);
  await expectDeny(root, src, patch(upd(join(root, 'AGENTS.md').replace(/\\/g, '/'))), PROT);
  // Equivalente relativo ao cwd que NÃO cai no protegido continua livre.
  await expectAllow(root, src, patch(upd('../protected-other/x.txt')));
});

test('R5-09 nomes com espaço e Unicode; maiúsculas equivalentes (Windows)', async () => {
  const root = await fixture();
  await registerSession(root);
  await expectDeny(root, root, patch(upd('docs/relatório final.md')), PROT);
  await expectDeny(root, root, patch('*** Add File: área restrita/novo arquivo.txt\n+x'), PROT);
  await expectDeny(root, root, patch(upd('docs/sub dir/ção.md')), PROT);
  if (IS_WIN) {
    await expectDeny(root, root, patch(upd('agents.MD')), PROT);
    await expectDeny(root, root, patch(upd('PROTECTED\\x')), PROT);
    await expectDeny(root, root, patch(upd('Docs/RELATÓRIO FINAL.md')), PROT);
    // Windows descarta ponto/espaço finais e trata ':' como stream alternativo.
    await expectDeny(root, root, patch(upd('AGENTS.md.')), PROT);
    await expectDeny(root, root, patch(upd('AGENTS.md::$DATA')), PROT);
  }
});

test('R5-09 limite de diretório: prefixo semelhante permitido; patch válido em caminho livre permitido', async () => {
  const root = await fixture();
  await registerSession(root);
  await expectAllow(root, root, patch(upd('protected-other/x.txt')));
  await expectAllow(root, root, patch(upd('protected2/x.txt')));
  await expectAllow(root, root, patch(upd('AGENTS.md.bak')));
  await expectAllow(root, root, patch(upd('src/a.ts')));
  await expectAllow(root, root, patch('*** Add File: src/novo módulo/n.ts\n+x'));
  // Vários arquivos, só o último protegido: nega o patch inteiro.
  await expectDeny(root, root, patch(upd('src/a.ts'), upd('protected-other/x.txt'), upd('protected/config.json')), PROT);
});

test('R5-09 falha de parsing de escrita reconhecida nega (fail-closed), nunca allow', async () => {
  const root = await fixture();
  await registerSession(root);
  const closed = /falha fechada/;
  await expectDeny(root, root, '*** Begin Patch\n*** End Patch', closed);
  await expectDeny(root, root, 'texto qualquer sem cabeçalhos', closed);
  await expectDeny(root, root, patch('*** Update File: '), closed);
  await expectDeny(root, root, '', closed);
  await expectDeny(root, root, 42, closed);
  await expectDeny(root, root, { nao: 'string' }, closed);
  // Shell que EXECUTA apply_patch com patch ilegível também nega; mera menção não.
  await expectDeny(root, root, 'apply_patch < patch.diff', closed, 'Bash');
  await expectAllow(root, root, 'grep -rn apply_patch src', 'Bash');
});

test('R5-09 ferramenta de arquivo (tool_input.file_path) preserva a proteção', async () => {
  const root = await fixture();
  await registerSession(root);
  const src = join(root, 'src');
  const deny = await preToolUse(root, src, 'Write', { file_path: '../AGENTS.md' });
  assert.equal(deny.code, 2);
  assert.match(deny.wire.permissionDecisionReason, PROT);
  const ok = await preToolUse(root, src, 'Write', { file_path: 'a.ts' });
  assert.equal(ok.code, 0);
  assert.equal(ok.wire.permissionDecision, 'allow');
});

test('R5-09 worktree do dev: src/a.ts permitido; AGENTS.md do worktree e operacionais da raiz negados', async () => {
  const root = await fixture();
  const wt = join(root, '.sdlc-codex', 'worktrees', 'demanda-x');
  const other = join(root, '.sdlc-codex', 'worktrees', 'outra');
  await mkdir(join(wt, 'src'), { recursive: true });
  await mkdir(other, { recursive: true });
  await registerSession(root, wt);
  const wtSrc = join(wt, 'src');
  // O dev escreve no PRÓPRIO worktree (exceção ligada ao projeto).
  await expectAllow(root, wtSrc, patch(upd('a.ts')));
  await expectAllow(root, wt, patch('*** Add File: src/novo/dir/b.ts\n+x'));
  // Protegido LÓGICO também vale relativo ao worktree e a outro worktree.
  await expectDeny(root, wt, patch(upd('AGENTS.md')), PROT);
  await expectDeny(root, wtSrc, patch(upd('../AGENTS.md')), PROT);
  await expectDeny(root, wt, patch(upd('protected/x.txt')), PROT);
  await expectDeny(root, wt, patch(upd('.git')), PROT);
  await expectDeny(root, wt, patch(upd('.sdlc-codex/config.json')), PROT);
  await expectDeny(root, wt, patch(upd('../outra/AGENTS.md')), PROT);
  // Operacionais da RAIZ e AGENTS.md da raiz continuam protegidos.
  await expectDeny(root, wt, patch(upd(join(root, '.sdlc-codex', 'runtime.json'))), PROT);
  await expectDeny(root, wt, patch(upd('../../runtime.json')), PROT);
  await expectDeny(root, wt, patch(upd('../../state.lock')), PROT);
  await expectDeny(root, wt, patch(upd('../../evidence/x.json')), PROT);
  await expectDeny(root, wt, patch(upd('../../config.json')), PROT);
  await expectDeny(root, wt, patch(upd(join(root, 'AGENTS.md'))), PROT);
  await expectDeny(root, wt, patch(upd(join(root, '.git', 'config'))), PROT);
});

test('R5-09 worktree FORA da árvore (SDLC_CODEX_PROJECT_ROOT): não relaxa por cwd externo', async () => {
  const root = await fixture();
  const ext = await mkdtemp(join(tmpdir(), 'sdlc-r509-ext-'));
  await mkdir(join(ext, 'src'), { recursive: true });
  await registerSession(root, ext);
  process.env.SDLC_CODEX_PROJECT_ROOT = root;
  try {
    await expectAllow(root, join(ext, 'src'), patch(upd('a.ts')));
    await expectDeny(root, join(ext, 'src'), patch(upd('../AGENTS.md')), PROT);
    await expectDeny(root, ext, patch(upd('protected/x')), PROT);
    await expectDeny(root, ext, patch(upd(join(root, 'AGENTS.md'))), PROT);
    await expectDeny(root, ext, patch(upd(join(root, '.sdlc-codex', 'runtime.json'))), PROT);
  } finally {
    delete process.env.SDLC_CODEX_PROJECT_ROOT;
  }
});

test('R5-09 junction para dentro do protegido é negada (ancestral existente canonicalizado)', async t => {
  const root = await fixture();
  await registerSession(root);
  try {
    await symlink(join(root, 'protected'), join(root, 'atalho'), 'junction');
  } catch (error) {
    t.skip(`junction/symlink não pôde ser criado nesta máquina: ${(error as Error).message}`);
    return;
  }
  await expectDeny(root, root, patch('*** Add File: atalho/novo.txt\n+x'), PROT);
  await expectDeny(root, root, patch(upd('atalho/config.json')), PROT);
  await expectAllow(root, root, patch(upd('src/a.ts')));
});

test('R5-09 nome curto 8.3 do diretório protegido é negado (Windows com 8.3 habilitado)', async t => {
  if (!IS_WIN) { t.skip('só Windows'); return; }
  const root = await fixture();
  await registerSession(root);
  // `protected` (9 caracteres) ganha alias curto; `dir /x` só o lista se o volume gera 8.3.
  const { execFileSync } = await import('node:child_process');
  const listing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/a:d', root], { encoding: 'latin1' });
  const short = /(\S+~\d)\s+protected\s*$/im.exec(listing)?.[1];
  if (!short) { t.skip('volume sem alias 8.3 para o diretório protegido'); return; }
  await expectDeny(root, root, patch(upd(`${short}/config.json`)), PROT);
  await expectAllow(root, root, patch(upd('protected-other/x.txt')));
});

// ---- política pura: limite de componentes e base da configuração ----

test('R5-09 checkPolicy: base da configuração separada da base da ação, por componentes', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sdlc-r509-pol-')));
  const verdict = (path: string, extra: Record<string, unknown> = {}) => checkPolicy({
    action: 'write', path, protectedPaths: ['protected', 'AGENTS.md'], projectRoot: base,
    baseDir: join(base, 'src'), ...extra,
  }).allowed;
  assert.equal(verdict('../protected/config.json'), false, 'relativo do cwd resolve até o protegido da raiz');
  assert.equal(verdict('protected/config.json'), true, 'src/protected não é o protegido da raiz');
  assert.equal(verdict('../protected-other/x'), true, 'protected-other não está dentro de protected');
  assert.equal(verdict('../protected2/x'), true);
  assert.equal(verdict(join(base, 'protected', 'x')), false);
  assert.equal(verdict(join(base, 'protected')), false, 'o próprio diretório protegido');
  assert.equal(verdict('../AGENTS.md'), false);
  // Protegido absoluto na configuração continua absoluto.
  assert.equal(verdict('../elsewhere/x', { protectedPaths: [join(base, 'elsewhere')] }), false);
  if (IS_WIN) {
    assert.equal(verdict('../PROTECTED/X'), false);
    assert.equal(verdict(join(base, 'protected2', 'x').toUpperCase()), true);
  }
});

// ---------- revisão independente C (A5/A6) ----------

test('R5-09 (revisão C/A5) o próprio nó .sdlc-codex/worktrees segue protegido; descendentes do worktree do dev seguem livres', async () => {
  const root = await fixture();
  const wt = join(root, '.sdlc-codex', 'worktrees', 'demanda');
  await mkdir(join(wt, 'src'), { recursive: true });
  await registerSession(root, wt);
  await expectDeny(root, wt, patch('*** Delete File: .sdlc-codex/worktrees'), /protegido/);
  await expectDeny(root, wt, patch('*** Add File: .sdlc-codex/worktrees'), /protegido/);
  await expectAllow(root, wt, patch(upd('src/a.ts')));
});

test('R5-09 (revisão C/A6) SDLC_CODEX_PROJECT_ROOT forjado (config de OUTRO projeto, sem protegidos) NÃO afrouxa a política', async () => {
  const root = await fixture();
  await registerSession(root, root);
  const forged = await mkdtemp(join(tmpdir(), 'sdlc-r509-forjado-'));
  const cfg = join(forged, 'config.json');
  await writeFile(cfg, JSON.stringify({
    schemaVersion: 1, projectId: '88888888-9999-4aaa-8bbb-cccccccccccc', projectName: 'F', prBase: 'main', checks: {}, models: {}, protectedPaths: ['nada'],
  }));
  await adopt(forged, cfg, true);
  const saved = process.env.SDLC_CODEX_PROJECT_ROOT;
  const restore = (): void => { if (saved === undefined) delete process.env.SDLC_CODEX_PROJECT_ROOT; else process.env.SDLC_CODEX_PROJECT_ROOT = saved; };
  process.env.SDLC_CODEX_PROJECT_ROOT = forged;
  try {
    await expectDeny(root, root, patch(upd('AGENTS.md')), /diverge|não confiável/);
  } finally { restore(); }
  // com a raiz REAL no env (mesmo projectId) a decisão continua a de sempre
  process.env.SDLC_CODEX_PROJECT_ROOT = root;
  try {
    await expectDeny(root, root, patch(upd('AGENTS.md')), /protegido/);
    await expectAllow(root, root, patch(upd('src/a.ts')));
  } finally { restore(); }
});

// ---------- verificação independente V1-3: a guarda do A6 não falha ABERTA ----------

test('R5-09 (verificação V1-3) raiz forjada no env NEGA também com runtime AUSENTE e com estado ILEGÍVEL', async () => {
  const forgedRoot = async (): Promise<string> => {
    const forged = await mkdtemp(join(tmpdir(), 'sdlc-r509-forjado-'));
    const cfg = join(forged, 'config.json');
    await writeFile(cfg, JSON.stringify({
      schemaVersion: 1, projectId: '88888888-9999-4aaa-8bbb-cccccccccccc', projectName: 'F', prBase: 'main', checks: {}, models: {}, protectedPaths: ['nada'],
    }));
    await adopt(forged, cfg, true);
    return forged;
  };
  const saved = process.env.SDLC_CODEX_PROJECT_ROOT;
  const restore = (): void => { if (saved === undefined) delete process.env.SDLC_CODEX_PROJECT_ROOT; else process.env.SDLC_CODEX_PROJECT_ROOT = saved; };

  // (a) runtime AUSENTE: projeto adotado, `up` ainda não executado (sem sessão registrada)
  const root = await fixture();
  process.env.SDLC_CODEX_PROJECT_ROOT = await forgedRoot();
  try { await expectDeny(root, root, patch(upd('AGENTS.md')), /diverge|não confiável|não verificável/); } finally { restore(); }

  // (b) estado ILEGÍVEL: EPERM permanente em runtime.json/runtime.backup.json (o código transitório que o produto reconhece)
  const root2 = await fixture();
  await registerSession(root2, root2);
  process.env.SDLC_CODEX_PROJECT_ROOT = await forgedRoot();
  const { promises: fsp } = await import('node:fs');
  const original = fsp.readFile;
  (fsp as { readFile: unknown }).readFile = (async (path: unknown, options: unknown) => {
    if (/runtime(\.backup)?\.json$/.test(String(path))) throw Object.assign(new Error('EPERM (injetado)'), { code: 'EPERM' });
    return original.call(fsp, path as never, options as never);
  }) as typeof fsp.readFile;
  try { await expectDeny(root2, root2, patch(upd('AGENTS.md')), /diverge|não confiável|não verificável|falha fechada/); }
  finally { (fsp as { readFile: unknown }).readFile = original; restore(); }
});
