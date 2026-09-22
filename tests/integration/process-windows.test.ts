import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, copyFile, readFile, realpath, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { NodeProcessRunner, resolveExecutable, resolveNativeCodexExecutable, resolveNodeEntrypoint, quoteForCmd } from '../../src/adapters/process.js';

const WIN = process.platform === 'win32';

/** Nenhuma remoção recursiva sem confirmar que o alvo é temporário deste teste. */
async function safeRm(root: string): Promise<void> {
  const target = resolve(root);
  assert.ok(
    target.startsWith(resolve(tmpdir())) && basename(target).startsWith('sdlc-m2-'),
    `recusa remover caminho fora do temporário do teste: ${target}`,
  );
  await rm(target, { recursive: true, force: true });
}

// Existência de PID por sinal 0 (funciona no Windows e POSIX; ESRCH = morto).
// Não depende de texto localizado de ferramentas externas (tasklist em pt-BR
// não contém "No tasks are running" — checagem por texto quebrou na prática).
async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await pidAlive(pid))) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// Shim .cmd/.bat no estilo clássico do npm: encaminha %* (tokens citados
// intactos) para um script Node que imprime argv como JSON — assim cada
// argumento é verificado como dado.
function shimFiles(): Record<string, string> {
  const node = process.execPath.replace(/"/g, '""');
  const shim = `@echo off\r\n"${node}" "%~dp0echoargs.js" %*\r\n`;
  return {
    'echoargs.js': 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    'echoargs.cmd': shim,
    'echoargs.bat': shim,
  };
}

// Shim .cmd no formato MODERNO gerado pelo npm (mesmo corpo dos shims reais
// como codex.cmd): IF EXIST "%dp0%\node.exe" + SET "_prog=..." + linha final
// endLocal & ... & "%_prog%" "%dp0%\<script>.js" %*.
function modernNpmShim(script = 'echoargs.js'): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    '',
  ].join('\r\n');
}

// Shim .cmd clássico (npm antigo): IF/ELSE com "%~dp0\node.exe" direto.
function classicNpmShim(script = 'echoargs.js'): string {
  return [
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${script}" %*`,
    ') ELSE (',
    '  @SETLOCAL',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${script}" %*`,
    ')',
    '',
  ].join('\r\n');
}

async function fixtureWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-m2-tools-'));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

function parseArgv(stdout: string): string[] {
  return JSON.parse(stdout) as string[];
}

// C04: coleta TODOS os resultados do where e prefere .exe > .cmd > .bat > .ps1.
test('resolveExecutable prioriza exe > cmd > bat > ps1 (fixture no PATH)', { skip: !WIN }, async (t) => {
  const env = (dir: string) => ({ ...process.env, PATH: `${dir};${process.env.PATH ?? ''}` });
  const all = await fixtureWith({ ...shimFiles(), 'tool.cmd': '@exit /b 0\r\n', 'tool.bat': '@exit /b 0\r\n', 'tool.ps1': "exit 0\n" });
  t.after(() => safeRm(all));
  await copyFile(process.execPath, join(all, 'tool.exe'));
  assert.match(await resolveExecutable('tool', env(all)), /\.exe$/i);
  const cmdBat = await fixtureWith({ 'tool.cmd': '@exit /b 0\r\n', 'tool.bat': '@exit /b 0\r\n', 'tool.ps1': "exit 0\n" });
  t.after(() => safeRm(cmdBat));
  assert.match(await resolveExecutable('tool', env(cmdBat)), /\.cmd$/i);
  const batPs1 = await fixtureWith({ 'tool.bat': '@exit /b 0\r\n', 'tool.ps1': "exit 0\n" });
  t.after(() => safeRm(batPs1));
  assert.match(await resolveExecutable('tool', env(batPs1)), /\.bat$/i);
  const ps1Only = await fixtureWith({ 'tool.ps1': "exit 0\n" });
  t.after(() => safeRm(ps1Only));
  assert.match(await resolveExecutable('tool', env(ps1Only)), /\.ps1$/i);
});

test('resolveNativeCodexExecutable encontra o binário Win32 atrás do shim npm', { skip: !WIN }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-m2-codex-native-'));
  t.after(() => safeRm(root));
  const codexRoot = join(root, 'node_modules', '@openai', 'codex');
  const binDir = join(codexRoot, 'bin');
  const nativeDir = join(codexRoot, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(nativeDir, { recursive: true });
  await writeFile(join(root, 'codex.cmd'), modernNpmShim('node_modules\\@openai\\codex\\bin\\codex.js'));
  await writeFile(join(binDir, 'codex.js'), '// fixture entrypoint\n');
  await writeFile(join(codexRoot, 'node_modules', '@openai', 'codex-win32-x64', 'package.json'), JSON.stringify({ name: '@openai/codex-win32-x64', version: '0.0.0' }));
  await writeFile(join(nativeDir, 'codex.exe'), 'fixture');

  const found = await resolveNativeCodexExecutable('codex', { ...process.env, PATH: `${root};${process.env.PATH ?? ''}` });
  assert.equal(await realpath(found), await realpath(join(nativeDir, 'codex.exe')));
});

// R4-10/C04: rota efetiva .cmd — caminho com espaços e Unicode + argumentos
// adversos preservados como dado. O shim simples é resolvido para o
// entrypoint Node e executado SEM shell: %VAR% chega LITERAL (o cmd.exe
// expandiria mesmo entre aspas — era exatamente a corrupção do
// %SDLC_REVIEW_MARKER%) e CR/LF é dado comum.
test('.cmd preserva espaços, unicode, aspas, metacaracteres, %VAR% literal e CR/LF', { skip: !WIN }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-m2-caminho com espa\xE7o e \xE1-'));
  t.after(() => safeRm(dir));
  for (const [name, content] of Object.entries(shimFiles())) await writeFile(join(dir, name), content);
  const runner = new NodeProcessRunner();
  const args = [
    '',
    'aspas "duplas" e \'simples\'',
    '100%',
    // R4-10: %VAR% definida no env deve chegar LITERAL — sem expansão pelo cmd.
    '%SDLC_M2_MARK%',
    '%SDLC_M2_INDEFINIDA%',
    'quebra\r\nde linha',
    'a&b',
    'a|b',
    'a<b',
    'c>d',
    'caret^x',
    'dollar$x',
    'back`tick',
    'excl!am',
    'paren(tese)',
    'caminho com espa\xE7o \xE3\xF5 \u{1F680}',
    // Revisão cruzada: trailing backslash e aspa precedida de barra — sem a
    // citação canônica MSVC o cmd literaliza a aspa de fechamento e funde
    // tokens (dado corrompido).
    'C:\\repos\\projeto\\',
    'C:\\temp\\"aspas entre barras"\\fim',
  ];
  const r = await runner.run(join(dir, 'echoargs.cmd'), args, {
    timeoutMs: 20_000,
    env: { ...process.env, SDLC_M2_MARK: 'VALOR-QUE-NAO-PODE-VAZAR' },
  });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(parseArgv(r.stdout), args);
});

// C04/R4-10: rota efetiva .bat (shim resolvido para entrypoint Node).
test('.bat preserva cada argumento como dado', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith(shimFiles());
  t.after(() => safeRm(dir));
  const runner = new NodeProcessRunner();
  const args = ['um', 'dois com espa\xE7o', 'tr\xEAs'];
  const r = await runner.run(join(dir, 'echoargs.bat'), args, { timeoutMs: 20_000 });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(parseArgv(r.stdout), args);
});

// C04: rota efetiva .ps1 via powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
// (fixture NÃO é shim de node — rota PowerShell documentada).
test('.ps1 executa via powershell -File preservando cada argumento', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith({ 'echoargs.ps1': "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n[Console]::Out.Write(($args | ConvertTo-Json -Compress))\n" });
  t.after(() => safeRm(dir));
  const runner = new NodeProcessRunner();
  const args = ['um', 'com espa\xE7o e "\xE1spas"', '100%', 'a&b|x', '\xE3\xF5 \u{1F680}'];
  const r = await runner.run(join(dir, 'echoargs.ps1'), args, { timeoutMs: 30_000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout) as string[], args);
});

// R4-10: shim resolvido para entrypoint Node NÃO tem a limitação do cmd —
// CR/LF chega como dado. A REJEIÇÃO de CR/LF só vale para a rota de fallback
// cmd /d /s /c (wrapper que não comprovou o padrão de shim do npm).
test('CR/LF: preservado via entrypoint Node; rejeitado no fallback cmd citado', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith({
    ...shimFiles(),
    // Wrapper NÃO-shim (sem linha "<script>.js" %*"): cai no fallback citado.
    'plain.cmd': '@echo off\r\necho done\r\n',
  });
  t.after(() => safeRm(dir));
  const runner = new NodeProcessRunner();
  // Rota Node: CR/LF literal preservado.
  const ok = await runner.run(join(dir, 'echoargs.cmd'), ['linha1\nlinha2'], { timeoutMs: 5000 });
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.deepEqual(parseArgv(ok.stdout), ['linha1\nlinha2']);
  // Fallback cmd: CR/LF rejeitado antes do spawn (subconjunto seguro).
  await assert.rejects(() => runner.run(join(dir, 'plain.cmd'), ['linha1\nlinha2'], { timeoutMs: 5000 }), /CR\/LF/);
  assert.throws(() => quoteForCmd('a\rb'), /CR\/LF/);
});

// C04/R4-10: timeout mata o .cmd (e a árvore) e marca timedOut — distinto de resposta operacional.
test('timeout em .cmd marca timedOut', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith({ 'slow.cmd': '@echo off\r\nping -n 4 127.0.0.1 >nul\r\necho late\r\n' });
  t.after(() => safeRm(dir));
  const runner = new NodeProcessRunner();
  const r = await runner.run(join(dir, 'slow.cmd'), [], { timeoutMs: 600 });
  assert.equal(r.timedOut, true);
});

// C04: FALHA DE INICIALIZAÇÃO (ENOENT) rejeita — não é "resposta negativa" do comando externo.
test('executável inexistente falha no spawn (ENOENT), sem exit code operacional', async () => {
  const runner = new NodeProcessRunner();
  await assert.rejects(
    () => runner.run('sdlc-b-definitivamente-inexistente-xyz', ['x'], { timeoutMs: 5000 }),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});

// ---------------------------------------------------------------------------
// M2-F1 (R4-10) — transporte literal de argv por shim npm real
// ---------------------------------------------------------------------------

// Shim do npm MODERNO (mesmo corpo dos shims reais como codex.cmd): o runner
// deve resolver o entrypoint Node e executar SEM shell — o cmd.exe nunca vê a
// mensagem, logo %VAR% não é expandido (a corrupção original do achado).
test('R4-10: shim npm moderno por PATH — %VAR% literal, CRLF e conteúdo semelhante a comando', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith({
    'echoargs.js': 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    'toolz.cmd': modernNpmShim(),
  });
  t.after(() => safeRm(dir));
  const runner = new NodeProcessRunner();
  const message = [
    'resposta com %SDLC_REVIEW_MARKER% literal',
    'e %SDLC_M2_ENV% também',
    'quebra\r\nde mensagem',
    'chamada falsa: cmd /c rd /s /q C:\\',
    'a&b|c<d>e^f!g(h)',
    '100% e aspas "duplas" e barra final\\',
    'vazio', '', 'acentuação ãõç \u{1F680}',
  ];
  const r = await runner.run('toolz', message, {
    timeoutMs: 20_000,
    env: {
      ...process.env,
      PATH: `${dir};${process.env.PATH ?? ''}`,
      SDLC_REVIEW_MARKER: 'MARCADOR-EXPANDIDO-NAO-PODE-VIR',
      SDLC_M2_ENV: 'OUTRO-VALOR-EXPANDIDO',
    },
  });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(parseArgv(r.stdout), message);
});

// Shim do npm CLÁSSICO (npm antigo, IF/ELSE com "%~dp0\node.exe"): node.exe
// NÃO existe ao lado do fixture, então o interpretador correto é o `node` do
// PATH (semântica real do `IF EXIST`).
test('R4-10: shim npm clássico resolve entrypoint com fallback para node do PATH', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith({
    'echoargs.js': 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    'toolc.cmd': classicNpmShim(),
  });
  t.after(() => safeRm(dir));
  const entry = await resolveNodeEntrypoint(join(dir, 'toolc.cmd'));
  assert.equal(entry.kind, 'node');
  if (entry.kind === 'node') {
    assert.equal(entry.interpreter, 'node');
    assert.equal(entry.script, join(dir, 'echoargs.js'));
  }
  const runner = new NodeProcessRunner();
  const r = await runner.run(join(dir, 'toolc.cmd'), ['%VAR_QUALQUER%', 'com espaço'], { timeoutMs: 20_000 });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(parseArgv(r.stdout), ['%VAR_QUALQUER%', 'com espaço']);
});

// Shim .ps1 do npm (`node "$basedir/<script>.js" $args`): idem, sem shell.
test('R4-10: shim npm .ps1 resolve entrypoint Node', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith({
    'echoargs.js': 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    'toolp.ps1': '$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\n& node "$basedir/echoargs.js" $args\nexit $LASTEXITCODE\n',
  });
  t.after(() => safeRm(dir));
  const entry = await resolveNodeEntrypoint(join(dir, 'toolp.ps1'));
  assert.equal(entry.kind, 'node');
  const runner = new NodeProcessRunner();
  const r = await runner.run(join(dir, 'toolp.ps1'), ['%PS_VAR%', 'dois'], { timeoutMs: 20_000 });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(parseArgv(r.stdout), ['%PS_VAR%', 'dois']);
});

// Wrapper arbitrário SEM o padrão comprovado: declarado como unsupported e
// executado pela rota com shell DOCUMENTADA (sem promessa de fidelidade).
test('R4-10: wrapper sem padrão npm é unsupported (sem suporte genérico inventado)', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith({ 'plain.cmd': '@echo off\r\necho ok\r\n' });
  t.after(() => safeRm(dir));
  assert.deepEqual(await resolveNodeEntrypoint(join(dir, 'plain.cmd')), { kind: 'unsupported' });
  // A rota fallback continua funcional para conteúdo simples (subconjunto).
  const r = await new NodeProcessRunner().run(join(dir, 'plain.cmd'), [], { timeoutMs: 10_000 });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /ok/);
});

// Wrapper NÃO-shim que delega a UM shim (dois níveis de cmd): exercita a rota
// de fallback com citação canônica ponta a ponta. Argumentos com '%' são
// REJEITADOS nesta rota (fail-closed): o cmd expande %VAR% mesmo entre aspas
// e o re-parse do `call %*` consome '%' solto (reproduzido: '100%' virou
// '100'). Dados com percentual exigem a rota sem shell (shim resolvido).
test('R4-10: fallback cmd citado preserva tokens simples através de wrapper de dois níveis; rejeita %', { skip: !WIN }, async (t) => {
  const dir = await fixtureWith({
    ...shimFiles(),
    'wrap.cmd': '@echo off\r\ncall "%~dp0echoargs.cmd" %*\r\n',
  });
  t.after(() => safeRm(dir));
  const runner = new NodeProcessRunner();
  assert.deepEqual(await resolveNodeEntrypoint(join(dir, 'wrap.cmd')), { kind: 'unsupported' });
  const args = ['um', 'dois com espaço', 'a&b', 'tr\xEAs', 'fim\\'];
  const r = await runner.run(join(dir, 'wrap.cmd'), args, { timeoutMs: 20_000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(parseArgv(r.stdout), args);
  await assert.rejects(
    () => runner.run(join(dir, 'wrap.cmd'), ['100%'], { timeoutMs: 5000 }),
    /percentual/,
  );
});

// ---------------------------------------------------------------------------
// M2-F2 — encerramento de árvore no Windows com identidade controlada
// ---------------------------------------------------------------------------

// O timeout deve matar o DESCENDENTE (node neto do .cmd) e NÃO tocar em
// processo algum que não pertença à árvore criada pelo runner.
test('M2-F2: timeout mata descendente do wrapper e poupa processo externo', { skip: !WIN }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-m2-tree-'));
  t.after(() => safeRm(dir));
  const gpidFile = join(dir, 'grandchild.pid');
  const node = process.execPath.replace(/"/g, '""');
  await writeFile(
    join(dir, 'spawn-grandchild.cmd'),
    // Filho escreve o PRÓPRIO pid em arquivo e dorme; o cmd espera o filho.
    `@echo off\r\n"${node}" -e "require('fs').writeFileSync(process.env.M2_GPID_FILE,String(process.pid));setTimeout(function(){},60000)"\r\n`,
  );
  // Canário: processo NOSSO, mas fora da árvore do runner — não pode morrer.
  const canary = execFile(process.execPath, ['-e', 'setTimeout(function(){},60000)'], { windowsHide: true }, () => undefined);
  try {
    const runner = new NodeProcessRunner();
    const r = await runner.run(join(dir, 'spawn-grandchild.cmd'), [], {
      timeoutMs: 1500,
      env: { ...process.env, M2_GPID_FILE: gpidFile },
    });
    assert.equal(r.timedOut, true, 'timeout deve ser marcado');
    // Espera o neto gravar o pid (pode acontecer antes ou depois do kill).
    const start = Date.now();
    let gpid: number | undefined;
    while (Date.now() - start < 10_000) {
      try {
        const raw = (await readFile(gpidFile, 'utf8')).trim();
        if (raw) { gpid = Number(raw); break; }
      } catch { /* ainda não gravou */ }
      await new Promise(res => setTimeout(res, 100));
    }
    assert.ok(gpid, 'neto deveria ter gravado seu pid');
    assert.equal(await waitDead(gpid as number), true, 'descendente da árvore do runner deve estar morto');
    // Identidade controlada: o canário NÃO pertencia à árvore e segue vivo.
    assert.equal(canary.pid !== undefined, true);
    assert.equal(await pidAlive(canary.pid as number), true, 'processo externo não pode ser morto');
  } finally {
    canary.kill();
  }
});
