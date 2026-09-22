import type { Role, Stage, Workflow } from '../contracts.js';
export const workflowStages: Record<Workflow, Stage[]> = { feature: ['build', 'review', 'e2e', 'pr', 'pr-review', 'document'], hotfix: ['build', 'review', 'pr', 'pr-review'], 'review-only': ['review'] };
export const stageOwner: Record<Stage, Role> = { build: 'dev', review: 'reviewer', e2e: 'tester-e2e', pr: 'dev', 'pr-review': 'reviewer', document: 'document' };
export function nextStage(workflow: Workflow, stage: Stage): Stage | undefined { const stages = workflowStages[workflow]; const index = stages.indexOf(stage); return index < 0 ? undefined : stages[index + 1]; }

/**
 * C09 — matriz única de checks obrigatórios por workflow/estágio, alinhada ao que
 * `cmdCheck` realmente executa em cada estágio (build|pr|document → check 'build',
 * e2e → 'e2e', review|pr-review → 'unit'). review-only revisa código existente sem
 * implementação; nenhum check mecânico é exigido, apenas a rubrica de revisão.
 * Esta matriz é a fonte única tanto para runCheck quanto para validateStageEvidence.
 */
export const requiredChecks: Record<Workflow, Record<Stage, string[]>> = {
  feature: { build: ['build'], review: ['unit'], e2e: ['e2e'], pr: ['build'], 'pr-review': ['unit'], document: ['build'] },
  hotfix: { build: ['build'], review: ['unit'], e2e: [], pr: ['build'], 'pr-review': ['unit'], document: [] },
  'review-only': { build: [], review: [], e2e: [], pr: [], 'pr-review': [], document: [] },
};

export function getRequiredChecks(workflow: Workflow, stage: Stage): string[] {
  return requiredChecks[workflow]?.[stage] ?? [];
}

/** C09: estágio exige evidência de código (commit verificado) quando tem checks obrigatórios. */
export function stageRequiresCommit(workflow: Workflow, stage: Stage): boolean {
  return getRequiredChecks(workflow, stage).length > 0;
}
