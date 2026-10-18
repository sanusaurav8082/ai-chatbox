import { WorkflowRun, parseWorkflowManifest } from "./workflowRuntime";
export const MAX_SAVED_WORKFLOW_RUNS = 10;
export const MAX_SAVED_WORKFLOW_STATE_BYTES = 200_000;
const STATUSES = new Set(["running", "awaiting-approval", "completed", "cancelled"]);
const OUTCOMES = new Set(["completed", "approved", "denied", "skipped"]);

/** Validate and clone untrusted persisted runs. Invalid records are dropped individually. */
export function validateSavedWorkflowRuns(value: unknown): WorkflowRun[] {
  if (!Array.isArray(value)) return [];
  const valid: WorkflowRun[] = [];
  for (const candidate of value.slice(-MAX_SAVED_WORKFLOW_RUNS)) {
    try { const run = validateRun(candidate); if (run) valid.push(run); } catch { /* Ignore corrupt records. */ }
  }
  return fitWithinStorageLimit(valid);
}
export function upsertSavedWorkflowRun(value: unknown, runId: string, run: WorkflowRun): Array<{ runId: string; run: WorkflowRun }> {
  const current = validateSavedWorkflowRecords(value);
  const next = current.filter((item) => item.runId !== runId);
  next.push({ runId, run: validateRun(run)! });
  return fitRecords(next);
}
export function validateSavedWorkflowRecords(value: unknown): Array<{ runId: string; run: WorkflowRun }> {
  if (!Array.isArray(value)) return [];
  const records: Array<{ runId: string; run: WorkflowRun }> = [];
  for (const item of value.slice(-MAX_SAVED_WORKFLOW_RUNS)) {
    try {
      if (!isRecord(item) || typeof item.runId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(item.runId)) continue;
      const run = validateRun(item.run);
      if (run) records.push({ runId: item.runId, run });
    } catch { /* Skip individual invalid records. */ }
  }
  return fitRecords(records);
}
function validateRun(value: unknown): WorkflowRun | undefined {
  if (!isRecord(value) || !isRecord(value.workflow)) return undefined;
  const manifest = parseWorkflowManifest(value.workflow);
  if (manifest.enabled === false) return undefined;
  const workflow = { ...manifest, enabled: true };
  if (!Number.isInteger(value.stepIndex) || (value.stepIndex as number) < 0 || (value.stepIndex as number) > workflow.steps.length) return undefined;
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) return undefined;
  if (!Array.isArray(value.outcomes) || value.outcomes.length > workflow.steps.length) return undefined;
  const outcomes = value.outcomes.map((candidate: unknown) => {
    if (!isRecord(candidate) || typeof candidate.stepId !== "string" ||
        (candidate.type !== "instruction" && candidate.type !== "approval") ||
        typeof candidate.outcome !== "string" || !OUTCOMES.has(candidate.outcome)) throw new Error("Invalid workflow outcome.");
    const step = workflow.steps.find((item) => item.id === candidate.stepId);
    if (!step || step.type !== candidate.type) throw new Error("Outcome does not match workflow step.");
    if ((candidate.type === "instruction" && candidate.outcome !== "completed" && candidate.outcome !== "skipped") ||
        (candidate.type === "approval" && candidate.outcome !== "approved" && candidate.outcome !== "denied" && candidate.outcome !== "skipped")) {
      throw new Error("Invalid workflow outcome transition.");
    }
    return { stepId: candidate.stepId, type: candidate.type, outcome: candidate.outcome } as WorkflowRun["outcomes"][number];
  });
  const stepIndex = value.stepIndex as number;
  const status = value.status as WorkflowRun["status"];
  const expectedOutcomeCount = stepIndex + (status === "cancelled" ? 1 : 0);
  if (outcomes.length !== expectedOutcomeCount) return undefined;
  for (let index = 0; index < stepIndex; index++) {
    const step = workflow.steps[index];
    const outcome = outcomes[index];
    if (outcome?.stepId !== step?.id || (outcome?.outcome === "denied" && !(step?.type === "approval" && step.onDeny === "continue"))) return undefined;
    if (step.condition) {
      const sourceOutcome = outcomes.find((item) => item.stepId === step.condition!.stepId)?.outcome;
      const shouldRun = sourceOutcome === step.condition.outcome;
      if ((outcome.outcome === "skipped") === shouldRun) return undefined;
    } else if (outcome.outcome === "skipped") return undefined;
  }
  if (status === "completed" && stepIndex !== workflow.steps.length) return undefined;
  if ((status === "running" || status === "awaiting-approval") && stepIndex >= workflow.steps.length) return undefined;
  if (status === "running" && workflow.steps[stepIndex]?.type !== "instruction") return undefined;
  if (status === "awaiting-approval" && workflow.steps[stepIndex]?.type !== "approval") return undefined;
  if (status === "cancelled" && (stepIndex >= workflow.steps.length || workflow.steps[stepIndex]?.type !== "approval" ||
      outcomes.at(-1)?.stepId !== workflow.steps[stepIndex]?.id || outcomes.at(-1)?.outcome !== "denied")) return undefined;
  return { workflow: { ...workflow, steps: workflow.steps.map((step) => ({ ...step, ...(step.condition ? { condition: { ...step.condition } } : {}) })) }, stepIndex, status, outcomes: outcomes.map((outcome) => ({ ...outcome })) };
}
function fitWithinStorageLimit(runs: WorkflowRun[]): WorkflowRun[] {
  return fitRecords(runs.map((run, index) => ({ runId: `legacy-${index}`, run }))).map((record) => record.run);
}
function fitRecords(records: Array<{ runId: string; run: WorkflowRun }>): Array<{ runId: string; run: WorkflowRun }> {
  let result = records.slice(-MAX_SAVED_WORKFLOW_RUNS);
  while (result.length && Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SAVED_WORKFLOW_STATE_BYTES) result = result.slice(1);
  return result;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
