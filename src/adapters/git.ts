import type { ProcessRunner } from './process.js';
import type { PullRequestRef } from '../contracts.js';
import type { PrObservation } from '../evidence/report.js';

/** Normaliza caminho para comparação no Windows (case-insensitivo, barras, trailing sep). */
function normalizePath(path: string): string {
  const resolved = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface WorktreeEntry { path: string; branch?: string; }

/** Parse do `git worktree list --porcelain`: blocos separados por linha vazia. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim();
    }
    if (path) entries.push({ path, branch });
  }
  return entries;
}

export class GitAdapter {
  constructor(private readonly runner: ProcessRunner, private readonly executable = 'git') {}
  async root(cwd: string): Promise<string> {
    const r = await this.runner.run(this.executable, ['rev-parse', '--show-toplevel'], { cwd });
    if (r.exitCode !== 0) throw new Error(`git root falhou: ${r.stderr.trim()}`);
    return r.stdout.trim();
  }
  async currentCommit(cwd: string): Promise<string> {
    const r = await this.runner.run(this.executable, ['rev-parse', 'HEAD'], { cwd });
    if (r.exitCode !== 0) throw new Error(`git rev-parse HEAD falhou: ${r.stderr.trim()}`);
    return r.stdout.trim();
  }
  async branchExists(root: string, branch: string): Promise<boolean> {
    const r = await this.runner.run(this.executable, ['show-ref', '--verify', `refs/heads/${branch}`], { cwd: root });
    return r.exitCode === 0;
  }
  async worktreeList(root: string): Promise<string> {
    const r = await this.runner.run(this.executable, ['worktree', 'list', '--porcelain'], { cwd: root });
    if (r.exitCode !== 0) throw new Error(`git worktree list falhou: ${r.stderr.trim()}`);
    return r.stdout;
  }
  /**
   * C07 — cria worktree a partir da BASE configurada (nunca HEAD implícito).
   * Reutiliza SOMENTE com correlação exata (nunca substring):
   * - o caminho do worktree existente deve ser IGUAL ao solicitado (normalizado);
   * - a branch registrada no worktree deve ser a esperada;
   * - a base configurada deve ser ancestral do HEAD do worktree.
   * Colisão incompatível é erro explicativo e alterações são preservadas (sem --force).
   */
  async ensureWorktree(root: string, path: string, branch: string, base: string): Promise<'created' | 'reused'> {
    const list = await this.worktreeList(root).catch(() => '');
    const target = normalizePath(path);
    const existing = parseWorktreeList(list).find(e => normalizePath(e.path) === target);
    if (existing) {
      const expected = `refs/heads/${branch}`;
      if (existing.branch && existing.branch !== expected) {
        throw new Error(`worktree ${path} existe apontando para ${existing.branch}; esperado ${expected} — colisão incompatível, resolva antes de reutilizar`);
      }
      const ancestor = await this.runner.run(this.executable, ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: path });
      if (ancestor.exitCode !== 0) {
        throw new Error(`worktree ${path} não deriva da base configurada ${base} — colisão incompatível, resolva antes de reutilizar`);
      }
      return 'reused';
    }
    if (await this.branchExists(root, branch)) {
      throw new Error(`branch ${branch} já existe e worktree ${path} não a contém; colisão incompatível — resolva antes de reutilizar`);
    }
    const r = await this.runner.run(this.executable, ['worktree', 'add', '-b', branch, path, base], { cwd: root });
    if (r.exitCode !== 0) throw new Error(`git worktree add falhou: ${r.stderr.trim()}`);
    return 'created';
  }
  async status(cwd: string): Promise<string> {
    const r = await this.runner.run(this.executable, ['status', '--short'], { cwd });
    if (r.exitCode !== 0) throw new Error(`git status falhou: ${r.stderr.trim()}`);
    return r.stdout;
  }
  async verifyCommit(cwd: string, commit: string): Promise<boolean> {
    if (!/^[0-9a-f]{4,64}$/i.test(commit)) return false;
    const r = await this.runner.run(this.executable, ['cat-file', '-e', `${commit}^{commit}`], { cwd });
    return r.exitCode === 0;
  }
  /**
   * R5-07/M4-F2 — SOMENTE LEITURA: caminhos alterados entre dois commits (`git diff --name-only -z`).
   * Usado para provar que o avanço de commit pós-revisão só tocou raízes documentais aprovadas.
   */
  async changedPaths(cwd: string, from: string, to: string): Promise<string[]> {
    // Revisão B/B1: SEM detecção de rename — com a padrão (diff.renames=true) um `git mv src/x docs/x` lista só o caminho NOVO
    // e escondia o código removido; --no-renames lista o antigo e o novo (mesma disciplina de snapshot.ts).
    const r = await this.runner.run(this.executable, ['diff', '--name-only', '-z', '--no-renames', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-color', from, to], { cwd });
    if (r.timedOut) throw new Error('git diff --name-only: timeout');
    if (r.exitCode !== 0) throw new Error(`git diff --name-only falhou: ${r.stderr.trim()}`);
    return r.stdout.split('\0').filter(Boolean);
  }
  /** M6-F2 — somente leitura: URL do remote 'origin' (identidade do repositório nas intenções de PR). */
  async remoteUrl(cwd: string): Promise<string> {
    const r = await this.runner.run(this.executable, ['remote', 'get-url', 'origin'], { cwd });
    if (r.exitCode !== 0 || !r.stdout.trim()) throw new Error(`git remote get-url falhou: ${r.stderr.trim()}`);
    return r.stdout.trim();
  }
}

/**
 * R15 — adaptador de PR via GitHub CLI, com consultas testáveis por falso.
 * Em retomada, localizar PR da branch antes de criar outra (sem duplicar publicação).
 */
export interface GitHubAdapter {
  findOpenPr(branch: string, base: string, cwd: string): Promise<PullRequestRef | undefined>;
  viewPr(ref: string, cwd: string): Promise<PrObservation>;
  createPr(branch: string, base: string, title: string, body: string, cwd: string): Promise<PullRequestRef>;
}

export class GhAdapter implements GitHubAdapter {
  constructor(private readonly runner: ProcessRunner, private readonly executable = 'gh') {}
  /** M6-F2 — timeout é distinto de resposta negativa: após possível aceitação o
   *  chamador marca 'uncertain' (nunca retry cego). A mensagem carrega 'timeout'. */
  private static check(args: string[], r: { exitCode: number | null; stderr: string; timedOut: boolean }): void {
    if (r.timedOut) throw new Error(`gh ${args[0]} ${args[1]}: timeout (resposta não recebida no prazo)`);
    if (r.exitCode !== 0) throw new Error(`gh ${args[0]} ${args[1]} falhou: ${r.stderr.trim()}`);
  }
  async findOpenPr(branch: string, base: string, cwd: string): Promise<PullRequestRef | undefined> {
    const r = await this.runner.run(this.executable,
      ['pr', 'list', '--head', branch, '--base', base, '--state', 'open', '--json', 'url,headRefName,baseRefName,headRefOid,number'],
      { cwd });
    GhAdapter.check(['pr', 'list'], r);
    let items: Array<{ url: string; headRefName: string; baseRefName: string; headRefOid: string; number: number }>;
    try {
      items = JSON.parse(r.stdout) as typeof items;
      if (!Array.isArray(items)) return undefined;
    } catch { return undefined; }
    const pr = items.find(i => i.headRefName === branch && i.baseRefName === base);
    if (!pr) return undefined;
    return { url: pr.url, base: pr.baseRefName, branch: pr.headRefName, commit: pr.headRefOid, number: pr.number, checkedAt: new Date().toISOString() };
  }
  /**
   * R5-07/M4-F2 — observação SOMENTE LEITURA por identidade estável (URL da PR registrada ou
   * número): estado ATUAL, base, branch e head SHA. Consultar por branch não troca a PR
   * original por outra. PR inexistente => state 'ABSENT' (nunca sucesso); timeout, saída
   * inválida ou campo ausente lançam (resposta incompleta não vira sucesso).
   */
  async viewPr(ref: string, cwd: string): Promise<PrObservation> {
    const r = await this.runner.run(this.executable,
      ['pr', 'view', ref, '--json', 'url,number,state,headRefName,baseRefName,headRefOid'], { cwd });
    if (r.timedOut) throw new Error('gh pr view: timeout (resposta não recebida no prazo)');
    const observedAt = new Date().toISOString();
    if (r.exitCode !== 0) {
      if (/no pull requests? found|could not resolve to a pullrequest|not found/i.test(r.stderr)) {
        return { url: ref, state: 'ABSENT', base: '', branch: '', headSha: '', observedAt };
      }
      throw new Error(`gh pr view falhou: ${r.stderr.trim()}`);
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(r.stdout) as Record<string, unknown>; }
    catch { throw new Error('gh pr view: saída JSON inválida'); }
    const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!str(body.url) || !str(body.state) || !str(body.headRefName) || !str(body.baseRefName) || !str(body.headRefOid)) {
      throw new Error('gh pr view: resposta incompleta (url/state/headRefName/baseRefName/headRefOid); nunca tratada como sucesso');
    }
    return { url: body.url, number: typeof body.number === 'number' ? body.number : undefined, state: body.state.toUpperCase(), base: body.baseRefName, branch: body.headRefName, headSha: body.headRefOid, observedAt };
  }
  async createPr(branch: string, base: string, title: string, body: string, cwd: string): Promise<PullRequestRef> {
    const r = await this.runner.run(this.executable,
      ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body], { cwd });
    GhAdapter.check(['pr', 'create'], r);
    const url = r.stdout.trim().split(/\s+/).find(s => s.startsWith('http')) ?? r.stdout.trim();
    const existing = await this.findOpenPr(branch, base, cwd).catch(() => undefined);
    return existing ?? { url, base, branch, commit: '', checkedAt: new Date().toISOString() };
  }
}
