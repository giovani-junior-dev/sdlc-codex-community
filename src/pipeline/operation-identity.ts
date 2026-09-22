import { createHash } from 'node:crypto';
import type { Actor, OperationIdentity, Stage } from '../contracts.js';

/**
 * M6-F1 (R4-07/R4-08, decisão M0-F2 nº2) — identidade semântica de uma operação
 * de conclusão de estágio. Mesmo operationId com payload canonicamente igual é
 * REPLAY legítimo (devolve o resultado anterior sem gravar nem enviar); mesmo
 * operationId com payload divergente é CONFLITO (sem gravação, sem envio).
 *
 * O payload cobre: projeto, execução (runId), estágio, operationId, revisão-base,
 * ator (papel/threadId/generationId/projectId) e o conteúdo do pedido (veredito,
 * parâmetros e hash do arquivo de evidências apresentado). A canonicalização é
 * determinística (chaves ordenadas, undefined omitidos), de modo que o hash não
 * depende da ordem de campos nem de JSON incidental.
 */

/** Conteúdo semântico do pedido — tudo que, alterado, torna a operação OUTRA operação. */
export interface OperationPayload {
  projectId: string;
  runId: string;
  stage: Stage;
  operationId: string;
  baseRevision: number;
  actor: Actor;
  /** Livre, mas canônico: { verdict, gapId, blockedReason, expectedCommit, evidenceFileHash }. */
  content: Record<string, unknown>;
}

/** JSON estável: objetos com chaves ordenadas lexicograficamente; undefined omitidos. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

/** sha256 do pedido canônico — o payloadHash gravado em OperationResult. */
export function computePayloadHash(payload: OperationPayload): string {
  return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
}

export function operationIdentityOf(payload: OperationPayload): OperationIdentity {
  return {
    projectId: payload.projectId,
    runId: payload.runId,
    stage: payload.stage,
    operationId: payload.operationId,
    baseRevision: payload.baseRevision,
    actor: payload.actor,
    payloadHash: computePayloadHash(payload),
  };
}

export function sameActor(a: Actor, b: Actor): boolean {
  return a.role === b.role && a.threadId === b.threadId && a.generationId === b.generationId &&
    (a.projectId ?? undefined) === (b.projectId ?? undefined);
}

/** Mesma identidade semântica: mesma operação, mesmo contexto, mesmo conteúdo. */
export function sameOperationIdentity(a: OperationIdentity, b: OperationIdentity): boolean {
  return a.projectId === b.projectId && a.runId === b.runId && a.stage === b.stage &&
    a.operationId === b.operationId && a.baseRevision === b.baseRevision &&
    a.payloadHash === b.payloadHash && sameActor(a.actor, b.actor);
}
