import { isRole, isStage, type Evidence, type RequirementsManifest, type RequirementVerdict, type Role, type Run, type Runtime, type Stage } from '../contracts.js';
import { stageOwner } from '../pipeline/workflows.js';
import { validateCheckExemptions } from './checks.js';

export interface EvidenceValidation { ok: boolean; errors: string[]; evidence: Evidence[]; }

const SHA256_RE = /^[0-9a-f]{64}$/i;
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** R5-07/M4-F2 — observação SOMENTE LEITURA da PR atual (gh pr view por identidade estável). */
export interface PrObservation {
  url: string; number?: number; state: string; base: string; branch: string; headSha: string; observedAt: string;
}

/**
 * R5-03/R5-05/M3-F3 — contexto de gate COMPLETO. O motor não faz IO, mas exige fatos
 * VERIFICADOS por quem chama: nenhum campo é opcional para o pass (o chamador não pode
 * omitir um fato obrigatório para desativar um requisito). Os campos condicionais por
 * estágio (pullRequest, commitRelation) são exigidos pelo próprio motor quando o estágio
 * os pede — ausência nesses estágios REPROVA, nunca dispensa.
 */
export interface EvidenceGateContext {
  /** Manifesto aprovado (conteúdo já validado contra o plano aprovado pelo chamador). */
  manifest: RequirementsManifest;
  /** sha256 do ARQUIVO do manifesto, recalculado pelo chamador; deve ser o hash gravado em run.approval. */
  manifestHash: string;
  /** Snapshot completo da árvore no instante da conclusão (evidências devem bater com ele). */
  currentSnapshot: { commit: string; diffFingerprint: string };
  /** Snapshot da árvore SEM as raízes documentais aprovadas (base de approvedSnapshot/fechamento). */
  currentCodeSnapshot: { commit: string; diffFingerprint: string };
  /** Seleção COMPLETA de checks do estágio (required/missing/exempt) — nunca só `required`. */
  checks: { required: string[]; missing: string[]; exempt: Array<{ check: string; reason: string }> };
  /** IDs de evidência cujo log (existência + hash) o chamador verificou em disco. */
  verifiedLogs: string[];
  /** pr-review e fechamento: PR observada agora (leitura externa). */
  pullRequest?: PrObservation;
  /** fechamento: relação do commit atual com o commit aprovado em pr-review. */
  commitRelation?: 'same' | 'docs-only-advance' | 'code-changed';
}

/** Validação estrutural do contexto (R5-03/M3-F3): ausência de qualquer fato obrigatório é erro. */
export function validateGateContext(gate: unknown): string[] {
  const errors: string[] = [];
  if (!gate || typeof gate !== 'object') return ['contexto de gate ausente; pass exige fatos verificados (manifesto, snapshot, checks, logs)'];
  const g = gate as Partial<EvidenceGateContext>;
  if (!g.manifest || typeof g.manifest !== 'object') errors.push('gate sem manifesto aprovado');
  else for (const err of validateRequirementsManifest(g.manifest)) errors.push(`manifesto: ${err}`);
  if (typeof g.manifestHash !== 'string' || !SHA256_RE.test(g.manifestHash)) errors.push('gate sem hash verificado do manifesto');
  for (const key of ['currentSnapshot', 'currentCodeSnapshot'] as const) {
    const s = g[key];
    if (!s || typeof s.commit !== 'string' || !s.commit || typeof s.diffFingerprint !== 'string' || !s.diffFingerprint) {
      errors.push(`gate sem ${key} válido (commit + diffFingerprint)`);
    }
  }
  if (!g.checks || !Array.isArray(g.checks.required) || !Array.isArray(g.checks.missing) || !Array.isArray(g.checks.exempt)) {
    errors.push('gate sem seleção completa de checks (required + missing + exempt)');
  }
  if (!Array.isArray(g.verifiedLogs)) errors.push('gate sem lista de logs verificados');
  return errors;
}

/**
 * C09 + R5 — regra única de validação de evidências para aprovação de etapa. Um `pass`
 * exige TODAS estas condições (o `gate` é OBRIGATÓRIO; sem ele nada passa):
 * 1. evidenceIds não vazio e todos os IDs existem no estado;
 * 2. result 'pass' E verdict 'pass';
 * 3. vinculada à execução corrente: projectId, runId, stage E revisão iguais aos do run;
 * 4. requirementId `slug:stage:<requisito>` exato;
 * 5. logPath + logHash e log VERIFICADO em disco pelo chamador (gate.verifiedLogs);
 * 6. rubrica por estágio ('review' exige file/line; 'e2e' exige procedure);
 * 7. commit igual ao esperado (HEAD verificado) e codeSnapshot IGUAL ao da árvore atual
 *    (commit + diffFingerprint) — HEAD igual não prova árvore igual;
 * 8. rubrica humana (não-check) traz produtor (papel proprietário do estágio + sessão);
 * 9. requisitos contra o manifesto aprovado: fora do plano, fora de estágio e
 *    obrigatórios sem cobertura reprovam; 'legacy' e importada-como-check-do-produto nunca valem.
 */
export function validateStageEvidence(
  state: Runtime, run: Run, stage: Stage, evidenceIds: string[], expectedCommit: string | undefined,
  gate: EvidenceGateContext,
): EvidenceValidation {
  const errors: string[] = [];
  if (!evidenceIds.length) errors.push('pass exige evidenceIds não vazio');
  const gateErrors = validateGateContext(gate);
  if (gateErrors.length) return { ok: false, errors: gateErrors, evidence: [] };
  const byId = new Map(state.evidence.map(e => [e.id, e]));
  const found: Evidence[] = [];
  const prefix = `${run.slug}:${stage}:`;
  const manifestIds = new Map<string, { stage: Stage | 'any'; mandatory: boolean }>();
  for (const entry of gate.manifest.entries) manifestIds.set(entry.id, entry);
  const verified = new Set(gate.verifiedLogs);
  const covered = new Set<string>();
  for (const eid of evidenceIds) {
    const e = byId.get(eid);
    if (!e) { errors.push(`evidência ${eid} não encontrada`); continue; }
    found.push(e);
    errors.push(...evidenceProvenanceErrors(e, state, run, stage, gate, verified, expectedCommit));
    if (e.result !== 'pass') errors.push(`evidência ${eid}: result ${e.result} não aprova`);
    if (e.verdict !== 'pass') errors.push(`evidência ${eid}: verdict ausente ou diferente de pass`);
    if (!e.requirementId.startsWith(prefix) || e.requirementId.length <= prefix.length) {
      errors.push(`evidência ${eid}: requirementId ${e.requirementId} não pertence a ${run.slug}:${stage}`);
    }
    if (stage === 'review' && (!e.file || e.line === undefined)) {
      errors.push(`evidência ${eid}: rubrica de review incompleta (file/line do achado)`);
    }
    if (stage === 'e2e' && !e.procedure?.trim()) {
      errors.push(`evidência ${eid}: rubrica de e2e incompleta (cenário/reprodução em procedure)`);
    }
    if (e.provenance === 'legacy') {
      errors.push(`evidência ${eid}: proveniência 'legacy' (migração v1) não satisfaz gate de requisito obrigatório`);
    }
    const suffix = e.requirementId.startsWith(prefix) ? e.requirementId.slice(prefix.length) : '';
    const isCheckEvidence = suffix.startsWith('check-') || e.check !== undefined;
    const claimsProductCheck =
      (e.check !== undefined && gate.checks.required.includes(e.check)) ||
      (suffix.startsWith('check-') && gate.checks.required.includes(suffix.slice('check-'.length)));
    if (e.imported && claimsProductCheck) {
      errors.push(`evidência ${eid}: importada não satisfaz check executado pelo produto (exit0 não se autodeclara)`);
    }
    if (suffix && !isCheckEvidence) {
      const entry = manifestIds.get(suffix);
      if (!entry) {
        errors.push(`evidência ${eid}: requisito ${suffix} fora do plano aprovado (manifesto)`);
      } else {
        if (entry.stage !== 'any' && entry.stage !== stage) {
          errors.push(`evidência ${eid}: requisito ${suffix} não é aplicável à etapa ${stage} (manifesto: ${entry.stage})`);
        }
        if (e.result === 'pass' && e.verdict === 'pass') covered.add(suffix);
      }
    }
  }
  for (const entry of gate.manifest.entries) {
    if (!entry.mandatory) continue;
    if (entry.stage !== 'any' && entry.stage !== stage) continue;
    if (!covered.has(entry.id)) errors.push(`requisito obrigatório ${entry.id} sem cobertura na etapa ${stage}`);
  }
  return { ok: errors.length === 0, errors, evidence: found };
}

/**
 * R5-05/M3-F3 — proveniência comum a QUALQUER evidência usada por um gate. A evidência
 * mecânica é produzida pelo comando `check` do produto (registro confiável do run: não
 * importada, produtor implícito = o próprio produto); a rubrica humana é importada e
 * carrega produtor explícito. Nenhuma omissão de projectId/revisão contorna a checagem.
 */
export function evidenceProvenanceErrors(
  e: Evidence, state: Runtime, run: Run, stage: Stage, gate: EvidenceGateContext, verified: Set<string>, expectedCommit: string | undefined,
): string[] {
  const errors: string[] = [];
  const eid = e.id;
  if (e.projectId === undefined) errors.push(`evidência ${eid}: sem projectId; proveniência obrigatória`);
  else if (e.projectId !== state.projectId) errors.push(`evidência ${eid}: projectId ${e.projectId} de outro projeto`);
  if (e.runId !== run.runId) {
    errors.push(e.runId === undefined
      ? `evidência ${eid}: sem runId; só vale para a execução que a produziu`
      : `evidência ${eid}: vinculada a outra execução (${e.runId})`);
  }
  if (e.stage !== stage) {
    errors.push(e.stage === undefined
      ? `evidência ${eid}: sem stage; vínculo de etapa é obrigatório`
      : `evidência ${eid}: vinculada a outra etapa (${e.stage})`);
  }
  if (e.revision === undefined) errors.push(`evidência ${eid}: sem revisão da execução; proveniência obrigatória`);
  else if (e.revision !== run.revision) errors.push(`evidência ${eid}: revisão ${e.revision} obsoleta diante da execução (${run.revision})`);
  const mechanical = e.check !== undefined && !e.imported;
  if (!mechanical) {
    if (!e.producer || !e.producer.threadId || !e.producer.generationId) {
      errors.push(`evidência ${eid}: sem producer (produtor: papel + thread + geração); rubrica exige identidade do produtor`);
    } else if (e.producer.role !== stageOwner[stage]) {
      errors.push(`evidência ${eid}: producer ${e.producer.role} não é o proprietário do estágio ${stage}`);
    }
  }
  if (!e.logPath) errors.push(`evidência ${eid}: logPath ausente (toda evidência aponta seu log)`);
  if (typeof e.logHash !== 'string' || !SHA256_RE.test(e.logHash)) errors.push(`evidência ${eid}: logHash sha256 obrigatório`);
  else if (!verified.has(eid)) errors.push(`evidência ${eid}: log não verificado em disco (ausente ou adulterado)`);
  if (!e.commit) errors.push(`evidência ${eid}: sem commit verificado`);
  else if (expectedCommit !== undefined && e.commit !== expectedCommit) {
    errors.push(`evidência ${eid}: commit ${e.commit} obsoleto diante de ${expectedCommit}`);
  }
  if (!e.timestamp || Number.isNaN(Date.parse(e.timestamp))) errors.push(`evidência ${eid}: timestamp inválido`);
  if (!e.codeSnapshot) errors.push(`evidência ${eid}: sem codeSnapshot (snapshot verificado obrigatório)`);
  else {
    if (e.codeSnapshot.diffFingerprint !== gate.currentSnapshot.diffFingerprint || e.codeSnapshot.commit !== gate.currentSnapshot.commit) {
      errors.push(`evidência ${eid}: árvore alterada após a produção da evidência (snapshot obsoleto)`);
    }
    if (e.commit && e.codeSnapshot.commit !== e.commit) errors.push(`evidência ${eid}: commit da evidência diverge do commit do snapshot`);
  }
  return errors;
}

/**
 * M4-F3 + R5-05/M3-F2 — validação estrutural do manifesto de requisitos aprovado. IDs
 * DUPLICADOS (mesmo contraditórios ou não), vazios, estágios desconhecidos, dispensas de
 * check incompatíveis e raízes documentais inseguras invalidam o manifesto.
 */
export function validateRequirementsManifest(m: Partial<RequirementsManifest>): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== 'object') return ['manifesto deve ser objeto'];
  if (typeof m.manifestPath !== 'string' || !m.manifestPath) errors.push('manifestPath obrigatório');
  if (typeof m.planPath !== 'string' || !m.planPath) errors.push('planPath obrigatório');
  if (typeof m.planHash !== 'string' || !SHA256_RE.test(m.planHash)) errors.push('planHash deve ser sha256 hex');
  if (!Array.isArray(m.entries)) {
    errors.push('entries deve ser array');
    return errors;
  }
  if (!m.entries.length) errors.push('entries vazio: manifesto sem requisitos não cobre nenhum gate');
  const seen = new Set<string>();
  for (const [i, entry] of m.entries.entries()) {
    if (!entry || typeof entry !== 'object') { errors.push(`entries[${i}] deve ser objeto`); continue; }
    if (typeof entry.id !== 'string' || !entry.id.trim()) { errors.push(`entries[${i}].id obrigatório`); continue; }
    if (entry.stage !== 'any' && !isStage(entry.stage)) { errors.push(`entries[${i}] (${entry.id}): stage inválido`); continue; }
    if (typeof entry.mandatory !== 'boolean') { errors.push(`entries[${i}] (${entry.id}): mandatory deve ser boolean`); continue; }
    if (seen.has(entry.id)) errors.push(`entries: id ${entry.id} duplicado (IDs devem ser únicos)`);
    seen.add(entry.id);
  }
  if (m.checkExemptions !== undefined) {
    if (!Array.isArray(m.checkExemptions)) errors.push('checkExemptions deve ser array');
    else errors.push(...validateCheckExemptions(m.checkExemptions));
  }
  if (m.documentRoots !== undefined) {
    if (!Array.isArray(m.documentRoots)) errors.push('documentRoots deve ser array');
    else for (const root of m.documentRoots) {
      const norm = typeof root === 'string' ? root.replace(/\\/g, '/').replace(/\/+$/, '') : '';
      if (!norm || /^([a-z]:|\/)/i.test(norm) || norm.split('/').some(part => part === '..' || part === '.' || part === '')
        || /^(\.git|\.sdlc-codex)(\/|$)/i.test(norm)) {
        errors.push(`documentRoots: '${String(root)}' inválido (relativo ao projeto, sem '..', fora de .git/.sdlc-codex)`);
      }
    }
  }
  return errors;
}

/**
 * R5-05/M3-F2 — o manifesto pertence AO plano aprovado: planPath/planHash coincidem com
 * os do registro de aprovação e cada ID de requisito consta no texto do plano aprovado.
 * Um manifesto com hash válido de OUTRO arquivo não escolhe o plano.
 */
export function validateManifestAgainstPlan(
  m: Pick<RequirementsManifest, 'planPath' | 'planHash' | 'entries'>,
  approved: { planPath: string; planHash: string; planText: string },
  samePath: (a: string, b: string) => boolean,
): string[] {
  const errors: string[] = [];
  if (!samePath(m.planPath, approved.planPath)) errors.push(`manifesto refere-se a outro plano (${m.planPath}); o plano aprovado é ${approved.planPath}`);
  if (m.planHash.toLowerCase() !== approved.planHash.toLowerCase()) errors.push('manifesto vinculado a plano com hash diferente do plano aprovado');
  for (const entry of m.entries) {
    const escaped = entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(approved.planText)) {
      errors.push(`requisito ${entry.id} do manifesto não consta no plano aprovado`);
    }
  }
  return errors;
}

export interface EvidenceImportContext {
  run: Run;
  stage: Stage;
  projectId: string;
  /** Checks que o produto executa para este estágio — não podem ser importados. */
  productChecks: string[];
  /** R5-05: identidade da sessão que executa o `next` — o produtor da rubrica é ELA. */
  actor: { role: Role; threadId: string; generationId: string };
}

/**
 * M4-F1 + R5-05/M3-F3 — validação PURA de uma evidência apresentada para importação
 * (cmdNext). Schemas distintos: rubrica humana (sem `check`) exige proveniência completa
 * (projectId, runId, stage, revisão, produtor = ator, timestamp, log+hash, commit e
 * codeSnapshot); dados mecânicos (`check`) de checks do produto NUNCA são importáveis.
 * A importação nunca reatribui/preenche nada: campo ausente é RECUSADO campo a campo.
 * A existência/integridade do log é conferida pelo chamador (fs).
 */
export function validateEvidenceImport(e: Evidence, ctx: EvidenceImportContext): string[] {
  const errors: string[] = [];
  const label = e.id ?? e.requirementId ?? '(sem id)';
  if (e.provenance === 'legacy') errors.push(`evidência ${label}: proveniência 'legacy' não pode ser importada`);
  if (e.runId === undefined || e.runId !== ctx.run.runId) {
    errors.push(e.runId === undefined
      ? `evidência ${label}: sem runId; importação nunca atribui runId retroativamente`
      : `evidência ${label}: runId ${e.runId} pertence a outra execução; importação nunca reatribui runId`);
  }
  if (e.stage !== ctx.stage) {
    errors.push(e.stage === undefined
      ? `evidência ${label}: sem stage; importação nunca atribui stage retroativamente`
      : `evidência ${label}: stage ${e.stage} diverge de ${ctx.stage}; importação nunca reatribui stage`);
  }
  if (e.projectId === undefined) errors.push(`evidência ${label}: sem projectId; importação nunca atribui projectId retroativamente`);
  else if (e.projectId !== ctx.projectId) errors.push(`evidência ${label}: projectId ${e.projectId} diverge de ${ctx.projectId}`);
  if (e.revision === undefined) errors.push(`evidência ${label}: sem revisão da execução; importação nunca atribui revisão retroativamente`);
  else if (e.revision !== ctx.run.revision) errors.push(`evidência ${label}: revisão ${e.revision} diverge da execução (${ctx.run.revision})`);
  const prefix = `${ctx.run.slug}:${ctx.stage}:`;
  if (typeof e.requirementId !== 'string' || !e.requirementId.startsWith(prefix) || e.requirementId.length <= prefix.length) {
    errors.push(`evidência ${label}: requirementId deve ser ${prefix}<requisito>`);
  }
  if (typeof e.procedure !== 'string' || !e.procedure.trim()) {
    errors.push(`evidência ${label}: procedure obrigatório; importação nunca substitui procedimento`);
  }
  if (!isIso(e.timestamp)) {
    errors.push(`evidência ${label}: timestamp ausente/inválido; importação nunca reescreve timestamp antigo para agora`);
  }
  if (e.producedAt !== undefined && !isIso(e.producedAt)) {
    errors.push(`evidência ${label}: producedAt inválido`);
  }
  if (!e.logPath) errors.push(`evidência ${label}: logPath ausente; evidência aponta seu log`);
  else if (typeof e.logHash !== 'string' || !SHA256_RE.test(e.logHash)) {
    errors.push(`evidência ${label}: logHash sha256 obrigatório para verificação de integridade do log`);
  }
  if (e.check !== undefined && ctx.productChecks.includes(e.check)) {
    errors.push(`evidência ${label}: check '${e.check}' é executado pelo produto; evidência importada com exitCode autodeclarado não satisfaz o gate`);
  }
  if (e.check === undefined) {
    // Rubrica humana: produtor explícito = a sessão que executa o next.
    const p = e.producer;
    if (!p || typeof p !== 'object') errors.push(`evidência ${label}: sem producer (papel + thread + geração do produtor)`);
    else if (p.role !== ctx.actor.role || p.threadId !== ctx.actor.threadId || p.generationId !== ctx.actor.generationId) {
      errors.push(`evidência ${label}: producer diverge da sessão que apresenta a evidência; importação não reatribui produtor`);
    }
    if (typeof e.commit !== 'string' || !e.commit) errors.push(`evidência ${label}: sem commit; rubrica de código exige o commit assessado`);
    const snap = e.codeSnapshot;
    if (!snap || typeof snap.commit !== 'string' || !snap.commit || typeof snap.diffFingerprint !== 'string' || !snap.diffFingerprint) {
      errors.push(`evidência ${label}: sem codeSnapshot completo (commit + diffFingerprint); use o snapshot informado por 'check'`);
    } else if (e.commit && snap.commit !== e.commit) {
      errors.push(`evidência ${label}: commit da evidência diverge do commit do codeSnapshot`);
    }
  }
  if (e.result === 'pass' && e.verdict !== 'pass') {
    errors.push(`evidência ${label}: rubrica humana inconsistente (result pass exige verdict pass)`);
  }
  return errors;
}

/**
 * M4-F1 — rubrica humana (RequirementVerdict) continua distinta da evidência
 * mecânica e exige evidência referenciada EXISTENTE: nenhum veredito humano
 * flutua sem evidência mecânica anexada ao estado.
 */
export function validateRequirementVerdict(v: RequirementVerdict, state: Runtime): string[] {
  const errors: string[] = [];
  if (!v || typeof v !== 'object') return ['veredito deve ser objeto'];
  if (typeof v.requirementId !== 'string' || !v.requirementId.trim()) errors.push('requirementId obrigatório');
  if (v.verdict !== 'pass' && v.verdict !== 'fail') errors.push('verdict deve ser pass|fail');
  if (!v.reviewer || !isRole(v.reviewer.role) || !v.reviewer.threadId || !v.reviewer.generationId) {
    errors.push('reviewer com identidade completa obrigatória (role/threadId/generationId)');
  }
  if (!isIso(v.assessedAt)) errors.push('assessedAt inválido');
  if (!Array.isArray(v.evidenceRefs) || !v.evidenceRefs.length) {
    errors.push('evidenceRefs não vazio; rubrica humana exige evidência referenciada');
  } else {
    const byId = new Map(state.evidence.map(e => [e.id, e]));
    for (const ref of v.evidenceRefs) {
      if (!byId.has(ref)) errors.push(`evidenceRefs: evidência ${ref} não existe no estado`);
    }
  }
  return errors;
}

export function evidenceFor(state: Runtime, slug: string, stage: Stage): Evidence[] {
  const prefix = `${slug}:${stage}:`;
  return state.evidence.filter(e => e.requirementId.startsWith(prefix) && e.requirementId.length > prefix.length);
}

/** Legado estrito: exige vínculo runId/stage quando presentes, verdict pass e commit. */
export function hasValidEvidence(state: Runtime, slug: string, stage: Stage): boolean {
  return evidenceFor(state, slug, stage).some(e =>
    e.result === 'pass' && e.verdict === 'pass' && Boolean(e.commit) && Boolean(e.timestamp));
}

export interface RunSummary {
  slug: string; workflow: string; stage: string; owner?: string; status: string;
  attempts: unknown; revision: number; blockedReason?: string;
  pendingDeliveries: number; uncertainDeliveries: number; lastEventAt?: string;
  pullRequest?: { url: string; base: string; branch: string; commit: string };
}

export function statusReport(state: Runtime, slug?: string): object {
  const runs = state.runs.filter(r => !slug || r.slug === slug);
  return {
    projectId: state.projectId,
    revision: state.revision,
    runs: runs.map((r): RunSummary => ({
      slug: r.slug, workflow: r.workflow, stage: r.stage, owner: r.owner,
      status: r.status, attempts: r.attempts, revision: r.revision,
      blockedReason: r.blockedReason,
      pendingDeliveries: state.deliveries.filter(d =>
        ['pending', 'uncertain'].includes(d.status) &&
        state.messages.find(m => m.messageId === d.messageId)?.runId === r.runId).length,
      uncertainDeliveries: state.deliveries.filter(d =>
        d.status === 'uncertain' &&
        state.messages.find(m => m.messageId === d.messageId)?.runId === r.runId).length,
      lastEventAt: state.events.at(-1)?.at,
      pullRequest: r.pullRequest ? {
        url: r.pullRequest.url, base: r.pullRequest.base,
        branch: r.pullRequest.branch, commit: r.pullRequest.commit,
      } : undefined,
    })),
    sessions: state.sessions.map(s => ({
      role: s.role, status: s.status, threadId: s.threadId,
      generationId: s.generationId, lastEventAt: s.lastEventAt,
    })),
    uncertainDeliveries: state.deliveries.filter(d => d.status === 'uncertain').length,
  };
}
