import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

export interface ProcessResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; acceptedBeforeTimeout: boolean; }
export interface ProcessRunner {
  run(executable: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<ProcessResult>;
}

const execFileAsync = promisify(execFile);

/** Prioridade de extensões no Windows conforme PATHEXT/execução confiável. */
const WIN_EXT_PRIORITY: Array<[RegExp, number]> = [
  [/\.exe$/i, 0],
  [/\.cmd$/i, 1],
  [/\.bat$/i, 2],
  [/\.ps1$/i, 3],
];
const FALLBACK_PRIORITY = 4;

function extPriority(file: string): number {
  for (const [re, p] of WIN_EXT_PRIORITY) if (re.test(file)) return p;
  return FALLBACK_PRIORITY;
}

function mergeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  return env ? { ...process.env, ...env } : undefined;
}

/**
 * C04 — resolve o executável REAL no Windows:
 * - coleta TODOS os resultados do `where.exe` (não apenas o primeiro, que pode
 *   ser um shim sem extensão ou .ps1 via npm) e prefere .exe > .cmd > .bat > .ps1;
 * - aceita `env` opcional para testabilidade (fixture de diretório temporário na
 *   frente do PATH), sem tocar no PATH real;
 * - fora do Windows (ou quando o nome já contém separador de caminho / `where`
 *   falha), devolve o nome inalterado para o spawn decidir.
 */
export async function resolveExecutable(executable: string, env?: NodeJS.ProcessEnv): Promise<string> {
  if (/[\\/]/.test(executable)) return executable;
  if (process.platform !== 'win32') return executable;
  let stdout: string;
  try {
    // where.exe só procura extensões listadas no PATHEXT; o shim .ps1 do npm
    // fica invisível sem isso — adiciona .PS1 à consulta (não altera o PATH real).
    const whereEnv: NodeJS.ProcessEnv = { ...(mergeEnv(env) ?? process.env) };
    if (!/(^|;)\.PS1;/i.test(`;${whereEnv.PATHEXT ?? ''};`)) {
      whereEnv.PATHEXT = `.PS1;${whereEnv.PATHEXT ?? ''}`;
    }
    const r = await execFileAsync('where.exe', [executable], { windowsHide: true, timeout: 10_000, env: whereEnv });
    stdout = r.stdout;
  } catch { return executable; }
  const candidates = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!candidates.length) return executable;
  candidates.sort((a, b) => extPriority(a) - extPriority(b));
  return candidates[0];
}

/**
 * Resolve o binário nativo que o entrypoint npm do Codex executa. O Herdr
 * 0.7.5 inicia agentes no Windows com `Start-Process -FilePath codex`; esse
 * mecanismo não consegue executar o shim codex.cmd e produz `%1 não é um
 * aplicativo Win32 válido`. O diretório deste executável deve preceder o shim
 * npm no PATH da aba.
 */
export async function resolveNativeCodexExecutable(executable = 'codex', env?: NodeJS.ProcessEnv): Promise<string> {
  const resolved = await resolveExecutable(executable, env);
  if (process.platform === 'win32' && /\.exe$/i.test(resolved)) return resolved;

  const entrypoint = await resolveNodeEntrypoint(resolved);
  if (entrypoint.kind !== 'node') {
    throw new Error(`Codex nativo indisponível: ${resolved} não é executável nem shim npm reconhecido`);
  }

  const target = process.platform === 'win32'
    ? process.arch === 'arm64' ? ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe'] : ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe']
    : process.platform === 'darwin'
      ? process.arch === 'arm64' ? ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin', 'codex'] : ['@openai/codex-darwin-x64', 'x86_64-apple-darwin', 'codex']
      : process.arch === 'arm64' ? ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl', 'codex'] : ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl', 'codex'];
  try {
    const requireFromCodex = createRequire(entrypoint.script);
    const packageJson = requireFromCodex.resolve(`${target[0]}/package.json`);
    const native = join(dirname(packageJson), 'vendor', target[1], 'bin', target[2]);
    await access(native);
    return native;
  } catch (error) {
    throw new Error(`Codex nativo indisponível para ${process.platform}/${process.arch}; reinstale @openai/codex (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * C04 — citação VERIFICADA para cmd.exe /d /s /c.
 *
 * Subconjunto suportado (documentado de propósito):
 * - CADA argumento é envolvido em aspas duplas com o algoritmo canônico de
 *   citação MSVC (CommandLineToArgvW): aspas internas viram `""` e TODO
 *   backslash que as PRECEDE é duplicado; no FIM do argumento, backslashes
 *   consecutivos são duplicados antes da aspa de fechamento. Sem isso, um
 *   argumento terminando em `\` (caminho de diretório Windows) literaliza a
 *   aspa de fechamento e FUNDE o argumento seguinte ao anterior — e `\"`
 *   perde a barra. Revisão cruzada: contraexemplo confirmado e coberto por
 *   teste (process-windows.test.ts).
 * - A linha inteira (executável + argumentos) é envolvida em UM par externo de
 *   aspas e passada como UM único argumento com `windowsVerbatimArguments`:
 *   o cmd /s /c remove o primeiro e o último caractere aspas e executa o miolo
 *   token a token. Sem o par externo (ou sem verbatim, que desativa a recitação
 *   do libuv), o cmd quebra o comando no primeiro espaço de caminho — é a
 *   reprodução concreta da falha original deste achado.
 * - Argumentos contendo CR ou LF são SEMPRE rejeitados (evitam injeção de
 *   segundo comando na linha) — a falha acontece antes do spawn.
 * - Dentro de aspas, os metacaracteres & | < > ^ são literais; `!` é literal
 *   porque a expansão retardada vem desabilitada por padrão. ATENÇÃO: o cmd
 *   expande `%NOME%` mesmo entre aspas e re-parseia '%' solto — por isso o
 *   runner se recusa a transportar argumentos com '%' por esta rota
 *   (fail-closed; ver NodeProcessRunner.run): dados com percentual exigem o
 *   transporte nativo (sem shell) — ver CodexTransport, que passa o corpo
 *   como argumento estruturado, e a resolução de shim npm para entrypoint
 *   Node (resolveNodeEntrypoint), que contorna o cmd inteiramente.
 */
export function quoteForCmd(arg: string): string {
  if (/[\r\n]/.test(arg)) {
    throw new Error('argumento contém CR/LF; rejeitado pelo subconjunto seguro do cmd');
  }
  // Citação canônica MSVC: percorre o argumento; backslash seguido de aspa é
  // duplicado (2n barras + ""); sequência final de backslashes é duplicada
  // antes da aspa de fechamento.
  let out = '';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2) + '""';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2);
  return `"${out}"`;
}

/**
 * Monta a linha única exigida por `cmd /d /s /c`: UM par externo de aspas
 * envolvendo executável citado + argumentos citados (forma canônica
 * documentada do cmd para caminhos/argumentos com espaço).
 */
function buildCmdLine(executable: string, args: string[]): string {
  const inner = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(' ');
  return `"${inner}"`;
}

function isWindowsScript(resolved: string): 'ps1' | 'cmd' | null {
  if (process.platform !== 'win32') return null;
  if (/\.ps1$/i.test(resolved)) return 'ps1';
  if (/\.(cmd|bat)$/i.test(resolved)) return 'cmd';
  return null;
}

/**
 * R4-10 — resolução de shim npm para o entrypoint Node REAL.
 *
 * O shim .cmd gerado pelo npm encaminha `%*` para um script .js via node.
 * Passar a mensagem por esse shim significa passar pelo cmd.exe, que EXPANDE
 * `%VAR%` mesmo entre aspas (é exatamente a corrupção do marcador
 * `%SDLC_REVIEW_MARKER%` observada na revisão). A rota segura é detectar o
 * padrão do shim e executar `node <script> ...args` diretamente
 * (shell:false): cada argumento chega como dado, incluindo %VAR%, !, & e
 * CR/LF.
 *
 * SUBCONJUNTO SUPORTADO (declarado de propósito; nada genérico inventado):
 * - .cmd/.bat no formato de shim do npm, clássico ou moderno, cuja linha de
 *   invocação seja `"<caminho>.js" %*` com node como interpretador
 *   (`SET "_prog=..."`, `IF EXIST "%dp0%\node.exe"` ou `node` no PATH);
 * - .ps1 no formato de shim do npm cuja linha de invocação seja
 *   `node "<caminho>.js" $args`.
 * Qualquer outro conteúdo devolve `unsupported` e o runner cai na rota com
 * shell documentada (com suas limitações declaradas) — nunca prometemos
 * fidelidade de argv para wrapper arbitrário sem prova.
 */
export type NodeEntrypoint =
  | { kind: 'node'; interpreter: string; script: string }
  | { kind: 'unsupported' };

export async function resolveNodeEntrypoint(resolved: string): Promise<NodeEntrypoint> {
  if (process.platform !== 'win32') return { kind: 'unsupported' };
  const scriptKind = isWindowsScript(resolved);
  if (!scriptKind) return { kind: 'unsupported' };
  let content: string;
  try {
    content = await readFile(resolved, 'utf8');
  } catch {
    return { kind: 'unsupported' };
  }
  const dir = dirname(resolved);
  // Substitui os tokens de diretório do shim pelo diretório real. Reposição
  // por função para não interpretar `$` do path como grupo de regex.
  const expand = (p: string): string => p
    .replace(/^%~dp0[\\/]?/i, () => `${dir}\\`)
    .replace(/^%dp0%[\\/]?/i, () => `${dir}\\`)
    .replace(/^\$basedir[\\/]/i, () => `${dir}\\`);

  let scriptRaw: string | undefined;
  if (scriptKind === 'cmd') {
    // Última linha de invocação: "<algo>.js" %* (shim clássico tem duas,
    // IF/ELSE, com o mesmo script — a primeira basta).
    const invoke = /"([^"\r\n]*?\.js)"\s+%\*/i.exec(content);
    scriptRaw = invoke?.[1];
  } else {
    const invoke = /(?:^|\s)node\s+"([^"\r\n]*?\.js)"\s+\$args\b/i.exec(content);
    scriptRaw = invoke?.[1];
  }
  if (!scriptRaw) return { kind: 'unsupported' };
  const script = expand(scriptRaw.trim());
  try {
    await readFile(script);
  } catch {
    // Script referenciado não existe: não é o padrão comprovado — sem atalho.
    return { kind: 'unsupported' };
  }
  // Interpretador com a semântica real do shim (`IF EXIST ...node.exe`):
  // node.exe ao lado do shim só é usado se EXISTIR; caso contrário cai no
  // `node` do PATH. Reproduzir isso evita ENOENT quando o shim aponta para um
  // node.exe ausente (instalação npm típica).
  let candidate = 'node';
  const prog = /SET\s+"_prog=([^"]+)"/i.exec(content);
  if (prog) candidate = expand(prog[1].trim());
  else if (scriptKind === 'cmd' && /"%~dp0\\node\.exe"/i.test(content)) candidate = expand('%~dp0\\node.exe');
  let interpreter = 'node';
  if (!/^node$/i.test(candidate)) {
    try {
      await readFile(candidate);
      interpreter = candidate;
    } catch {
      interpreter = 'node';
    }
  }
  return { kind: 'node', interpreter, script };
}

/**
 * Encerramento de árvore no Windows com identidade controlada: só mata o
 * processo enquanto o handle `child` ainda referencia um processo VIVO
 * (exitCode/signalCode ainda nulos). `taskkill /t /f` atinge pai e filhos em
 * UMA chamada — ele é o ÚNICO mecanismo usado aqui: disparar `child.kill()`
 * junto (ou antes) faz o pai morrer antes do taskkill enumerar a árvore, que
 * então responde "processo não encontrado" e ORFA os filhos (reproduzido
 * empiricamente). O alvo é exclusivamente `child.pid`, criado por este
 * runner; nenhum processo externo é tocado.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return; // já morreu: identidade não é mais nossa
  if (process.platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }).unref();
    } catch {
      child.kill(); // taskkill indisponível: última medida sobre o pai apenas
    }
    return;
  }
  child.kill();
}

export class NodeProcessRunner implements ProcessRunner {
  /**
   * C04 — diferencia explicitamente três desfechos:
   * - FALHA DE INICIALIZAÇÃO: o spawn jura (ENOENT etc.) — a Promise REJEITA;
   *   isso NÃO é resposta negativa do comando externo e os chamadores devem
   *   tratar como indisponibilidade do executável (ver CodexTransport);
   * - TIMEOUT: `timedOut: true` (processo morto; em Windows mata a árvore com
   *   taskkill para não sobrar órfão);
   * - RESPOSTA OPERACIONAL: exit code + stdout/stderr separados e decodificados
   *   uma única vez em UTF-8 (chunks concatenados antes de decodificar).
   */
  run(executable: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
    return (async () => {
      const env = mergeEnv(options.env);
      const resolved = await resolveExecutable(executable, env);
      const kind = isWindowsScript(resolved);
      // R4-10 — mapa de rotas efetivas SUPORTADAS (documentado, sem promessa
      // genérica): .exe nativo e entrypoint Node direto têm fidelidade total
      // de argv; shim npm (.cmd/.bat/.ps1) resolvido para entrypoint Node vai
      // por `node <script>` sem shell; demais .cmd/.bat usam o subconjunto
      // citado de cmd /d /s /c (ver quoteForCmd: %VAR% expande — limitação
      // declarada); demais .ps1 usam powershell -File.
      const nodeEntry = kind ? await resolveNodeEntrypoint(resolved) : { kind: 'unsupported' as const };
      return await new Promise<ProcessResult>((resolve, reject) => {
        let child: ChildProcess;
        try {
          if (!kind || nodeEntry.kind === 'node') {
            // Executável nativo OU entrypoint Node resolvido do shim: sem
            // shell, cada argumento é preservado como dado (mensagem inteira
            // como UM argumento; %VAR% literal; CR/LF permitidos).
            const file = nodeEntry.kind === 'node' ? nodeEntry.interpreter : resolved;
            const argv = nodeEntry.kind === 'node' ? [nodeEntry.script, ...args] : args;
            child = spawn(file, argv, { cwd: options.cwd, env, windowsHide: true, shell: false });
          } else if (kind === 'ps1') {
            // Shim PowerShell sem padrão npm comprovado: -File executa o
            // script; argumentos seguem como argv separados do powershell,
            // sem citação de shell.
            child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args],
              { cwd: options.cwd, env, windowsHide: true, shell: false });
          } else {
            // .cmd/.bat sem padrão de shim npm comprovado: cmd /d /s /c com a
            // linha canônica citada (ver buildCmdLine). windowsVerbatimArguments
            // desativa a recitação do libuv: o cmd recebe EXATAMENTE a linha
            // montada aqui.
            // FAIL-CLOSED sobre '%': o cmd expande %VAR% mesmo entre aspas e
            // ainda re-parseia (um '%' solto pode ser consumido ao atravessar
            // wrappers — reproduzido com `call x.cmd %*`). Esta rota se recusa
            // a transportar '%' em vez de corromper o dado em silêncio; dados
            // assim exigem a rota sem shell (entrypoint Node/shim resolvido).
            if (args.some(a => a.includes('%'))) {
              throw new Error('argumento contém "%": rota cmd citada não preserva percentual (expansão/re-parse do cmd); use executável nativo ou shim resolvido para entrypoint Node');
            }
            const line = buildCmdLine(resolved, args);
            child = spawn('cmd.exe', ['/d', '/s', '/c', line], { cwd: options.cwd, env, windowsHide: true, shell: false, windowsVerbatimArguments: true });
          }
        } catch (error) { reject(error); return; }
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout?.on('data', chunk => { outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); });
        child.stderr?.on('data', chunk => { errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); });
        let timedOut = false;
        const timer = options.timeoutMs
          ? setTimeout(() => {
            timedOut = true;
            // Árvore INTEIRA, na ordem certa, só se o processo ainda é nosso.
            killProcessTree(child);
          }, options.timeoutMs)
          : undefined;
        child.once('error', error => { if (timer) clearTimeout(timer); reject(error); });
        child.once('close', exitCode => {
          if (timer) clearTimeout(timer);
          // R4-10/M2-F2 — chunks concatenados ANTES de decodificar: UTF-8
          // fragmentado (multibyte cortado entre chunks) não corrompe.
          const stdout = Buffer.concat(outChunks).toString('utf8');
          const stderr = Buffer.concat(errChunks).toString('utf8');
          // Sem heurística solta de "aceitação": este campo é apenas uma dica
          // bruta do runner; o transporte (CodexTransport) só confirma
          // aceitação via parseQueueReceipt, no formato real do receipt.
          resolve({ exitCode, stdout, stderr, timedOut, acceptedBeforeTimeout: false });
        });
      });
    })();
  }
}

export class FakeProcessRunner implements ProcessRunner {
  calls: Array<{ executable: string; args: string[]; cwd?: string }> = [];
  constructor(private readonly handler: (executable: string, args: string[]) => ProcessResult | Promise<ProcessResult>) {}
  async run(executable: string, args: string[], options: { cwd?: string } = {}): Promise<ProcessResult> {
    this.calls.push({ executable, args: [...args], cwd: options.cwd });
    return this.handler(executable, args);
  }
}
