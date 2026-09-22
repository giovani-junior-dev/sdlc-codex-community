import type { QueueReceipt } from '../contracts.js';
import type { ProcessRunner, ProcessResult } from './process.js';

export interface QueueOutcome { status: 'enqueued' | 'uncertain' | 'failed'; receipt?: QueueReceipt; result: ProcessResult; reason?: string; }

/**
 * R08 — transporte Codex.
 * Contrato verificado na instalação (codex-cli 0.155.0, `codex queue --help`):
 *   codex queue --thread <UUID|nome> --message <TEXT>
 * Confirmações reconhecidas:
 * - JSON estruturado {threadId, nativeMessageId, status accepted|enqueued|queued};
 * - receipt textual observado: "Queued message <message-id> for thread <thread-id>."
 * Exit 0 sem confirmação reconhecida => `uncertain`, nunca certeza.
 * Exit != 0 ou falha de spawn => `failed`. Timeout => SEMPRE `uncertain`
 * (desfecho desconhecido; a mensagem pode ter sido enfileirada — retry cego
 * deduplica pelo message ID, nunca por presunção de falha).
 */
const TEXTUAL_RECEIPT = /queued\s+message\s+([A-Za-z0-9_.:+-]+)\s+for\s+thread\s+([A-Za-z0-9_.:+-]+)/i;

export function parseQueueReceipt(threadId: string, stdout: string): QueueReceipt | undefined {
  const text = stdout.trim();
  if (text) {
    try {
      const parsed = JSON.parse(text) as { threadId?: string; nativeMessageId?: string; status?: string };
      if (parsed?.threadId === threadId && parsed.nativeMessageId &&
        ['accepted', 'enqueued', 'queued'].includes(parsed.status ?? '')) {
        return { threadId: parsed.threadId, nativeMessageId: parsed.nativeMessageId };
      }
    } catch { /* tenta formato textual */ }
    const m = TEXTUAL_RECEIPT.exec(text);
    if (m) {
      const nativeMessageId = m[1].replace(/\.+$/, '');
      const receiptThread = m[2].replace(/\.+$/, '');
      if (receiptThread === threadId && nativeMessageId) return { threadId, nativeMessageId };
    }
  }
  return undefined;
}

export class CodexTransport {
  constructor(private readonly runner: ProcessRunner, private readonly executable = 'codex') {}
  async queue(threadId: string, message: string, timeoutMs = 30_000): Promise<QueueOutcome> {
    if (!threadId) return {
      status: 'failed', reason: 'threadId vazio; UUID nunca é inferido do nome',
      result: { exitCode: null, stdout: '', stderr: 'threadId vazio', timedOut: false, acceptedBeforeTimeout: false },
    };
    let result: ProcessResult;
    try {
      // Argumentos estruturados: corpo via --message como dado, nunca interpolado em shell.
      result = await this.runner.run(this.executable, ['queue', '--thread', threadId, '--message', message], { timeoutMs });
    } catch (error) {
      // Spawn failure (ENOENT etc.): indisponibilidade do executável — NUNCA vira enqueued.
      return { status: 'failed', reason: `falha ao iniciar processo: ${(error as Error).message}`, result: { exitCode: null, stdout: '', stderr: String(error), timedOut: false, acceptedBeforeTimeout: false } };
    }
    // M2-F2/R4-10 — evidência de aceitação ESTRITA, no formato real do receipt
    // (nada da heurística solta /accept/i do runner): um receipt só conta se
    // corresponder ao threadId E carregar nativeMessageId com status de aceite.
    const acceptedEvidence = parseQueueReceipt(threadId, result.stdout) !== undefined;
    if (result.timedOut) {
      // Timeout = desfecho desconhecido (processo morto; a mensagem PODE ter
      // sido enfileirada). Sempre uncertain — nunca failed que induziria retry
      // cego, e nunca enqueued sem receipt completo.
      return acceptedEvidence
        ? { status: 'uncertain', result, reason: 'timeout após receipt de aceitação observado na saída; reenvio deduplica pelo message ID' }
        : { status: 'uncertain', result, reason: 'timeout sem receipt confirmado; desfecho desconhecido, sem retry automático' };
    }
    if (result.exitCode !== 0) return { status: 'failed', result, reason: `exit não-zero (${result.exitCode})` };
    const receipt = parseQueueReceipt(threadId, result.stdout);
    if (!receipt) return { status: 'uncertain', result, reason: 'exit 0 sem receipt reconhecido; confirmação ambígua, não é sucesso' };
    return { status: 'enqueued', result, receipt };
  }
  async probe(args: string[] = ['--version']): Promise<ProcessResult> {
    return this.runner.run(this.executable, args, { timeoutMs: 10_000 });
  }
  /** Sonda de capacidades usada pelo doctor: queue disponível? (daemon é diagnóstico separado). */
  async probeCapabilities(): Promise<{ version: ProcessResult; queueHelp: ProcessResult }> {
    const version = await this.probe(['--version']);
    const queueHelp = await this.probe(['queue', '--help']);
    return { version, queueHelp };
  }
}
