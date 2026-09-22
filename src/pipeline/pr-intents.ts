import type { PrIntent, Runtime } from '../contracts.js';

/**
 * M6-F2 (R4-04, decisão M0-F2 nº6) + R5-08/M4-F1 — ledger de intenções de PR.
 *
 * O Runtime (contracts.ts, congelado) não possui campo dedicado a intenções; o
 * ledger vive em `events` estruturado (kind 'pr-intent-reserved'/'pr-intent-updated',
 * detail = PrIntent serializado em JSON). É o caminho proposto no plano em vez de
 * alterar contracts.ts; uma evolução natural de contrato seria `runs[].prIntents`.
 *
 * Protocolo:
 * - 'pr-intent-reserved': intenção AUTORIZADA persistida sob lock, ANTES de
 *   qualquer chamada de rede; o lock é liberado antes do efeito externo.
 * - 'pr-intent-updated': resultado do efeito ('executed'|'uncertain'|'conflict'|
 *   'confirmed') — gravado após a rede, e novamente com a transição.
 * - A chave idempotente é operationId (= intentId): reconciliação por
 *   repo/base/branch/commit na reexecução após crash.
 *
 * R5-08 — REDUÇÃO ANTES DE CLASSIFICAR: os eventos formam um histórico por
 * operationId; o estado de cada operação é a ÚLTIMA versão válida (reserved →
 * executed → confirmed resulta `confirmed`, nunca `executed`). Só depois da
 * redução se decide o que é "ativo". Eventos inválidos ou transições fora de
 * ordem NÃO são ignorados (ignorar autorizaria nova publicação): falham fechado
 * com PrLedgerError e diagnóstico.
 *
 * Bloqueio de novos efeitos (mesma execução, OUTRA operação): qualquer intenção
 * não `confirmed` — reserved, executed, uncertain e conflict. `conflict`/`uncertain`
 * significam efeito externo possivelmente ocorrido e NÃO reconciliado; nunca
 * autorizam nova PR sozinhos. Reconciliação que encerra a pendência: leitura
 * somente-leitura da PR (identidade estável + head) que comprova o efeito →
 * `confirmed` (ver reconcileByObservation no cli); ausência observada mantém o
 * bloqueio até verificação humana.
 */

export const PR_INTENT_RESERVED = 'pr-intent-reserved';
export const PR_INTENT_UPDATED = 'pr-intent-updated';

export class PrLedgerError extends Error {
  constructor(message: string) { super(`ledger de PR inválido: ${message}`); this.name = 'PrLedgerError'; }
}

export const PR_INTENT_STATUSES: readonly PrIntent['status'][] = ['reserved', 'executed', 'confirmed', 'uncertain', 'conflict'];

/** Transições permitidas (de → para). `reserved → reserved` é a re-reserva após crash do reservador. */
const TRANSITIONS: Record<PrIntent['status'], readonly PrIntent['status'][]> = {
  reserved: ['reserved', 'executed', 'uncertain', 'conflict'],
  executed: ['confirmed', 'conflict'],
  uncertain: ['confirmed', 'conflict'],
  confirmed: ['confirmed'],
  conflict: ['conflict', 'confirmed'],
};

/** Estados que NÃO bloqueiam novos efeitos da execução. */
const NON_BLOCKING: readonly PrIntent['status'][] = ['confirmed'];

function parseIntent(event: { kind: string; detail: string }, index: number): PrIntent {
  let parsed: unknown;
  try { parsed = JSON.parse(event.detail); }
  catch { throw new PrLedgerError(`evento #${index} (${event.kind}) com JSON inválido`); }
  const p = parsed as Partial<PrIntent> | null;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!p || typeof p !== 'object' || !str(p.operationId) || !str(p.runId) || !str(p.repo) || !str(p.base) || !str(p.branch) || !str(p.headCommit)) {
    throw new PrLedgerError(`evento #${index} (${event.kind}) sem operationId/runId/repo/base/branch/headCommit`);
  }
  if (!p.status || !(PR_INTENT_STATUSES as readonly string[]).includes(p.status)) {
    throw new PrLedgerError(`evento #${index} (${event.kind}) com status inválido '${String(p.status)}'`);
  }
  if (event.kind === PR_INTENT_RESERVED && p.status !== 'reserved') {
    throw new PrLedgerError(`evento #${index} '${PR_INTENT_RESERVED}' com status '${p.status}' (esperado reserved)`);
  }
  return p as PrIntent;
}

/**
 * Reduz TODOS os eventos de intenção à última versão por operationId, validando a
 * estrutura, a identidade imutável (run/repo/base/branch/commit) e a ordem das
 * transições. Eventos de outros tipos (não-PR) são ignorados; eventos de PR
 * inválidos lançam PrLedgerError.
 */
export function reducePrIntents(state: Runtime): Map<string, PrIntent> {
  const latest = new Map<string, PrIntent>();
  state.events.forEach((event, index) => {
    if (event.kind !== PR_INTENT_RESERVED && event.kind !== PR_INTENT_UPDATED) return;
    const intent = parseIntent(event, index);
    const prev = latest.get(intent.operationId);
    if (!prev) {
      if (event.kind !== PR_INTENT_RESERVED) throw new PrLedgerError(`operação ${intent.operationId}: '${PR_INTENT_UPDATED}' sem reserva anterior (evento #${index})`);
    } else {
      if (!TRANSITIONS[prev.status].includes(intent.status)) {
        throw new PrLedgerError(`operação ${intent.operationId}: transição inválida ${prev.status} → ${intent.status} (evento #${index})`);
      }
      if (prev.runId !== intent.runId || prev.repo !== intent.repo || prev.base !== intent.base || prev.branch !== intent.branch || prev.headCommit !== intent.headCommit) {
        throw new PrLedgerError(`operação ${intent.operationId}: identidade (run/repo/base/branch/commit) alterada entre eventos (evento #${index})`);
      }
    }
    latest.set(intent.operationId, intent);
  });
  return latest;
}

/** Última versão da intenção de PR para um operationId (undefined quando nenhuma). */
export function latestPrIntent(state: Runtime, operationId: string): PrIntent | undefined {
  return reducePrIntents(state).get(operationId);
}

/**
 * Intenções que BLOQUEIAM novo efeito externo na execução: última versão de cada
 * OUTRA operação com status não `confirmed` (reserved/executed/uncertain/conflict).
 */
export function blockingPrIntents(state: Runtime, runId: string, excludeOperationId?: string): PrIntent[] {
  return [...reducePrIntents(state).values()].filter(intent =>
    intent.runId === runId && intent.operationId !== excludeOperationId && !NON_BLOCKING.includes(intent.status));
}

/** Compatibilidade: primeira intenção bloqueante da execução (undefined quando nenhuma). */
export function findActivePrIntent(state: Runtime, runId: string, excludeOperationId?: string): PrIntent | undefined {
  return blockingPrIntents(state, runId, excludeOperationId)[0];
}

/** Novo estado com o evento de intenção anexado (usado dentro de store.mutate). Valida a transição. */
export function appendPrIntent(state: Runtime, intent: PrIntent, kind: string): Runtime {
  const next: Runtime = { ...state, events: [...state.events, { at: new Date().toISOString(), kind, detail: JSON.stringify(intent) }] };
  reducePrIntents(next); // falha fechada: nunca grava transição inválida
  return next;
}
