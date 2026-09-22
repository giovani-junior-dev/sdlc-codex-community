import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROLES, isUuid, type Role } from '../contracts.js';
import { parseWorktreeList, type GitAdapter } from '../adapters/git.js';

export interface CommandConfig { executable: string; args: string[]; cwd?: string; shell?: boolean; }
export interface ProjectConfig {
  schemaVersion: 1; projectId: string; projectName: string; prBase: string;
  checks: Partial<Record<'build' | 'lint' | 'unit' | 'e2e', CommandConfig>>;
  models: Partial<Record<Role, { model?: string; effort?: string }>>;
  protectedPaths: string[];
}
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/** R04/R07/C03 — validação runtime completa de configuração; erro nunca é engolido. */
export function validateConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== 'object') throw new Error('configuração deve ser objeto');
  const c = value as Partial<ProjectConfig>;
  if (c.schemaVersion !== 1) throw new Error('configuração inválida: schemaVersion deve ser 1');
  if (!c.projectId || typeof c.projectId !== 'string') throw new Error('configuração inválida: projectId obrigatório');
  if (!c.projectName || typeof c.projectName !== 'string') throw new Error('configuração inválida: projectName obrigatório');
  if (!c.prBase || typeof c.prBase !== 'string') throw new Error('configuração inválida: prBase obrigatório');
  if (!Array.isArray(c.protectedPaths) || !c.protectedPaths.every(p => typeof p === 'string' && p.length)) {
    throw new Error('configuração inválida: protectedPaths deve ser array de strings');
  }
  if (c.checks !== undefined) {
    if (typeof c.checks !== 'object' || Array.isArray(c.checks)) throw new Error('configuração inválida: checks deve ser objeto');
    for (const [name, command] of Object.entries(c.checks)) {
      if (!['build', 'lint', 'unit', 'e2e'].includes(name)) throw new Error(`check desconhecido: ${name}`);
      if (!command || typeof command !== 'object') throw new Error(`check ${name}: comando deve ser objeto`);
      const cmd = command as Partial<CommandConfig>;
      if (!cmd.executable || typeof cmd.executable !== 'string') throw new Error(`check ${name}: executável obrigatório`);
      if (!Array.isArray(cmd.args) || !cmd.args.every(a => typeof a === 'string')) {
        throw new Error(`check ${name}: args deve ser vetor de strings`);
      }
      // C03: cwd/shell com tipos corretos
      if (cmd.cwd !== undefined && typeof cmd.cwd !== 'string') throw new Error(`check ${name}: cwd deve ser string`);
      if (cmd.shell !== undefined && typeof cmd.shell !== 'boolean') throw new Error(`check ${name}: shell deve ser boolean`);
    }
  }
  if (c.models !== undefined) {
    if (typeof c.models !== 'object' || Array.isArray(c.models)) throw new Error('configuração inválida: models deve ser objeto');
    for (const [role, spec] of Object.entries(c.models)) {
      if (!(ROLES as string[]).includes(role)) throw new Error(`modelo configurado para papel desconhecido: ${role}`);
      if (spec !== undefined) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`modelo para ${role} deve ser objeto`);
        const s = spec as { model?: unknown; effort?: unknown };
        if (s.model !== undefined && (typeof s.model !== 'string' || !s.model.length)) {
          throw new Error(`modelo inválido para ${role}: deve ser string não vazia`);
        }
        if (s.effort !== undefined && (typeof s.effort !== 'string' || !EFFORTS.includes(s.effort))) {
          throw new Error(`effort inválido para ${role}: ${String(s.effort)}`);
        }
      }
    }
  }
  // C03: projectId deve ser UUID do produto (validado por último para mensagens de erro específicas acima)
  if (!isUuid(c.projectId)) throw new Error('configuração inválida: projectId deve ser UUID');
  return {
    schemaVersion: 1, projectId: c.projectId, projectName: c.projectName, prBase: c.prBase,
    checks: c.checks ?? {}, models: c.models ?? {}, protectedPaths: c.protectedPaths,
  } as ProjectConfig;
}

export async function loadConfig(path: string): Promise<ProjectConfig> {
  let raw: string;
  try { raw = await fs.readFile(path, 'utf8'); }
  catch { throw new Error(`configuração não encontrada: ${path}; execute adopt --apply`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`configuração com JSON inválido: ${path}`); }
  return validateConfig(parsed);
}

/**
 * R4-15 — resolve a raiz PRINCIPAL (checkout com .sdlc-codex) a partir de cwd,
 * subdiretório ou worktree. Estratégia:
 * 1. ascendência de diretórios a partir de `start` (raiz, subdiretório ou
 *    worktree DENTRO da árvore do checkout principal);
 * 2. worktree FORA da árvore: ascendência não alcança a raiz principal, então
 *    usa-se o contrato Git SOMENTE LEITURA (rev-parse --show-toplevel +
 *    worktree list --porcelain): o checkout principal é o worktree listado
 *    (ou o próprio toplevel) que contém .sdlc-codex/config.json. Exatamente
 *    um candidato => raiz; mais de um => erro de ambiguidade (nunca adivinhar
 *    — dois projetos podem compartilhar o mesmo repositório); Git
 *    indisponível/não é repositório => comportamento legado (devolve `start`).
 * Sem `opts.git`, permanece a ascendência pura (comportamento anterior).
 */
export interface FindProjectRootOptions {
  git?: Pick<GitAdapter, 'root' | 'worktreeList'>;
}

export async function findProjectRoot(start = process.cwd(), opts?: FindProjectRootOptions): Promise<string> {
  const from = resolve(start);
  let current = from;
  while (true) {
    if (await exists(join(current, '.sdlc-codex', 'config.json'))) return current;
    if (await exists(join(current, '.sdlc-codex'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  if (opts?.git) {
    try {
      const toplevel = resolve(await opts.git.root(from));
      const candidates = new Map<string, string>();
      if (await exists(join(toplevel, '.sdlc-codex', 'config.json'))) candidates.set(toplevel, toplevel);
      const listed = await opts.git.worktreeList(toplevel).catch(() => '');
      for (const entry of parseWorktreeList(listed)) {
        const path = resolve(entry.path);
        if (await exists(join(path, '.sdlc-codex', 'config.json'))) candidates.set(path, path);
      }
      if (candidates.size === 1) return [...candidates.values()][0];
      if (candidates.size > 1) {
        throw new Error(`raiz do projeto ambígua a partir de ${from}: ${[...candidates.keys()].join(' | ')} — informe a raiz explicitamente (--project)`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('raiz do projeto ambígua')) throw error;
      // Git indisponível ou `start` não é repositório: comportamento legado.
    }
  }
  return from;
}

async function exists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; }
  catch { return false; }
}
