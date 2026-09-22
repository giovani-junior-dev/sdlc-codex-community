import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProcessResult, ProcessRunner } from '../../src/adapters/process.js';

// Helper dos testes de snapshot (M2, R5-04/R5-06). Não é um teste (fora do glob *.test.js).
// O Git é falso SÓ na borda de processo; arquivos e diretórios são temporários e reais.
// As strings de status/diff abaixo seguem o formato REAL observado em
// docs/validation/round-5/m2-git-format-probe.log (git 2.51.1.windows.1).

export type GitCommand = 'head' | 'status' | 'diff';
export interface GitState { head: string; status: string; diff: string }
export interface GitCall { executable: string; args: string[]; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }

export const ok = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, acceptedBeforeTimeout: false });
export const fail = (exitCode = 128, stderr = 'fatal: falha simulada'): ProcessResult => ({ exitCode, stdout: '', stderr, timedOut: false, acceptedBeforeTimeout: false });
export const timeout = (): ProcessResult => ({ exitCode: null, stdout: '', stderr: '', timedOut: true, acceptedBeforeTimeout: false });

/** Registros do porcelain v1 -z: cada um termina em NUL (o terminador FAZ parte do formato). */
export const porcelain = (...records: string[]): string => records.map(r => `${r}\0`).join('');

/** Runner falso do Git: só aceita rev-parse/status/diff (qualquer outro comando explode o teste). */
export class GitFake implements ProcessRunner {
  calls: GitCall[] = [];
  readonly counts: Record<GitCommand, number> = { head: 0, status: 0, diff: 0 };
  /** hook por chamada: devolve um resultado para substituir a resposta padrão (n = nº da chamada, 1-based). */
  constructor(public state: GitState, private readonly hook?: (cmd: GitCommand, n: number) => ProcessResult | undefined | Promise<ProcessResult | undefined>) {}
  async run(executable: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
    this.calls.push({ executable, args: [...args], ...options });
    const cmd: GitCommand | undefined = args[0] === 'rev-parse' ? 'head' : args[0] === 'status' ? 'status' : args[0] === 'diff' ? 'diff' : undefined;
    if (executable !== 'git' || !cmd) throw new Error(`comando inesperado no snapshot: ${executable} ${args.join(' ')}`);
    const n = ++this.counts[cmd];
    const forced = await this.hook?.(cmd, n);
    if (forced) return forced;
    return ok(cmd === 'head' ? `${this.state.head}\n` : cmd === 'status' ? this.state.status : this.state.diff);
  }
}

export const HEAD = 'abc123';
export const gitFake = (status = '', diff = '', hook?: ConstructorParameters<typeof GitFake>[1]): GitFake =>
  new GitFake({ head: HEAD, status, diff }, hook);

export async function tmpRepo(prefix = 'sdlc-snap-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Grava arquivos (conteúdo string ou bytes) criando os diretórios intermediários. */
export async function put(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}
