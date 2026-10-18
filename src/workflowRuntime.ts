export type WorkflowExpectedOutcome = "completed" | "approved";
export interface WorkflowCondition {
  /** ID of an earlier step whose final outcome controls this step. */
  stepId: string;
  outcome: WorkflowExpectedOutcome;
}
export interface InstructionWorkflowStep {
  id: string;
  type: "instruction";
  title: string;
  instructions: string;
  condition?: WorkflowCondition;
}
export interface ApprovalWorkflowStep {
  id: string;
  type: "approval";
  title: string;
  prompt: string;
  condition?: WorkflowCondition;
}
export type WorkflowStep = InstructionWorkflowStep | ApprovalWorkflowStep;
export interface WorkflowManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  enabled?: boolean;
}
export interface RegisteredWorkflow extends WorkflowManifest { enabled: boolean; }
export interface WorkflowStepOutcome {
  stepId: string;
  type: WorkflowStep["type"];
  outcome: "completed" | "approved" | "denied" | "skipped";
}
export type WorkflowRunStatus = "running" | "awaiting-approval" | "completed" | "cancelled";
export interface WorkflowRun {
  workflow: RegisteredWorkflow;
  stepIndex: number;
  status: WorkflowRunStatus;
  outcomes: WorkflowStepOutcome[];
}
export const MAX_WORKFLOWS = 100;
export const MAX_WORKFLOW_STEPS = 50;
export const MAX_WORKFLOW_STEP_TEXT = 8_000;
export const MAX_WORKFLOW_TOTAL_TEXT = 32_000;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Validate untrusted JSON data before registering it as a workflow definition. */
export function parseWorkflowManifest(value: unknown): WorkflowManifest {
  if (!isRecord(value)) throw new Error("Workflow manifest must be an object.");
  const { id, version, name, description, steps, enabled } = value;
  if (typeof id !== "string" || id.length > 80 || !ID_PATTERN.test(id)) throw new Error("Invalid workflow id.");
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new Error("Workflow version must be semantic versioning, e.g. 1.0.0.");
  if (typeof name !== "string" || !name.trim() || name.length > 120) throw new Error("Workflow name must be non-empty and at most 120 characters.");
  if (typeof description !== "string" || !description.trim() || description.length > 500) throw new Error("Workflow description must be non-empty and at most 500 characters.");
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_WORKFLOW_STEPS) throw new Error("Workflow must contain between 1 and 50 steps.");
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("Workflow enabled must be a boolean.");

  const seen = new Set<string>();
  let totalText = 0;
  const normalizedSteps: WorkflowStep[] = steps.map((candidate: unknown): WorkflowStep => {
    if (!isRecord(candidate)) throw new Error("Workflow steps must be objects.");
    const { id: stepId, type, title } = candidate;
    if (typeof stepId !== "string" || stepId.length > 80 || !ID_PATTERN.test(stepId)) throw new Error("Invalid workflow step id.");
    if (seen.has(stepId)) throw new Error("Workflow step ids must be unique.");
    seen.add(stepId);
    if (typeof title !== "string" || !title.trim() || title.length > 120) throw new Error("Workflow step title must be non-empty and at most 120 characters.");
    let condition: WorkflowCondition | undefined;
    if (candidate.condition !== undefined) {
      const raw = candidate.condition;
      if (!isRecord(raw) || typeof raw.stepId !== "string" || !ID_PATTERN.test(raw.stepId) ||
          (raw.outcome !== "completed" && raw.outcome !== "approved")) {
        throw new Error("Workflow condition must reference an earlier step and expect completed or approved.");
      }
      if (!seen.has(raw.stepId) || raw.stepId === stepId) throw new Error("Workflow conditions must reference an earlier step.");
      condition = { stepId: raw.stepId, outcome: raw.outcome };
    }
    if (type === "instruction") {
      const instructions = candidate.instructions;
      if (typeof instructions !== "string" || !instructions.trim() || instructions.length > MAX_WORKFLOW_STEP_TEXT) throw new Error("Workflow instructions are empty or exceed 8000 characters.");
      totalText += title.length + instructions.length;
      return { id: stepId, type, title: title.trim(), instructions: instructions.trim(), ...(condition ? { condition } : {}) };
    }
    if (type === "approval") {
      const prompt = candidate.prompt;
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_WORKFLOW_STEP_TEXT) throw new Error("Workflow approval prompt is empty or exceeds 8000 characters.");
      totalText += title.length + prompt.length;
      return { id: stepId, type, title: title.trim(), prompt: prompt.trim(), ...(condition ? { condition } : {}) };
    }
    throw new Error("Workflow step type must be instruction or approval.");
  });
  // A condition's expected outcome must be possible for the referenced step type.
  for (const step of normalizedSteps) {
    if (!step.condition) continue;
    const source = normalizedSteps.find((candidate) => candidate.id === step.condition!.stepId)!;
    if ((step.condition.outcome === "completed" && source.type !== "instruction") ||
        (step.condition.outcome === "approved" && source.type !== "approval")) {
      throw new Error("Workflow condition outcome does not match the referenced step type.");
    }
  }
  if (totalText > MAX_WORKFLOW_TOTAL_TEXT) throw new Error("Workflow step text exceeds the 32000-character total limit.");
  return { id, version, name: name.trim(), description: description.trim(), steps: normalizedSteps, ...(enabled === undefined ? {} : { enabled }) };
}

export class WorkflowRegistry {
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  register(value: unknown): RegisteredWorkflow {
    const manifest = parseWorkflowManifest(value);
    if (!this.workflows.has(manifest.id) && this.workflows.size >= MAX_WORKFLOWS) throw new Error("Workflow registry limit reached.");
    const workflow: RegisteredWorkflow = { ...manifest, enabled: manifest.enabled ?? true, steps: cloneSteps(manifest.steps) };
    this.workflows.set(workflow.id, workflow);
    return cloneWorkflow(workflow);
  }
  get(id: string): RegisteredWorkflow | undefined { const workflow = this.workflows.get(id); return workflow ? cloneWorkflow(workflow) : undefined; }
  list(): RegisteredWorkflow[] { return [...this.workflows.values()].sort((a, b) => a.id.localeCompare(b.id)).map(cloneWorkflow); }
  setEnabled(id: string, enabled: boolean): boolean { const workflow = this.workflows.get(id); if (!workflow) return false; workflow.enabled = enabled; return true; }
}

/** Start from an immutable definition snapshot and skip initial steps whose conditions are unmet. */
export function startWorkflow(value: unknown): WorkflowRun {
  const workflow = parseWorkflowManifest(value);
  if (workflow.enabled === false) throw new Error("Disabled workflows cannot be started.");
  const snapshot: RegisteredWorkflow = { ...workflow, enabled: true, steps: cloneSteps(workflow.steps) };
  return advancePastUnmetConditions({ workflow: snapshot, stepIndex: 0, status: "running", outcomes: [] });
}
export function getCurrentWorkflowStep(run: WorkflowRun): WorkflowStep | undefined {
  return run.workflow.steps[run.stepIndex] ? cloneStep(run.workflow.steps[run.stepIndex]) : undefined;
}
/** Mark an instruction step done. This does not execute tools or grant tool permission. */
export function completeInstructionStep(run: WorkflowRun, stepId: string): WorkflowRun {
  const step = getCurrentWorkflowStep(run);
  if (run.status !== "running" || !step || step.type !== "instruction" || step.id !== stepId) throw new Error("Only the current instruction step in a running workflow can be completed.");
  return moveToNextStep(run, { stepId, type: "instruction", outcome: "completed" });
}
/** Approve or reject the current checkpoint. Rejection cancels the workflow. */
export function decideWorkflowApproval(run: WorkflowRun, stepId: string, approved: boolean): WorkflowRun {
  const step = getCurrentWorkflowStep(run);
  if (run.status !== "awaiting-approval" || !step || step.type !== "approval" || step.id !== stepId) throw new Error("There is no matching workflow approval checkpoint awaiting a decision.");
  const outcome: WorkflowStepOutcome = { stepId, type: "approval", outcome: approved ? "approved" : "denied" };
  if (!approved) return { ...cloneRun(run), status: "cancelled", outcomes: [...run.outcomes.map(cloneOutcome), outcome] };
  return moveToNextStep(run, outcome);
}
function moveToNextStep(run: WorkflowRun, outcome: WorkflowStepOutcome): WorkflowRun {
  return advancePastUnmetConditions({ ...cloneRun(run), stepIndex: run.stepIndex + 1, status: "running", outcomes: [...run.outcomes.map(cloneOutcome), outcome] });
}
/** Unmet conditions are recorded explicitly as skipped outcomes; no hidden branch code is evaluated. */
function advancePastUnmetConditions(run: WorkflowRun): WorkflowRun {
  let next = cloneRun(run);
  while (next.stepIndex < next.workflow.steps.length) {
    const step = next.workflow.steps[next.stepIndex];
    if (step.condition) {
      const sourceOutcome = next.outcomes.find((item) => item.stepId === step.condition!.stepId)?.outcome;
      if (sourceOutcome !== step.condition.outcome) {
        next.outcomes.push({ stepId: step.id, type: step.type, outcome: "skipped" });
        next.stepIndex += 1;
        continue;
      }
    }
    next.status = step.type === "approval" ? "awaiting-approval" : "running";
    return next;
  }
  next.status = "completed";
  return next;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function cloneStep(step: WorkflowStep): WorkflowStep { return { ...step, ...(step.condition ? { condition: { ...step.condition } } : {}) }; }
function cloneSteps(steps: WorkflowStep[]): WorkflowStep[] { return steps.map(cloneStep); }
function cloneWorkflow(workflow: RegisteredWorkflow): RegisteredWorkflow { return { ...workflow, steps: cloneSteps(workflow.steps) }; }
function cloneOutcome(outcome: WorkflowStepOutcome): WorkflowStepOutcome { return { ...outcome }; }
function cloneRun(run: WorkflowRun): WorkflowRun { return { ...run, workflow: cloneWorkflow(run.workflow), outcomes: run.outcomes.map(cloneOutcome) }; }
