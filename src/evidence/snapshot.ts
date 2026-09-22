import { createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { CodeSnapshot } from '../contracts.js';
import type { ProcessRunner } from '../adapters/process.js';

/**
 * M2-F1/M2-F2 (R5-04, R5-06) — snapshot verificável do código, com falha FECHADA.
 *
 * Contrato: sucesso devolve commit + fingerprint + inventário; qualquer falha de captura
 * é um resultado explícito com código (nunca "ausência opcional" nem snapshot parcial).
 * O fingerprint cobre o estado da ÁRVORE relativo ao HEAD: hash de `git diff HEAD` e, para CADA
 * caminho que difere do HEAD (modificado, staged, removido, untracked — arquivo a arquivo,
 * `-uall`), o status XY, o tipo e o hash dos BYTES (symlink: texto do alvo). Inventário ordenado
 * por bytes UTF-8 do caminho e serializado em JSON (sem ambiguidade de delimitador). O commit NÃO
 * entra no fingerprint (fica em `snapshot.commit`, comparado à parte): o fechamento compara a
 * árvore de código entre dois commits distintos.
 *
 * Formato do Git confirmado em git 2.51.1.windows.1 (docs/validation/round-5/m2-git-format-probe.log):
 * `status --porcelain=v1 -z --untracked-files=all --no-renames` emite `XY<espaço>caminho\0`;
 * `--no-renames` elimina R/C (senão vêm `novo\0antigo\0`, contando o caminho antigo como registro extra).
 *
 * LIMITES declarados (sem promessa de atomicidade do filesystem):
 * - Não há snapshot atômico: a captura relê HEAD e o inventário e confere lstat (tamanho/mtime/ino)
 *   dos arquivos; diferença => 'unstable'. Escrita que preserve tamanho E mtime entre as leituras
 *   (ou uma troca de arquivo por symlink entre lstat e leitura — TOCTOU) não é detectada.
 * - `cwd` deve ser a RAIZ do worktree (porcelain usa caminhos relativos à raiz; excludeRoots
 *   e pathspec são relativos ao cwd). Um SUBDIRETÓRIO não falha: o pathspec `.` limita o escopo e a captura
 *   devolve um snapshot VÁLIDO do subconjunto (cego ao resto do repositório — revisão B/B8). A CLI nunca passa
 *   subdiretório (checkoutCwd = worktree ?? raiz do projeto).
 * - Repositório aninhado/submódulo (`?? nested/`) entra só como tipo 'directory' (existência):
 *   o conteúdo pertence a outro repositório Git. Índice sem efeito no worktree e no status
 *   (mesmo XY) não é coberto.
 * - ProcessResult não expõe truncamento: status truncado é detectado pela falta do NUL final;
 *   diff truncado só pela falta do '\n' final (heurística, não prova).
 * - Custo: um `git status -uall` + leitura integral (em stream) de cada arquivo relevante, em série.
 */

export type SnapshotFailureCode =
  | 'head-failed' | 'status-failed' | 'diff-failed' | 'read-failed' | 'timeout'
  | 'invalid-output' | 'unstable' | 'empty-commit' | 'outside-scope';

export class SnapshotCaptureError extends Error {
  constructor(readonly code: SnapshotFailureCode, message: string, readonly path?: string) {
    super(message);
    this.name = 'SnapshotCaptureError';
  }
}

export type SnapshotEntryType = 'file' | 'symlink' | 'directory' | 'deleted';
export interface SnapshotEntry {
  /** caminho relativo ao cwd, como reportado pelo Git (separador '/'). */
  path: string;
  /** status XY do porcelain v1 (ex.: ' M', 'A ', '??'). */
  status: string;
  type: SnapshotEntryType;
  /** sha256 hex dos bytes (file) ou do texto do alvo (symlink); '' para directory/deleted. */
  hash: string;
}

export interface SnapshotOptions {
  /** timeout de CADA chamada ao Git (default 60 s). */
  timeoutMs?: number;
  /** caminhos EXTRAS excluídos (diretórios ou arquivos exatos), relativos ao cwd, sem '..'; componentes
   *  normalizados ('./a//b\\c' => 'a/b/c'); case-insensitive no win32. `.sdlc-codex` é SEMPRE excluído. */
  excludeRoots?: string[];
}

export type SnapshotResult =
  | { ok: true; snapshot: CodeSnapshot; inventory: SnapshotEntry[] }
  | { ok: false; code: SnapshotFailureCode; message: string; path?: string };

const DEFAULT_TIMEOUT_MS = 60_000;
/** Único diretório operacional excluído por padrão — nada de `.log`, `logs/`, `dist/`, `node_modules/`
 *  por padrão de nome: o que o .gitignore do projeto ignora o próprio Git já não lista. */
const DEFAULT_EXCLUDE_ROOTS = ['.sdlc-codex'];
// Sem GIT_OPTIONAL_LOCKS=0 o `git status` reescreve .git/index (observado na sonda) — incompatível com 'git-readonly'.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const errCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'desconhecido';

interface Listed { xy: string; path: string }

function normalizeRoots(extra: string[]): string[] {
  return [...DEFAULT_EXCLUDE_ROOTS, ...extra].map(root => {
    const parts = root.split(/[\\/]+/).filter(p => p !== '' && p !== '.');
    if (!parts.length || /^[\\/]/.test(root) || /^[A-Za-z]:/.test(root) || isAbsolute(root) || parts.includes('..')) {
      throw new TypeError(`excludeRoots inválido (esperado caminho relativo ao cwd, sem '..'): '${root}'`);
    }
    return parts.join('/');
  });
}

const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
const isExcluded = (path: string, roots: string[]): boolean => {
  const p = fold(path);
  return roots.some(r => p === fold(r) || p.startsWith(`${fold(r)}/`));
};

/** Parser de `status --porcelain=v1 -z --no-renames`: um registro `XY<espaço>caminho` por NUL. */
function parseStatus(raw: string, roots: string[]): Listed[] {
  if (raw === '') return [];
  if (!raw.endsWith('\0')) {
    throw new SnapshotCaptureError('invalid-output', 'saída de git status truncada (sem terminador NUL final)');
  }
  const out: Listed[] = [];
  for (const record of raw.slice(0, -1).split('\0')) {
    const m = /^([ MADRCUT?])([ MADRCUT?]) (.+)$/s.exec(record);
    if (!m) {
      throw new SnapshotCaptureError('invalid-output', `registro inválido em git status: ${JSON.stringify(record.slice(0, 80))}`);
    }
    const [, x, y, path] = m;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      throw new SnapshotCaptureError('invalid-output', `rename/cópia inesperado apesar de --no-renames: ${JSON.stringify(record.slice(0, 80))}`, path);
    }
    if (path.includes('�')) {
      throw new SnapshotCaptureError('invalid-output', 'caminho com bytes não-UTF-8 não é representável com segurança', path);
    }
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
      throw new SnapshotCaptureError('outside-scope', 'caminho fora do escopo do worktree', path);
    }
    if (!isExcluded(path, roots)) out.push({ xy: x + y, path });
  }
  return out.sort((a, b) => byBytes(a.path, b.path) || byBytes(a.xy, b.xy));
}

/** true quando `child` está em `root` (ambos já resolvidos por realpath). */
function isInside(root: string, child: string): boolean {
  const rel = relative(process.platform === 'win32' ? root.toLowerCase() : root, process.platform === 'win32' ? child.toLowerCase() : child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Assinatura de metadados usada para detectar mudança durante a captura. */
const statKey = (st: { size: number; mtimeMs: number; ino: number | bigint; mode: number }): string =>
  `${st.size}:${st.mtimeMs}:${st.ino}:${st.mode}`;

async function hashFile(abs: string, path: string): Promise<string> {
  const h = createHash('sha256');
  try {
    for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  } catch (error) {
    throw new SnapshotCaptureError('read-failed', `arquivo relevante ilegível ou removido durante a leitura (${errCode(error)})`, path);
  }
  return h.digest('hex');
}

/** Inspeciona UM caminho listado pelo Git: lstat (nunca segue o alvo), realpath do PAI para o escopo. */
async function inspect(cwd: string, realRoot: string, item: Listed): Promise<{ entry: SnapshotEntry; key: string }> {
  const { xy, path } = item;
  const abs = join(cwd, path.replace(/\/+$/, ''));
  let st;
  try {
    // Junction/symlink de DIRETÓRIO no meio do caminho: o Git lista `junction/x` e o arquivo real está
    // fora do escopo (observado na sonda) — o realpath do pai detecta; o componente final não é seguido.
    const parent = await fs.realpath(dirname(abs));
    if (!isInside(realRoot, parent)) {
      throw new SnapshotCaptureError('outside-scope', 'caminho resolve (realpath) para fora do worktree; leitura recusada', path);
    }
    st = await fs.lstat(abs);
  } catch (error) {
    if (error instanceof SnapshotCaptureError) throw error;
    // ausência é legítima só quando o status declara remoção; caso contrário o arquivo sumiu durante a captura.
    if ((errCode(error) === 'ENOENT' || errCode(error) === 'ENOTDIR') && xy.includes('D')) {
      return { entry: { path, status: xy, type: 'deleted', hash: '' }, key: 'deleted' };
    }
    throw new SnapshotCaptureError('read-failed', `arquivo relevante ilegível ou ausente (${errCode(error)})`, path);
  }
  const key = statKey(st);
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(abs).catch((error: unknown) => {
      throw new SnapshotCaptureError('read-failed', `symlink ilegível (${errCode(error)})`, path);
    });
    return { entry: { path, status: xy, type: 'symlink', hash: sha256(target) }, key };
  }
  if (st.isDirectory()) return { entry: { path, status: xy, type: 'directory', hash: '' }, key };
  if (!st.isFile()) throw new SnapshotCaptureError('read-failed', 'tipo de arquivo não suportado (nem arquivo, symlink ou diretório)', path);
  const hash = await hashFile(abs, path);
  const after = await fs.lstat(abs).catch(() => undefined);
  if (!after || statKey(after) !== key) {
    throw new SnapshotCaptureError('unstable', 'arquivo mudou durante a leitura', path);
  }
  return { entry: { path, status: xy, type: 'file', hash }, key };
}

async function collect(runner: ProcessRunner, cwd: string, opts: SnapshotOptions): Promise<{ snapshot: CodeSnapshot; inventory: SnapshotEntry[] }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const roots = normalizeRoots(opts.excludeRoots ?? []);
  // pathspec literal: o excluído nem chega ao status/diff (o filtro em parseStatus é a segunda barreira, só do status).
  // No win32 o Git NÃO casa pathspec sem 'icase' mesmo com core.ignorecase=true (observado): icase iguala ao parser.
  const magic = process.platform === 'win32' ? 'exclude,literal,icase' : 'exclude,literal';
  const pathspec = ['--', '.', ...roots.map(r => `:(${magic})${r}`)];

  const git = async (failure: 'head-failed' | 'status-failed' | 'diff-failed', args: string[]): Promise<string> => {
    let r;
    try {
      r = await runner.run('git', args, { cwd, timeoutMs, env: GIT_ENV });
    } catch (error) {
      throw new SnapshotCaptureError(failure, `git ${args[0]} não executou: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (r.timedOut) throw new SnapshotCaptureError('timeout', `git ${args[0]} excedeu o timeout de ${timeoutMs} ms`);
    if (r.exitCode !== 0) {
      throw new SnapshotCaptureError(failure, `git ${args[0]} falhou (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return r.stdout;
  };
  const readHead = async (): Promise<string> => {
    const commit = (await git('head-failed', ['rev-parse', '--verify', 'HEAD'])).trim();
    if (!commit) throw new SnapshotCaptureError('empty-commit', 'git rev-parse HEAD devolveu commit vazio');
    if (!/^[0-9a-f]{4,64}$/i.test(commit)) {
      throw new SnapshotCaptureError('invalid-output', `git rev-parse HEAD devolveu valor que não é um commit: ${JSON.stringify(commit.slice(0, 80))}`);
    }
    return commit;
  };
  const readStatus = async (): Promise<Listed[]> =>
    parseStatus(await git('status-failed', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none', ...pathspec]), roots);

  const commit = await readHead();
  const listed = await readStatus();
  const diff = await git('diff-failed', ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=none', ...pathspec]);
  if (diff !== '' && !diff.endsWith('\n')) {
    throw new SnapshotCaptureError('invalid-output', 'saída de git diff truncada (sem newline final)');
  }

  // Só há o que resolver quando existem entradas a ler: inventário vazio não depende do cwd existir no disco.
  const realRoot = listed.length === 0 ? cwd : await fs.realpath(cwd).catch((error: unknown) => {
    throw new SnapshotCaptureError('read-failed', `raiz da captura ilegível (${errCode(error)})`);
  });
  const inventory: SnapshotEntry[] = [];
  const keys: Array<{ abs: string; path: string; key: string }> = [];
  for (const item of listed) {
    const { entry, key } = await inspect(cwd, realRoot, item);
    inventory.push(entry);
    if (entry.type !== 'deleted') keys.push({ abs: join(cwd, item.path.replace(/\/+$/, '')), path: item.path, key });
  }

  // Releitura: HEAD, inventário (mesmo conjunto XY+caminho) e metadados dos arquivos não mudaram.
  const listKey = (l: Listed[]): string => JSON.stringify(l.map(i => [i.xy, i.path]));
  if ((await readHead()) !== commit) throw new SnapshotCaptureError('unstable', 'HEAD mudou durante a captura');
  if (listKey(await readStatus()) !== listKey(listed)) {
    throw new SnapshotCaptureError('unstable', 'inventário de arquivos mudou durante a captura');
  }
  for (const k of keys) {
    const now = await fs.lstat(k.abs).catch(() => undefined);
    if (!now || statKey(now) !== k.key) throw new SnapshotCaptureError('unstable', 'arquivo mudou durante a captura', k.path);
  }

  return {
    snapshot: {
      commit,
      diffFingerprint: sha256(JSON.stringify(['sdlc-snapshot:v2', sha256(diff), inventory.map(e => [e.status, e.path, e.type, e.hash])])),
      capturedAt: new Date().toISOString(),
      source: 'git-readonly',
    },
    inventory,
  };
}

/** Captura sem lançar para falha de captura: o chamador DEVE tratar `ok:false` (gate fechado). */
export async function tryCaptureCodeSnapshot(runner: ProcessRunner, cwd: string, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  try {
    const { snapshot, inventory } = await collect(runner, cwd, opts);
    return { ok: true, snapshot, inventory };
  } catch (error) {
    if (error instanceof SnapshotCaptureError) return { ok: false, code: error.code, message: error.message, path: error.path };
    throw error;
  }
}

/** Lança SnapshotCaptureError em qualquer falha; NUNCA devolve snapshot parcial/unreadable. */
export async function captureCodeSnapshot(runner: ProcessRunner, cwd: string, opts: SnapshotOptions = {}): Promise<CodeSnapshot> {
  return (await collect(runner, cwd, opts)).snapshot;
}
