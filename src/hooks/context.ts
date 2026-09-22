import type { Role, Runtime } from '../contracts.js';

/**
 * C06/R14 — contexto mínimo por papel: persona + geração VIGENTE + demanda ativa
 * + referências e checkpoints. Referencia artefatos (nunca injeta histórico
 * inteiro); retomada/compactação reconstrói referências pelos paths.
 */
const RITUAL = 'Ritual: leia o envelope, execute receive, carregue só os artefatos citados, registre evidência, rode next/finish-message e encerre o turno.';
const QUESTION_RITUAL = 'Dúvida: salve checkpoint, envie pergunta correlacionada, encerre o turno; retome no checkpoint quando a resposta chegar. Sem busy-wait.';

export function roleContext(state: Runtime, role: Role, maxBytes = 6000): string {
  // C06: a geração VIGENTE é a sessão 'ready' atual — NUNCA a primeira geração
  // histórica do papel. Sem ready, usa a mais recente por lastEventAt e diz que
  // é apenas referência, não identidade operacional.
  const mine = state.sessions.filter(s => s.role === role);
  const current = mine.find(s => s.status === 'ready')
    ?? mine.slice().sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt))[0];
  const run = state.runs.find(r => r.status === 'running');
  const lines = [
    `Você é o papel ${role} no projeto ${state.projectId}. Persona: roles/${role}.md.`,
    current
      ? current.status === 'ready'
        ? `CWD: ${current.cwd}. Geração vigente: ${current.generationId}. Endereço técnico é o UUID da sessão.`
        : current.status === 'launching' && current.threadId
          ? // M5-F1/R4-11: SessionStart observado é UM dos dois fatos de prontidão —
            // a geração só vira operacional quando o launcher confirmar readiness Herdr.
            `CWD: ${current.cwd}. Geração ${current.generationId} com SessionStart registrado, aguardando confirmação de readiness (Herdr) — ainda NÃO é a vigente operacional.`
          : `CWD: ${current.cwd}. Última geração conhecida (${current.status}): ${current.generationId} — NÃO é a vigente; aguarde registro SessionStart.`
      : 'Sessão ainda não registrada; aguarde registro SessionStart.',
    RITUAL,
    QUESTION_RITUAL,
  ];
  if (run) {
    lines.push(`Demanda ${run.slug}: workflow ${run.workflow}, estágio ${run.stage}, revisão ${run.revision}, responsável ${run.owner ?? run.stage}.`);
    lines.push(`Artefatos: intent ${run.intentPath}; plano ${run.planPath}.`);
    const pending = state.deliveries.filter(d =>
      ['pending', 'uncertain'].includes(d.status) &&
      state.messages.find(m => m.messageId === d.messageId)?.to === role).length;
    if (pending) lines.push(`Entregas pendentes para você: ${pending}.`);
  }
  // C06: checkpoints da geração de entregas dirigidas a este papel.
  const checkpoints = state.deliveries
    .filter(d => !!d.checkpoint && ['pending', 'received', 'uncertain'].includes(d.status))
    .filter(d => state.messages.find(m => m.messageId === d.messageId)?.to === role)
    .map(d => d.checkpoint as string);
  if (checkpoints.length) lines.push(`Checkpoints pendentes: ${checkpoints.join('; ')}.`);
  const output = lines.join('\n');
  return output.length <= maxBytes ? output : output.slice(0, Math.max(0, maxBytes - 1)) + '…';
}
