import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ProjectConfig } from './config.js';

const BEGIN = '<!-- sdlc-codex:begin -->';
const END = '<!-- sdlc-codex:end -->';
const MANAGED_AGENTS = `${BEGIN}\nEste projeto usa SDLC Codex. O estado operacional fica em .sdlc-codex/.\nComandos: adopt, up, status, start, send, receive, finish-message, check, next, recover, hook, doctor.\n${END}\n`;

/** Comando canônico de uma entrada gerenciada do produto no hooks.json do Codex. */
const managedCommand = (event: string): string => `sdlc-codex hook ${event}`;

// R4-09 — fonte: codex-cli 0.155.1 (feature flag `hooks` = stable/ativada; enum
// HookEvents do binário: PreToolUse, PermissionRequest, PostToolUse, PreCompact,
// PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart,
// SubagentStop, Stop, Interrupt). Eventos de CONTEXTO (persona/retomada) e
// interceptação REAL de ferramenta (PreToolUse → permissionDecision deny/allow,
// exit 2 + razão no stderr) são separados de propósito. Matcher `Bash|apply_patch`
// cobre shell e apply_patch; ferramentas MCP/unificadas NÃO são interceptadas
// por padrão (limitação declarada, não proteção inexistente afirmada).
const CODEX_HOOKS = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash|apply_patch',
        hooks: [
          {
            type: 'command',
            command: 'sdlc-codex hook PreToolUse',
            timeout: 10,
          },
        ],
      },
    ],
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [
          {
            type: 'command',
            command: 'sdlc-codex hook SessionStart',
            timeout: 15,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: 'sdlc-codex hook SessionEnd',
            timeout: 3,
          },
        ],
      },
    ],
    PreCompact: [
      {
        matcher: 'manual|auto',
        hooks: [
          {
            type: 'command',
            command: 'sdlc-codex hook PreCompact',
            timeout: 30,
          },
        ],
      },
    ],
    PostCompact: [
      {
        matcher: 'manual|auto',
        hooks: [
          {
            type: 'command',
            command: 'sdlc-codex hook PostCompact',
            timeout: 30,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: 'sdlc-codex hook UserPromptSubmit',
            timeout: 10,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: 'sdlc-codex hook Stop',
            timeout: 3,
          },
        ],
      },
    ],
  },
};

export interface AdoptionResult { changed: string[]; diff: string[]; config: ProjectConfig; }

/** Uma ENTRADA de hook é gerenciada se é comando com EXATAMENTE `sdlc-codex hook <evento>`.
 *  Identificação estruturada e exata (type 'command' + igualdade de comando após
 *  trim) — NUNCA substring: um comando do usuário que menciona o nome do produto
 *  como texto comum (ex.: `meu-logger "sdlc-codex hook SessionStart"`) é externo
 *  e preservado. */
function isManagedHookEntry(entry: unknown, event: string): boolean {
  if (!isPlainObject(entry)) return false;
  if (entry.type !== 'command') return false;
  return typeof entry.command === 'string' && entry.command.trim() === managedCommand(event);
}

/** Entradas gerenciadas vigentes de um evento (achatadas dos matchers canônicos). */
function managedHookEntries(event: string): unknown[] {
  const matchers = (CODEX_HOOKS.hooks as Record<string, unknown[]>)[event] ?? [];
  return matchers.flatMap(matcher =>
    isPlainObject(matcher) && Array.isArray((matcher as Record<string, unknown>).hooks)
      ? ((matcher as Record<string, unknown>).hooks as unknown[])
      : []);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * C05/R4-12 — mescla as entradas gerenciadas do produto no hooks.json do Codex:
 * - matchers EXTERNOS (sem entrada gerenciada) ficam intactos, na ordem original;
 * - matcher MISTO (externo + gerenciado) é mesclado no nível de ENTRADAS: as
 *   entradas gerenciadas (exatas) são substituídas pela definição vigente na
 *   posição da primeira ocorrência; as entradas do usuário e as propriedades
 *   desconhecidas do matcher são preservadas — o hook do usuário NUNCA é perdido;
 * - eventos não gerenciados e propriedades de topo desconhecidas são preservados;
 * - um arquivo preexistente inválido (JSON malformado ou não-objeto) NUNCA é
 *   sobrescrito: adopt falha com erro explicativo antes de qualquer gravação.
 */
function mergeCodexHooks(existingText: string, hooksFile: string): unknown {
  if (!existingText.trim()) return CODEX_HOOKS;
  let parsed: unknown;
  try { parsed = JSON.parse(existingText); }
  catch { throw new Error(`${hooksFile} préexistente tem JSON malformado; adopt não sobrescreve — corrija ou remova o arquivo manualmente`); }
  if (!isPlainObject(parsed)) {
    throw new Error(`${hooksFile} préexistente não é um objeto JSON; adopt não sobrescreve — corrija ou remova o arquivo manualmente`);
  }
  const base: Record<string, unknown> = { ...parsed };
  const hooksSection: Record<string, unknown> = isPlainObject(base.hooks) ? { ...base.hooks as Record<string, unknown> } : {};
  base.hooks = hooksSection;
  for (const event of Object.keys(CODEX_HOOKS.hooks)) {
    const existingList = Array.isArray(hooksSection[event]) ? hooksSection[event] as unknown[] : [];
    const nextList: unknown[] = [];
    let managedPlaced = false;
    for (const matcher of existingList) {
      const hooks = isPlainObject(matcher) ? (matcher as Record<string, unknown>).hooks : undefined;
      if (!Array.isArray(hooks) || !hooks.some(h => isManagedHookEntry(h, event))) {
        // Matcher totalmente externo (ou de forma não gerenciada): preservado intacto.
        nextList.push(matcher);
        continue;
      }
      // Matcher misto: remove as entradas gerenciadas e reinsere a definição
      // vigente na posição da primeira ocorrência removida; externas preservadas.
      const mergedHooks: unknown[] = [];
      let replaced = false;
      for (const entry of hooks) {
        if (isManagedHookEntry(entry, event)) {
          if (!replaced) { mergedHooks.push(...managedHookEntries(event)); replaced = true; }
          continue;
        }
        mergedHooks.push(entry);
      }
      nextList.push({ ...(matcher as Record<string, unknown>), hooks: mergedHooks });
      managedPlaced = true;
    }
    if (!managedPlaced) {
      // Nenhuma entrada gerenciada existia: anexa os matchers canônicos do evento.
      nextList.push(...((CODEX_HOOKS.hooks as Record<string, unknown[]>)[event] ?? []));
    }
    hooksSection[event] = nextList;
  }
  return base;
}

/** O Codex oferece `commandWindows` justamente para não depender da resolução
 * de shims pelo PATH/shell. O caminho absoluto liga o hook ao shim criado pela
 * mesma adoção e continua funcionando quando a sessão roda em um worktree. */
function withWindowsCommands(value: unknown, _projectRoot: string): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.hooks)) return value;
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const node = process.execPath;
  const hooks = value.hooks as Record<string, unknown>;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      group.hooks = group.hooks.map(entry => isManagedHookEntry(entry, event)
        ? { ...entry, commandWindows: `"${node}" "${cli}" hook ${event}` }
        : entry);
    }
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * C05/R14 — adoção idempotente que preserva arquivos:
 * - config.json gerenciado; AGENTS.md/.gitignore recebem APENAS blocos marcados
 *   do produto (backup .bak obrigatório ao modificar preexistente — falha de
 *   backup aborta sem sobrescrever);
 * - .codex/hooks.json é MESCLADO (entradas externas e propriedades preservadas;
 *   JSON malformado préexistente faz a adoção falhar sem gravar nada);
 * - erro de leitura (diferente de "arquivo ausente") nunca é tratado como
 *   arquivo vazio;
 * - cria evidence/ e worktrees/. Nunca altera configurações globais nem copia credenciais.
 */
export async function adopt(projectRoot: string, configPath: string, apply = false): Promise<AdoptionResult> {
  const config = await loadConfig(configPath);
  const stateRoot = join(projectRoot, '.sdlc-codex');
  const changed: string[] = [];
  const diff: string[] = [];

  // ---------- Fase 1: calcular TODOS os alvos (nenhuma gravação aqui).
  // Parse malformado de hooks.json préexistente falha NESTA fase — antes de
  // qualquer gravação — deixando o projeto exatamente como estava.

  const configText = JSON.stringify(config, null, 2) + '\n';
  const configFile = join(stateRoot, 'config.json');
  const configChanged = (await read(configFile)) !== configText;
  if (configChanged) diff.push(configFile);

  const agentsFile = join(projectRoot, 'AGENTS.md');
  const existingAgents = await read(agentsFile);
  const nextAgents = existingAgents.includes(BEGIN)
    ? existingAgents.replace(new RegExp(`${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`), MANAGED_AGENTS)
    : `${existingAgents}${existingAgents.endsWith('\n') || !existingAgents ? '' : '\n'}\n${MANAGED_AGENTS}`;
  if (existingAgents !== nextAgents) diff.push(agentsFile);

  // C05: hooks.json é MESCLADO, nunca substituído: entradas externas e
  // propriedades desconhecidas válidas são preservadas; entradas gerenciadas
  // (comando apontando para o hook do produto) são atualizadas idempotentemente.
  const codexDir = join(projectRoot, '.codex');
  const hookFile = join(codexDir, 'hooks.json');
  const existingHooksText = await read(hookFile);
  const mergedHooks = withWindowsCommands(mergeCodexHooks(existingHooksText, hookFile), projectRoot);
  const nextHooksText = JSON.stringify(mergedHooks, null, 2) + '\n';
  const hooksChanged = existingHooksText.trim().length === 0 || !deepEqual(JSON.parse(existingHooksText), mergedHooks);
  if (hooksChanged) diff.push(hookFile);

  const ignoreFile = join(projectRoot, '.gitignore');
  const existingIgnore = await read(ignoreFile);
  const managedIgnore = `${BEGIN} .sdlc-codex\n.sdlc-codex/runtime.json\n.sdlc-codex/runtime.backup.json\n.sdlc-codex/state.lock\n.sdlc-codex/worktrees/\n.sdlc-codex/bin/\n${END}\n`;
  let nextIgnore = existingIgnore;
  if (!existingIgnore.includes(BEGIN)) {
    nextIgnore = `${existingIgnore}${existingIgnore.endsWith('\n') || !existingIgnore ? '' : '\n'}\n${managedIgnore}`;
  }
  if (existingIgnore !== nextIgnore) diff.push(ignoreFile);

  // Os hooks são comandos filhos do Codex e precisam localizar esta CLI. Um
  // shim dentro do projeto evita instalação global e fica ligado exatamente ao
  // Node/entrypoint que executou a adoção.
  const shimFile = join(stateRoot, 'bin', 'sdlc-codex.cmd');
  const cliEntrypoint = fileURLToPath(new URL('../cli.js', import.meta.url));
  const shimText = `@echo off\r\n"${process.execPath}" "${cliEntrypoint}" %*\r\n`;
  const shimChanged = (await read(shimFile)) !== shimText;
  if (shimChanged) diff.push(shimFile);

  // ---------- Fase 2: gravar. Backup obrigatório antes de alterar arquivo
  // preexistente; falha de BACKUP aborta antes de qualquer gravação. NÃO há
  // transação multi-arquivo: se a GRAVAÇÃO de um arquivo falhar no meio da
  // fase 2, os anteriores já foram gravados (adoção parcial). Recuperação real:
  // cada arquivo modificado tem <arquivo>.bak com o conteúdo pré-adoção (feitos
  // antes de qualquer gravação) — restaure manualmente ou simplesmente rode
  // adopt --apply de novo: a adoção é idempotente e completa os arquivos que
  // faltavam sem reescrever os já corretos.
  if (apply) {
    const pending: Array<{ file: string; content: string; changed: () => void }> = [];
    if (configChanged) pending.push({
      file: configFile, content: configText, changed: () => { changed.push(configFile); },
    });
    if (existingAgents !== nextAgents) pending.push({
      file: agentsFile, content: nextAgents, changed: () => { changed.push(agentsFile); },
    });
    if (hooksChanged) pending.push({
      file: hookFile, content: nextHooksText, changed: () => { changed.push(hookFile); },
    });
    if (existingIgnore !== nextIgnore) pending.push({
      file: ignoreFile, content: nextIgnore, changed: () => { changed.push(ignoreFile); },
    });
    if (shimChanged) pending.push({
      file: shimFile, content: shimText, changed: () => { changed.push(shimFile); },
    });
    for (const item of pending) {
      const previous = await read(item.file);
      if (previous.trim().length > 0) await backupOrThrow(item.file, previous);
    }
    await fs.mkdir(stateRoot, { recursive: true });
    for (const item of pending) {
      await fs.mkdir(dirname(item.file), { recursive: true });
      await fs.writeFile(item.file, item.content);
      item.changed();
    }
    await fs.mkdir(join(stateRoot, 'evidence'), { recursive: true });
    await fs.mkdir(join(stateRoot, 'worktrees'), { recursive: true });
  }
  return { changed, diff, config };
}

/** Backup obrigatório: falha ao gravar o .bak aborta a adoção sem sobrescrever o original. */
async function backupOrThrow(file: string, content: string): Promise<void> {
  try {
    await fs.writeFile(`${file}.bak`, content);
  } catch (error) {
    throw new Error(`falha ao criar backup de ${file}: ${(error as Error).message}; adopt abortado sem sobrescrever o arquivo`);
  }
}

/** Lê um arquivo; ausência retorna string vazia, qualquer OUTRO erro de leitura propaga. */
async function read(path: string): Promise<string> {
  try { return await fs.readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(`falha ao ler ${path}: ${(error as Error).message}; adopt não assume arquivo vazio`);
  }
}
function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
