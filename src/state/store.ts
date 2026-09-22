import { promises as fs, realpath, constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, createServer, type Server } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { emptyRuntime, validateRuntime, type Runtime } from '../contracts.js';

/** Canonicalização real do caminho (resolve caixa, barras, junctions). Exige diretório existente. */
const realpathNative = promisify(realpath.native);

export class StateConflictError extends Error { constructor(message: string) { super(message); this.name = 'StateConflictError'; } }
export class StateCorruptError extends Error { constructor(message: string) { super(message); this.name = 'StateCorruptError'; } }

/**
 * C02: estado válido e íntegro pertence a outro projeto. Distinto de corrupção
 * genérica e de "arquivo ausente": a identidade é comparada explicitamente.
 */
export class ProjectIdentityError extends Error {
  constructor(readonly expectedProjectId: string, readonly actualProjectId: string) {
    super(`identidade do projeto divergente: runtime pertence a '${actualProjectId}', store espera '${expectedProjectId}'`);
    this.name = 'ProjectIdentityError';
  }
}

export interface StoreOptions { projectId?: string; lockWaitMs?: number; }

/**
 * R5-01/R5-02 — INFORMAÇÃO de diagnóstico do detentor do lock. NUNCA é autoridade:
 * nenhuma decisão de aquisição, remoção ou liberação consulta este conteúdo
 * (a liberação só o usa para não apagar a informação de OUTRO detentor).
 * Sobra de crash é inerte e é sobrescrita pelo detentor seguinte.
 */
export interface LockInfo { pid: number; processStartMs: number; token: string; acquiredAt: string; }

/** Resultado somente-leitura de lockStatus(). */
export interface LockStatus {
  /** 'yes' = alguém detém a autoridade; 'no' = ninguém; 'unknown' = sonda inconclusiva. */
  held: 'yes' | 'no' | 'unknown';
  /** Dica do detentor (pode estar obsoleta por microssegundos); ausente se ilegível. */
  info?: LockInfo;
  /** Artefatos inertes relativos ao root: `recoverStaleLocks()` remove os legados e temporários órfãos; `state.lock` (informação
   *  de diagnóstico) é RECICLADO pela própria aquisição (o detentor a sobrescreve e o release a remove) e por isso não consta
   *  em `removed`. */
  leftovers: string[];
}

/** Resultado de recoverStaleLocks(): nomes (relativos ao root) efetivamente removidos. */
export interface StaleLockCleanup { removed: string[] }

/**
 * R5-01/R5-02 — Ganchos EXCLUSIVOS de teste nas barreiras REAIS do protocolo
 * (tests/integration/lock-mutual-exclusion.test.ts). Nunca definidos em produção;
 * o padrão é vazio e as chamadas são no-op.
 */
export interface LockTestHooks {
  /** Após obter a autoridade do SO, ANTES de escrever a informação em disco. */
  afterAuthorityAcquired?: () => Promise<void>;
  /** Dentro da seção crítica, com a autoridade detida e a informação já gravada. */
  afterLockAcquired?: (info: LockInfo) => Promise<void>;
  /** Em recoverStaleLocks(): autoridade já detida e leftovers observados, antes de removê-los. */
  afterLeftoversObserved?: (leftovers: string[]) => Promise<void>;
  /** Dentro da seção crítica, com o temporário já gravado e o backup preservado, ANTES do rename. */
  beforeRuntimeRename?: (tempPath: string) => Promise<void>;
  /** Após ler um runtime v1 e antes de preservar seu conteúdo original. */
  beforeLegacyBackup?: () => Promise<void>;
  /** No início do release, com a autoridade AINDA detida (último ponto da seção crítica): permite medir a seção INTEIRA (revisão A/T1). */
  beforeRelease?: () => Promise<void>;
}
export const lockTestHooks: LockTestHooks = {};

/** Diretórios de lock da rodada 4, hoje sem papel algum: lixo inerte a limpar. */
const LEGACY_LOCK_DIRS = ['state.lock.manager', 'state.lock.recover'] as const;
/** Temporário órfão do ciclo transacional (crash antes do rename). */
const ORPHAN_TEMP = /^runtime\.json\..+\.tmp$/;

/** Retry limitado para rename interrompido por handle transitório de antivírus/indexador no Windows. */
const RENAME_MAX_ATTEMPTS = 3;
/** Retry limitado da LEITURA do runtime contra a troca atômica (rename) de um escritor concorrente no Windows. */
const READ_MAX_ATTEMPTS = 6;
const READ_RETRY_DELAY_MS = 15;
const RENAME_RETRY_DELAY_MS = 20;

/** UV_FS_O_EXLOCK: libuv abre o arquivo no Windows com share mode 0. */
const WINDOWS_EXCLUSIVE_LOCK = 0x10000000;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** R4-03/decisão M0-F2 nº7: candidato em schemaVersion 1 (legado). */
function isLegacySchemaV1(parsed: unknown): boolean {
  return !!parsed && typeof parsed === 'object' && (parsed as { schemaVersion?: unknown }).schemaVersion === 1;
}

/**
 * R4-03/decisão M0-F2 nº7: transformação mínima e explícita v1 -> v2 na carga.
 * Eleva schemaVersion e marca TODA evidência legada como provenance 'legacy'
 * (gate rejeita 'legacy' para requisito obrigatório — responsabilidade M4).
 * NUNCA inventa runId/revisão/timestamp ausentes. O resultado é validado pelo
 * schema atual; conteúdo inválido é recusado (erro explicativo), não reparado.
 *
 * R5-11: operação ACEITA sem `runId` (string) e `revision` (inteiro >= 0) é
 * marcada provenance 'legacy' — a origem fica explícita em vez de inventada. O
 * schema moderno exige runId + revisão para operação aceita; sem a marca, o estado
 * migrado seria inválido. Operação aceita com runId e revisão válidos NÃO recebe
 * marca: ela já é moderna e não pode ser rebaixada a legado.
 */
function migrateLegacyRuntime(parsed: unknown): unknown {
  const migrated = structuredClone(parsed) as { schemaVersion: number; evidence?: unknown; operations?: unknown };
  migrated.schemaVersion = 2;
  if (Array.isArray(migrated.evidence)) {
    for (const e of migrated.evidence) {
      if (e && typeof e === 'object' && (e as Record<string, unknown>).provenance === undefined) {
        (e as Record<string, unknown>).provenance = 'legacy';
      }
    }
  }
  if (migrated.operations && typeof migrated.operations === 'object' && !Array.isArray(migrated.operations)) {
    for (const op of Object.values(migrated.operations as Record<string, unknown>)) {
      if (!op || typeof op !== 'object') continue;
      const entry = op as Record<string, unknown>;
      if (entry.accepted !== true || entry.provenance !== undefined) continue;
      const identificada = typeof entry.runId === 'string' && entry.runId.length > 0
        && Number.isInteger(entry.revision) && (entry.revision as number) >= 0;
      if (!identificada) entry.provenance = 'legacy';
    }
  }
  return migrated;
}

export class StateStore {
  readonly root: string; readonly runtimePath: string; readonly backupPath: string;
  /** Diretório de INFORMAÇÃO do detentor (state.lock/owner.json). Nunca é autoridade. */
  readonly lockDir: string;
  constructor(root: string, private readonly options: StoreOptions = {}) {
    this.root = root; this.runtimePath = join(root, 'runtime.json');
    this.backupPath = join(root, 'runtime.backup.json'); this.lockDir = join(root, 'state.lock');
  }

  /**
   * R01/S07/C02: inicializa SOMENTE estado realmente novo (ambos os arquivos ausentes).
   * Principal corrompido + backup válido (ou ambos corrompidos) => lança, nunca cria vazio.
   * Não recupera nem altera nada: recuperação é explícita via recoverBackup().
   * C02: todo candidato lido tem identidade conferida com o projectId esperado (opção ou
   * parâmetro); runtime íntegro de outro projeto é recusado com ProjectIdentityError.
   */
  async init(projectId = this.options.projectId ?? randomUUID()): Promise<Runtime> {
    if (this.options.projectId && projectId !== this.options.projectId) {
      throw new ProjectIdentityError(this.options.projectId, projectId);
    }
    await fs.mkdir(this.root, { recursive: true });
    const main = await this.readCandidate(this.runtimePath);
    if (main) {
      this.assertProjectId(main, projectId);
      return main;
    }
    const mainExists = await this.exists(this.runtimePath);
    const backup = await this.readCandidate(this.backupPath);
    if (backup) {
      this.assertProjectId(backup, projectId);
      throw new StateCorruptError(mainExists
        ? 'runtime principal inválido; backup válido encontrado; recuperação explícita necessária (recover)'
        : 'runtime principal ausente; backup válido encontrado; recuperação explícita necessária (recover)');
    }
    if (mainExists) throw new StateCorruptError('runtime.json e backup ausentes ou inválidos; recuse-se a criar vazio sobre corrupção');
    const backupExists = await this.exists(this.backupPath);
    if (backupExists) throw new StateCorruptError('runtime.json ausente e backup inválido; recuse-se a criar vazio sobre corrupção');
    const release = await this.acquireLock();
    try {
      // Re-checar sob lock: outra operação pode ter criado enquanto aguardávamos.
      if (await this.exists(this.runtimePath)) {
        const raced = await this.readCandidate(this.runtimePath);
        if (raced) {
          this.assertProjectId(raced, projectId);
          return raced;
        }
        throw new StateCorruptError('runtime principal inválido; recuperação explícita necessária (recover)');
      }
      const state = emptyRuntime(projectId);
      await this.writeUnlocked(state);
      return state;
    } finally { await release(); }
  }

  /** C02: leitura valida identidade quando o store tem projectId esperado. */
  async read(): Promise<Runtime> {
    return this.readUnlocked();
  }

  /**
   * R02: recuperação explícita. Nunca sobrescreve backup válido com principal
   * corrompido: o backup é copiado para o principal sem passar pelo ciclo de
   * backup (que preservaria o principal corrompido). Roda sob lock.
   * C02: backup de outro projeto é recusado com ProjectIdentityError.
   */
  async recoverBackup(): Promise<Runtime> {
    const release = await this.acquireLock();
    try {
      const state = await this.readCandidate(this.backupPath);
      if (!state) throw new StateCorruptError('backup inválido ou ausente; nada a recuperar');
      await this.writeMainOnly(state);
      return state;
    } finally { await release(); }
  }

  /**
   * R02/S13/C02/R4-02: gravação transacional central com revisão monotônica imposta
   * pelo store e CAS OBRIGATÓRIO:
   * - expectedRevision é PARAMETRO OBRIGATÓRIO: deve ser igual à revisão persistida
   *   lida sob lock. Snapshot antigo renumerado (rev0 relabelado para rev2 depois de
   *   rev1) não conhece a revisão vigente e é RECUSADO — write sem revisão-base
   *   confiável é impossível (R4-02).
   * - snapshot.revision DEVE ser persisted.revision + 1 (sucessora estrita).
   * - Nada persistido => somente expectedRevision 0 + revisão 0 (primeira gravação;
   *   erro de leitura jamais é tratado como "projeto novo").
   * - Principal inválido/ausente com backup válido => StateCorruptError; recuperação é
   *   explícita (recoverBackup), nunca silenciosa dentro do write.
   * Comparação (CAS) e persistência ocorrem SOB O MESMO LOCK. Falha de
   * write/flush/rename/backup propaga — nunca produz sucesso.
   * C02: identidade do snapshot conferida com o projectId esperado e com o persistido.
   */
  async write(state: Runtime, expectedRevision: number): Promise<Runtime> {
    validateRuntime(state);
    this.assertIdentity(state);
    const release = await this.acquireLock();
    try {
      const persisted = await this.readCandidate(this.runtimePath);
      const mainExists = await this.exists(this.runtimePath);
      if (!persisted) {
        if (mainExists || (await this.readCandidate(this.backupPath)) || (await this.exists(this.backupPath))) {
          throw new StateCorruptError('runtime principal/backup inválido; recuperação explícita necessária (recover) antes de gravar');
        }
        if (state.revision !== 0 || expectedRevision !== 0) {
          throw new StateConflictError(`nenhum estado persistido; somente revisão 0 com expectedRevision 0 é aceita (recebida revisão ${state.revision}, expectedRevision ${expectedRevision})`);
        }
      } else {
        if (state.projectId !== persisted.projectId) {
          throw new StateConflictError(`projectId do snapshot (${state.projectId}) diverge do persistido (${persisted.projectId})`);
        }
        if (expectedRevision !== persisted.revision) {
          throw new StateConflictError(`revisão esperada ${expectedRevision}, persistida ${persisted.revision}; snapshot baseado em leitura obsoleta (R4-02)`);
        }
        if (state.revision !== persisted.revision + 1) {
          throw new StateConflictError(`revisão deve ser sucessora da persistida: snapshot ${state.revision}, exigida ${persisted.revision + 1}`);
        }
      }
      await this.writeUnlocked(state);
      return state;
    } finally { await release(); }
  }

  /**
   * C02/S13/R4-02: o store é dono da revisão. mutate SEMPRE grava revision = persistido + 1,
   * derivado do estado lido sob lock — nunca de revisão arbitrária do chamador.
   * Identidade conferida antes (estado persistido) e depois (resultado da fn).
   * R4-02: mutação sem mudança efetiva é IDEMPOTENTE — não grava nem infla a revisão.
   */
  async mutate<T>(fn: (state: Runtime) => Promise<{ state: Runtime; result: T }> | { state: Runtime; result: T }): Promise<T> {
    const release = await this.acquireLock();
    try {
      const current = await this.readUnlocked();
      const next = await fn(structuredClone(current));
      validateRuntime(next.state);
      this.assertIdentity(next.state);
      if (next.state.projectId !== current.projectId) {
        throw new StateCorruptError('mutação trocou projectId; isolamento entre projetos violado');
      }
      // Idempotência: compara o conteúdo sem a revisão (a sucessora é imposta pelo store).
      const stripRevision = (s: Runtime): Omit<Runtime, 'revision'> => { const { revision: _omit, ...rest } = s; return rest; };
      if (JSON.stringify(stripRevision(next.state)) !== JSON.stringify(stripRevision(current))) {
        next.state.revision = current.revision + 1;
        await this.writeUnlocked(next.state);
      }
      return next.result;
    } finally { await release(); }
  }

  /**
   * C02: leitura de candidato. Ausente (ENOENT) ou inválido => undefined (o chamador
   * decide entre criar e exigir recuperação). Falha de leitura/permissão => erro
   * explícito (nunca "ausente", nunca "projeto novo"). Identidade divergente =>
   * ProjectIdentityError explícito.
   * R4-03/decisão M0-F2 nº7: candidato em schemaVersion 1 dispara migração explícita
   * na carga — cópia de backup ANTES de qualquer transformação, evidência marcada
   * provenance 'legacy' SEM inventar runId/revisão/timestamp. Migração validada:
   * conteúdo que não satisfaz o schema atual é tratado como inválido (erro
   * explicativo no chamador), nunca reparado silenciosamente.
   */
  private async readCandidate(path: string): Promise<Runtime | undefined> {
    let raw: string;
    // Leitura concorrente com o `rename` do escritor no Windows falha de forma TRANSITÓRIA (EPERM/EBUSY/EACCES enquanto o
    // destino é substituído): retry delimitado, como no rename (causa dos flakes de leitura observados na suíte). Qualquer
    // outro erro — ou o esgotamento das tentativas — segue como falha explícita (nunca "ausente").
    for (let attempt = 1; ; attempt++) {
      try { raw = await fs.readFile(path, 'utf8'); break; }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return undefined;
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!transient || attempt >= READ_MAX_ATTEMPTS) {
          throw new StateCorruptError(`falha de leitura em ${path} (${code ?? 'desconhecido'}); permissão/IO não equivale a estado ausente`);
        }
        await delay(READ_RETRY_DELAY_MS);
      }
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return undefined; }
    if (isLegacySchemaV1(parsed)) {
      await this.backupLegacyFile(path, raw);
      parsed = migrateLegacyRuntime(parsed);
    }
    let state: Runtime;
    try { state = validateRuntime(parsed); }
    catch { return undefined; }
    this.assertIdentity(state);
    return state;
  }

  /** Decisão M0-F2 nº7: preserva o arquivo v1 intacto antes da primeira migração (idempotente). */
  private async backupLegacyFile(path: string, originalRaw: string): Promise<void> {
    const backup = `${path}.v1-backup`;
    const temp = `${path}.${randomUUID()}.tmp`;
    await lockTestHooks.beforeLegacyBackup?.();
    try {
      // Publica apenas depois de escrever e sincronizar todos os bytes. O hard link
      // cria o nome definitivo de forma atômica e nunca substitui o primeiro backup.
      await fs.writeFile(temp, originalRaw, { encoding: 'utf8', flag: 'wx' });
      const handle = await fs.open(temp, 'r');
      try { await handle.sync().catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }); }
      finally { await handle.close(); }
      try { await fs.link(temp, backup); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const existing = await fs.readFile(backup, 'utf8').catch(() => undefined);
        if (existing === originalRaw) return;
        throw new StateCorruptError(`backup pré-migração existente em ${backup} é inválido ou não corresponde ao snapshot v1 original; migração recusada`);
      }
    } catch (e) {
      if (e instanceof StateCorruptError) throw e;
      throw new StateCorruptError(`falha ao copiar backup pré-migração (${path}.v1-backup): ${(e as Error).message}; migração abortada sem alterar o original`);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  }

  /** Lê principal, senão backup válido; nunca cria vazio sobre corrupção. Chamadores já detêm o lock ou são leituras sem mutação. */
  private async readUnlocked(): Promise<Runtime> {
    const main = await this.readCandidate(this.runtimePath);
    if (main) return main;
    const backup = await this.readCandidate(this.backupPath);
    if (backup) throw new StateCorruptError('runtime principal inválido; backup válido encontrado; recuperação explícita necessária (recover)');
    throw new StateCorruptError('runtime.json e backup ausentes ou inválidos');
  }

  private assertIdentity(state: Runtime): void {
    if (this.options.projectId && state.projectId !== this.options.projectId) {
      throw new ProjectIdentityError(this.options.projectId, state.projectId);
    }
  }

  private assertProjectId(state: Runtime, expected: string): void {
    if (state.projectId !== expected) {
      throw new ProjectIdentityError(expected, state.projectId);
    }
  }

  private async exists(path: string): Promise<boolean> {
    try { await fs.stat(path); return true; }
    catch { return false; }
  }

  /**
   * C02.4: substituição atômica com retry limitado. Causa investigada no Windows:
   * EPERM/EACCES/EBUSY intermitente em rename quando um handle transitório
   * (antivírus/indexador de busca) segura o arquivo recém-escrito ou o destino.
   * Retry DELIMITADO (3 tentativas, 20 ms) e restrito a esses códigos; qualquer
   * outra falha propaga. Invariantes preservadas: backup válido já foi gravado,
   * temporário intacto até o sucesso, nenhuma revisão é gravada sem intenção
   * persistida — em falha final, principal e backup permanecem como estavam.
   */
  private async renameWithBoundedRetry(temp: string, target: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { await fs.rename(temp, target); return; }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!transient || attempt >= RENAME_MAX_ATTEMPTS) throw e;
        await delay(RENAME_RETRY_DELAY_MS);
      }
    }
  }

  /**
   * Ciclo transacional presumindo lock detido: valida, escreve temporário,
   * fsync (EPERM tolerado: no Windows fsync pode falhar em volumes sem suporte;
   * o dado já passou pelo WriteFile do SO), preserva backup (copia principal
   * somente se válido) e renomeia. Em falha, pelo menos uma versão íntegra permanece.
   */
  private async writeUnlocked(state: Runtime): Promise<void> {
    validateRuntime(state);
    this.assertIdentity(state);
    await fs.mkdir(this.root, { recursive: true });
    const data = JSON.stringify(state, null, 2) + '\n';
    const temp = `${this.runtimePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, data, 'utf8');
      const handle = await fs.open(temp, 'r+');
      try { await handle.sync().catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }); }
      finally { await handle.close(); }
      // Preserva backup: copia o principal atual somente se for válido.
      // Principal corrompido/ausente nunca sobrescreve um backup íntegro (R02).
      const currentMain = await this.readCandidate(this.runtimePath);
      if (currentMain) {
        try { await fs.copyFile(this.runtimePath, this.backupPath); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      } else if (!(await this.exists(this.backupPath))) {
        // Primeira gravação: sem principal válido nem backup — semeia backup íntegro.
        await fs.writeFile(this.backupPath, data, 'utf8');
      }
      await lockTestHooks.beforeRuntimeRename?.(temp);
      await this.renameWithBoundedRetry(temp, this.runtimePath);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  }

  /** Usado só por recoverBackup: restaura o principal sem tocar no backup. */
  private async writeMainOnly(state: Runtime): Promise<void> {
    validateRuntime(state);
    this.assertIdentity(state);
    await fs.mkdir(this.root, { recursive: true });
    const data = JSON.stringify(state, null, 2) + '\n';
    const temp = `${this.runtimePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, data, 'utf8');
      const handle = await fs.open(temp, 'r+');
      try { await handle.sync().catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }); }
      finally { await handle.close(); }
      await this.renameWithBoundedRetry(temp, this.runtimePath);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  }

  /**
   * R5-01/R5-02 — Exclusão mútua por PRIMITIVA DO SISTEMA OPERACIONAL.
   *
   * O protocolo da rodada 4 (state.lock + state.lock.manager + state.lock.recover,
   * mkdir atômico + owner.json + liveness por PID/nascimento) decidia REMOVER um
   * diretório a partir de uma observação anterior. Isso não é condicional nem
   * atômico: entre a observação e o `rm` outro processo pode virar detentor vivo e
   * ter o lock apagado (R5-01 no manager, R5-02 na recuperação explícita). Segunda
   * leitura de token, sleep, TTL e rename apenas estreitam a janela — ver a
   * reprodução determinística em docs/validation/round-5/m1-race-red.log.
   *
   * AUTORIDADE ÚNICA no Windows: handle exclusivo do libuv sobre
   * `state.authority.lock` no root canônico. UV_FS_O_EXLOCK abre com share mode 0:
   * outro processo recebe EBUSY enquanto o handle vive, e o SO fecha o handle na
   * morte do processo sem PID, TTL ou remoção do arquivo.
   * Named pipe não serve como mutex: tempestades de connect() podem tornar o nome
   * reutilizável enquanto o servidor original ainda está vivo.
   *
   * Consequências: nenhum passo remove artefato alheio; não existe lock-arquivo
   * capaz de ficar órfão; não existe recuperação automática (nada a recuperar);
   * sem TTL, sem heartbeat, sem sonda de PID. TODAS as entradas (init, write,
   * mutate, recoverBackup, recoverStaleLocks) passam por aqui.
   */
  private async acquireLock(): Promise<() => Promise<void>> {
    const name = await this.authorityName();
    const wait = this.options.lockWaitMs ?? 5_000;
    const releaseAuthority = process.platform === 'win32'
      ? await this.acquireWindowsFileAuthority(name, wait)
      : await this.acquireSocketAuthority(name, wait);
    const mine = this.newLockInfo();
    await lockTestHooks.afterAuthorityAcquired?.();
    // Informação de diagnóstico. Falha aqui NÃO derruba a exclusão (que já é do SO):
    // o pior caso é um `lockStatus()` sem `info`.
    await fs.mkdir(this.lockDir, { recursive: true }).catch(() => undefined);
    await fs.writeFile(join(this.lockDir, 'owner.json'), JSON.stringify(mine), 'utf8').catch(() => undefined);
    await lockTestHooks.afterLockAcquired?.(mine);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await lockTestHooks.beforeRelease?.();
      try {
        // Liberação tardia (o pipe já caiu e outro já entrou): o token difere e a
        // informação do detentor atual é preservada. Nunca removemos a de outro.
        const current = await this.readLockInfo();
        if (current && current.token === mine.token) {
          await fs.rm(this.lockDir, { recursive: true, force: true }).catch(() => undefined);
        }
      } finally {
        await releaseAuthority();
      }
    };
  }

  /**
   * Chave canônica do projeto -> nome da primitiva de exclusão.
   * mkdir recursivo (realpath exige o diretório) + realpath.native (normaliza caixa,
   * `/` vs `\`, barra final, barras duplicadas e junctions) + minúsculas no win32 +
   * sha256. Projetos distintos nunca colidem; caminhos equivalentes do mesmo projeto
   * sempre coincidem. Falha de canonicalização é FECHADA (jamais cai para o caminho
   * bruto, que quebraria a equivalência).
   */
  private async authorityName(createRoot = true): Promise<string> {
    // lockStatus() (doctor) passa false: sonda SOMENTE LEITURA nunca cria a raiz nem seus pais (revisão A/F1).
    if (createRoot) await fs.mkdir(this.root, { recursive: true });
    let canonical: string;
    try { canonical = await realpathNative(this.root); }
    catch (e) {
      throw new StateConflictError(`não foi possível canonicalizar a raiz do estado (${this.root}): ${(e as Error).message}; aquisição recusada`);
    }
    if (process.platform === 'win32') return join(canonical.toLowerCase(), 'state.authority.lock');
    const key = createHash('sha256').update(canonical).digest('hex');
    const id = `sdlc-codex-state-${key}`;
    // Socket unix abstrato: mesma semântica de liberação por morte do processo.
    // NÃO verificado nesta máquina (ver limites em m1-lock-protocol.md).
    if (process.platform === 'linux') return `\0${id}`;
    throw new StateConflictError(`plataforma sem primitiva de exclusão verificada (${process.platform}); operação de estado recusada`);
  }

  /**
   * Tenta virar detentor. `undefined` = ocupado (EADDRINUSE). Qualquer outro erro
   * PROPAGA (fail closed): não tratamos falha desconhecida como "livre".
   * O servidor destrói toda conexão recebida — a sonda de lockStatus() nunca trava
   * nem perturba o detentor. `unref()` impede que o lock segure o event loop.
   */
  private tryListen(name: string): Promise<Server | undefined> {
    return new Promise<Server | undefined>((resolve, reject) => {
      const server = createServer(socket => socket.destroy());
      const onError = (e: NodeJS.ErrnoException): void => {
        server.close(() => undefined);
        if (e.code === 'EADDRINUSE') resolve(undefined); else reject(e);
      };
      server.once('error', onError);
      server.listen(name, () => {
        server.removeListener('error', onError);
        server.unref();
        resolve(server);
      });
    });
  }

  /** Mantém o socket abstrato nas plataformas onde essa primitiva foi escolhida. */
  private async acquireSocketAuthority(name: string, wait: number): Promise<() => Promise<void>> {
    const started = Date.now();
    let server = await this.tryListen(name);
    while (!server) {
      if (Date.now() - started >= wait) {
        throw new StateConflictError(
          `exclusão do projeto detida por outro detentor há mais de ${wait} ms (${name}); nenhum arquivo de estado foi lido, gravado nem removido`,
        );
      }
      await delay(25);
      server = await this.tryListen(name);
    }
    return () => new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async tryWindowsFileAuthority(path: string, create: boolean): Promise<FileHandle | undefined> {
    const flags = WINDOWS_EXCLUSIVE_LOCK | fsConstants.O_RDWR | (create ? fsConstants.O_CREAT : 0);
    try { return await fs.open(path, flags, 0o600); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EBUSY') return undefined;
      if (!create && code === 'ENOENT') return undefined;
      throw e;
    }
  }

  private async acquireWindowsFileAuthority(path: string, wait: number): Promise<() => Promise<void>> {
    const started = Date.now();
    let handle = await this.tryWindowsFileAuthority(path, true);
    while (!handle) {
      if (Date.now() - started >= wait) {
        throw new StateConflictError(
          `exclusão do projeto detida por outro detentor há mais de ${wait} ms (${path}); nenhum arquivo de estado foi lido, gravado nem removido`,
        );
      }
      await delay(25);
      handle = await this.tryWindowsFileAuthority(path, true);
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await handle.close();
    };
  }

  private newLockInfo(): LockInfo {
    return {
      pid: process.pid,
      processStartMs: Date.now() - Math.round(process.uptime() * 1000),
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
  }

  /** Leitura da INFORMAÇÃO do detentor. Nunca decide nada (ver LockInfo). */
  private async readLockInfo(): Promise<LockInfo | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(join(this.lockDir, 'owner.json'), 'utf8')) as Partial<LockInfo>;
      if (!Number.isInteger(raw.pid) || typeof raw.token !== 'string' || !raw.token.length
        || typeof raw.processStartMs !== 'number' || typeof raw.acquiredAt !== 'string') return undefined;
      return raw as LockInfo;
    } catch { return undefined; }
  }

  /**
   * R5-01/R5-02 — Sonda SOMENTE LEITURA da autoridade (usada pelo doctor).
   * Nunca remove nem escreve. No Windows, tenta WaitOne(0) e libera imediatamente
   * quando livre; ocupado significa detentor ativo. Qualquer falha => 'unknown'.
   */
  async lockStatus(): Promise<LockStatus> {
    // Raiz inexistente: ninguém pode deter a exclusão e não há o que listar — e a sonda NÃO a cria.
    if (!(await this.exists(this.root))) return { held: 'no', leftovers: [] };
    let held: LockStatus['held'];
    try { held = await this.probeAuthority(await this.authorityName(false)); }
    catch { held = 'unknown'; }
    const info = await this.readLockInfo();
    const leftovers = await this.listLeftovers(held === 'yes');
    return { held, ...(info ? { info } : {}), leftovers };
  }

  private probeAuthority(name: string): Promise<LockStatus['held']> {
    if (process.platform === 'win32') return this.probeWindowsFileAuthority(name);
    return new Promise<LockStatus['held']>(resolve => {
      const socket = connect(name);
      const finish = (verdict: LockStatus['held']): void => { socket.destroy(); resolve(verdict); };
      socket.once('connect', () => finish('yes'));
      socket.once('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' ? 'no' : 'unknown'));
    });
  }

  private async probeWindowsFileAuthority(path: string): Promise<LockStatus['held']> {
    const existed = await this.exists(path);
    if (!existed) return 'no';
    const handle = await this.tryWindowsFileAuthority(path, false);
    if (!handle) return 'yes';
    await handle.close();
    return 'no';
  }

  /**
   * Artefatos INERTES que sobraram (nenhum deles tem papel no protocolo):
   * diretórios de lock da rodada 4 e temporários órfãos do ciclo transacional.
   * `state.lock` só é lixo quando ninguém detém a autoridade.
   */
  private async listLeftovers(authorityHeld: boolean): Promise<string[]> {
    const found: string[] = [];
    for (const name of LEGACY_LOCK_DIRS) {
      if (await this.exists(join(this.root, name))) found.push(name);
    }
    if (!authorityHeld && await this.exists(this.lockDir)) found.push('state.lock');
    const entries = await fs.readdir(this.root).catch(() => [] as string[]);
    for (const entry of entries) if (ORPHAN_TEMP.test(entry)) found.push(entry);
    return found.sort();
  }

  /**
   * R5-02 — Limpeza explícita de artefatos inertes, SOB A MESMA AUTORIDADE das
   * demais operações (nada de marcador próprio, que a aquisição normal ignorava).
   * Detentor vivo => espera; estouro do lockWaitMs => StateConflictError SEM tocar
   * em nada. Não "destrava" detentor vivo e não é recuperação concorrente: é
   * remoção de lixo cosmético com a exclusão real detida.
   * `state.lock` não entra na lista: ao adquirir, a informação já foi sobrescrita
   * por este processo e o release a remove.
   */
  async recoverStaleLocks(): Promise<StaleLockCleanup> {
    const release = await this.acquireLock();
    try {
      const leftovers = await this.listLeftovers(true);
      await lockTestHooks.afterLeftoversObserved?.(leftovers);
      const removed: string[] = [];
      for (const name of leftovers) {
        await fs.rm(join(this.root, name), { recursive: true, force: true });
        removed.push(name);
      }
      return { removed };
    } finally { await release(); }
  }
}
