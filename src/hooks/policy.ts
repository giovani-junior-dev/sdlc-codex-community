import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path';

export interface PolicyInput {
  action: 'write' | 'git' | 'deploy';
  path?: string; command?: string; tool?: string;
  protectedPaths: string[]; allowedPaths?: string[];
  /** C06: branches protegidas (prBase do projeto e equivalentes) — push para elas é humano. */
  protectedBranches?: string[];
  /** R4-09: diretório base da AÇÃO — resolve caminhos RELATIVOS da ferramenta (cwd da
   *  sessão que originou a ação). Default process.cwd() do processo do hook.
   *  Caminhos absolutos continuam absolutos. */
  baseDir?: string;
  /** R5-09: base da CONFIGURAÇÃO — raiz principal do projeto, contra a qual
   *  protectedPaths/allowedPaths relativos resolvem. Default: baseDir (comportamento
   *  anterior; o hook sempre informa a raiz para não resolver as duas contra o mesmo cwd). */
  projectRoot?: string;
  /** R5-09: diretório dos worktrees do projeto (área de trabalho do dev). É exceção
   *  ligada ao projeto ao protegido que o contém (`.sdlc-codex`); cada filho direto é
   *  uma raiz de worktree e mantém os protectedPaths LÓGICOS (AGENTS.md, .git...). */
  worktreesDir?: string;
  /** R5-09: raízes de worktree conhecidas FORA de worktreesDir (worktree externo): os
   *  protectedPaths também valem relativos a elas, sem exceção. */
  workRoots?: string[];
}

/**
 * C06/R14 — política de ferramentas adaptada aos payloads reais do Codex:
 * - ferramenta de edição `apply_patch` com conteúdo em `tool_input.command`
 *   (hooks originais que esperam `tool_input.file_path` não se aplicam);
 * - comandos de shell pertinentes.
 *
 * Política do produto: o plano aprovado autoriza branch de trabalho, commits,
 * push da branch de trabalho e PR contra a base configurada. Permanecem
 * decisões HUMANAS: merge, deploy, rebase, reset, clean, force-push, push para
 * branch protegida (prBase) e criação de branch fora do fluxo aprovado.
 *
 * R5-09 — caminhos de escrita: extraídos pela GRAMÁTICA do apply_patch (linhas
 * `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`), não por
 * tokens com barra. Protegido/permitido relativos resolvem contra a RAIZ principal;
 * o caminho da ação, contra o cwd do payload. A comparação é por COMPONENTES de
 * caminho absoluto canonicalizado (ancestral existente via realpath.native — cobre
 * links/junctions e nomes curtos 8.3; no Windows: sem distinção de caixa, sem
 * ponto/espaço finais e sem stream alternativo `:`). Patch de ferramenta de escrita
 * reconhecida que não se consegue ler NÃO vira allow (falha fechada).
 *
 * LIMITES REAIS: é política contratual aplicada via hooks de eventos, NÃO uma
 * sandbox inviolável — um agente com execução de shell arbitrária pode
 * contornar; nunca anunciar isolamento read-only se o agente também pode
 * escrever por shell. Não cobre: escrita por shell arbitrário (redirecionamento,
 * `cp`, `sed -i`, PowerShell), ferramentas MCP/unified exec fora do matcher,
 * `apply_patch` cujo patch vem de arquivo/stdin externo (negado por não ser
 * verificável), hard links a arquivos protegidos e a corrida entre a checagem
 * e o uso (TOCTOU: link criado depois da decisão).
 */
export function checkPolicy(input: PolicyInput): { allowed: boolean; reason?: string } {
  if (input.action === 'deploy') return { allowed: false, reason: 'deploy permanece decisão humana' };
  if (input.action === 'git') {
    const cmd = input.command ?? '';
    const protectedBranches = input.protectedBranches ?? [];
    // Destrutivos/história: sempre humanos (o plano autoriza o fluxo, não a reescrita).
    // `\s` após merge/rebase evita o falso positivo em `merge-base` (inspeção read-only legítima).
    if (/\bmerge\s/i.test(cmd)) return { allowed: false, reason: 'merge exige gate humano' };
    if (/\brebase\b/i.test(cmd)) return { allowed: false, reason: 'rebase exige gate humano' };
    if (/\breset\b/i.test(cmd)) return { allowed: false, reason: 'reset exige gate humano' };
    if (/\bclean\b/i.test(cmd)) return { allowed: false, reason: 'git clean exige gate humano' };
    // Force-push reescreve história publicada — humano, mesmo na branch de trabalho.
    if (/\bpush\b/i.test(cmd) && /(^|\s)(-f|--force(=|\s|-))/.test(cmd)) {
      return { allowed: false, reason: 'force-push exige gate humano' };
    }
    // Push para branch protegida (prBase configurada): humano, com ou sem + no refspec.
    if (/\bpush\b/i.test(cmd)) {
      const pushTarget = extractPushRefs(cmd);
      const hitProtected = protectedBranches.length > 0 && protectedBranches.some(branch =>
        pushTarget.destinations.includes(branch) || pushTarget.sources.includes(branch));
      if (hitProtected) {
        return { allowed: false, reason: `push para branch protegida (${protectedBranches.join(', ')}) exige gate humano` };
      }
    }
    // Criação de branch fora do fluxo aprovado (o dev usa `worktree add` do produto):
    // checkout -b/--orphan, switch -c/-C e `git branch <nome>` (forma de criação;
    // listagem `git branch` sem argumentos continua permitida).
    if (/\bcheckout\b/i.test(cmd) && /(^|\s)(-b|--orphan)(\s|$)/i.test(cmd)) {
      return { allowed: false, reason: 'criação de branch fora do fluxo aprovado' };
    }
    if (/\bswitch\b/i.test(cmd) && /(^|\s)(-c|-C)(\s|$)/.test(cmd)) {
      return { allowed: false, reason: 'criação de branch fora do fluxo aprovado' };
    }
    if (/^\s*git\s+branch\s+\S/i.test(cmd) && !/\bbranch\s+(-[a-zA-Z]|-d|-D|-m|-M|--)/.test(cmd)) {
      return { allowed: false, reason: 'criação de branch fora do fluxo aprovado' };
    }
    // commit, push da branch de trabalho, PR: autorizados pelo plano aprovado.
  }
  // R5-09: ferramenta apply_patch, ou shell que a EXECUTA (mera menção em grep/cat não conta).
  const patchTool = input.tool === 'apply_patch';
  if (patchTool || (input.command && (INVOKES_PATCH.test(input.command) || /\*\*\* Begin Patch/.test(input.command)))) {
    // Conteúdo do patch viaja em tool_input.command; valida os arquivos pela gramática.
    if (typeof input.command !== 'string' || !input.command.trim()) {
      return { allowed: false, reason: 'apply_patch sem conteúdo de patch textual; política falha fechada' };
    }
    const files = extractPatchPaths(input.command);
    if (!files.length) {
      return { allowed: false, reason: 'patch sem cabeçalho de arquivo reconhecido (Add/Update/Delete File, Move to) ou com caminho vazio; política falha fechada' };
    }
    for (const file of files) {
      const verdict = checkPath(file, input);
      if (!verdict.allowed) return verdict;
    }
  }
  if (input.path) return checkPath(input.path, input);
  return { allowed: true };
}

/** Shell que invoca `apply_patch` em posição de comando (início, após ; & | ( ou quebra de linha, ou como argumento de `-c`/`-lc`). */
const INVOKES_PATCH = /(?:^|[;&|(\n]|\s-l?c\s+['"]?)\s*apply_patch(?:\s|$)/i;

/**
 * R5-09 — arquivos citados pelo patch: cabeçalhos da gramática do apply_patch
 * (Add/Update/Delete File e Move to). O caminho é o resto da linha (espaços e
 * Unicode preservados). Cabeçalho com espaço à esquerda também conta: o parser do
 * Codex apara a linha de cabeçalho, então a leitura larga só pode negar a mais.
 * Cabeçalho com caminho vazio invalida a extração (devolve []): o chamador nega.
 */
function extractPatchPaths(patch: string): string[] {
  const found: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*(.*?)\s*$/.exec(line);
    if (m) found.push(m[1]);
  }
  return found.some(p => !p) ? [] : found;
}

/** Extrai refs de origem/destino de um `git push` (refspecs e formas com `--`). */
function extractPushRefs(cmd: string): { sources: string[]; destinations: string[] } {
  const tokens = cmd.split(/\s+/).filter(t => t && !t.startsWith('-'));
  // tokens: git push [remote] [refspec...] — refspec: src:dst ou branch simples.
  const refs = tokens.slice(tokens.indexOf('push') + 1).filter(t => t !== 'push');
  const remote = refs[0] && !/[:^]/.test(refs[0]) && !refs[0].includes('refs/') ? refs[0] : undefined;
  const refspecs = remote ? refs.slice(1) : refs;
  const sources: string[] = [];
  const destinations: string[] = [];
  for (const spec of refspecs) {
    const clean = spec.replace(/^\+/, '');
    const parts = clean.split(':');
    if (parts.length === 2) { sources.push(parts[0]); destinations.push(parts[1]); }
    else if (parts.length === 1 && parts[0]) { sources.push(parts[0]); destinations.push(parts[0]); }
  }
  return { sources, destinations };
}

const WIN = process.platform === 'win32';

/**
 * R5-09 — componentes normalizados de um caminho absoluto. Canonicaliza o ancestral
 * EXISTENTE mais próximo (realpath.native: links, junctions, nomes 8.3) e anexa o
 * restante (arquivo novo). No Windows compara sem caixa, descarta ponto/espaço
 * finais e stream alternativo (`AGENTS.md::$DATA`) — o que o Win32 ignora ao abrir.
 */
function components(path: string): string[] {
  let full = resolve(path);
  if (WIN) full = full.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  const tail: string[] = [];
  let head = full;
  for (;;) {
    try { head = realpathSync.native(head); break; }
    catch {
      const up = dirname(head);
      if (up === head) break;
      tail.unshift(basename(head));
      head = up;
    }
  }
  const joined = resolve(head, ...tail);
  const { root } = parse(joined);
  const norm = (part: string): string => WIN ? part.replace(/:.*$/, '').replace(/[. ]+$/, '').toLowerCase() : part;
  return [WIN ? root.toLowerCase() : root, ...joined.slice(root.length).split(sep).map(norm).filter(Boolean)];
}

function within(child: string[], parent: string[]): boolean {
  return parent.length <= child.length && parent.every((part, i) => part === child[i]);
}

/** `child` é o próprio `parent` ou está dentro dele, por componentes (`protected2` ∉ `protected`). */
export function isInside(child: string, parent: string): boolean {
  return within(components(child), components(parent));
}

function checkPath(path: string, input: PolicyInput): { allowed: boolean; reason?: string } {
  const denied = { allowed: false, reason: `caminho protegido: ${path}` };
  const protectedItems = input.protectedPaths.filter(item => item.trim());
  // R5-09: ação resolve contra o cwd do payload (R4-09); configuração, contra a raiz principal.
  const configBase = input.projectRoot ?? input.baseDir ?? '.';
  const target = components(resolve(input.baseDir ?? '.', path));
  const covers = (base: string, item: string): boolean => within(target, components(resolve(base, item)));

  // 1. Protegidos relativos à raiz principal; área de trabalho (allowed + worktreesDir) é exceção.
  // Revisão C/A5: worktreesDir isenta só DESCENDENTES estritos — Add/Delete no próprio nó `.sdlc-codex/worktrees` segue negado.
  const worktreesExempt = input.worktreesDir
    ? (() => { const dir = components(resolve(configBase, input.worktreesDir)); return target.length > dir.length && within(target, dir); })()
    : false;
  const exempt = (input.allowedPaths ?? []).some(item => covers(configBase, item)) || worktreesExempt;
  if (!exempt && protectedItems.some(item => covers(configBase, item))) return denied;

  // 2. Protegidos LÓGICOS (AGENTS.md, .git, .sdlc-codex...) valem também relativos à raiz do
  // worktree em que a ação cai — sem exceção: a área de trabalho não libera o próprio protegido.
  const roots = [...(input.workRoots ?? [])];
  if (input.worktreesDir) {
    const dir = components(input.worktreesDir);
    if (target.length > dir.length && within(target, dir)) roots.push(resolve(input.worktreesDir, target[dir.length]));
  }
  const logical = protectedItems.filter(item => !isAbsolute(item));
  if (roots.some(root => logical.some(item => covers(root, item)))) return denied;
  return { allowed: true };
}
