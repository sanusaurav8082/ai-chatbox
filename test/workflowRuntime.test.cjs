const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WorkflowRegistry, parseWorkflowManifest, startWorkflow, getCurrentWorkflowStep,
  completeInstructionStep, decideWorkflowApproval
} = require("../dist/workflowRuntime.js");

const deployWorkflow = {
  id: "release.deploy", version: "1.2.0", name: "Release deployment",
  description: "A staged release checklist with explicit approval checkpoints.",
  steps: [
    { id: "inspect", type: "instruction", title: "Inspect changes", instructions: "Review the change summary, tests, and rollback plan." },
    { id: "release-approval", type: "approval", title: "Approve release", prompt: "Confirm the release and rollback plan before proceeding." },
    { id: "verify", type: "instruction", title: "Verify release", instructions: "Check the deployment health and report the result." }
  ]
};

test("parses a versioned workflow and normalizes text", () => {
  const parsed = parseWorkflowManifest({ ...deployWorkflow, name: " Release deployment " });
  assert.equal(parsed.version, "1.2.0");
  assert.equal(parsed.name, "Release deployment");
  assert.equal(parsed.steps.length, 3);
});

test("rejects invalid IDs, non-semver versions, duplicate steps, and unknown step types", () => {
  assert.throws(() => parseWorkflowManifest({ ...deployWorkflow, id: "../bad" }), /workflow id/i);
  assert.throws(() => parseWorkflowManifest({ ...deployWorkflow, version: "latest" }), /semantic version/i);
  assert.throws(() => parseWorkflowManifest({ ...deployWorkflow, steps: [deployWorkflow.steps[0], deployWorkflow.steps[0]] }), /unique/i);
  assert.throws(() => parseWorkflowManifest({ ...deployWorkflow, steps: [{ id: "bad", type: "shell", title: "Run", command: "echo hi" }] }), /step type/i);
});

test("validates conditions only when they reference a compatible earlier step", () => {
  const conditional = { ...deployWorkflow, steps: [
    deployWorkflow.steps[0],
    { ...deployWorkflow.steps[1], condition: { stepId: "inspect", outcome: "completed" } }
  ] };
  assert.equal(parseWorkflowManifest(conditional).steps[1].condition.stepId, "inspect");
  assert.throws(() => parseWorkflowManifest({ ...conditional, steps: [
    { ...deployWorkflow.steps[0], condition: { stepId: "release-approval", outcome: "approved" } },
    deployWorkflow.steps[1]
  ] }), /earlier step/i);
  assert.throws(() => parseWorkflowManifest({ ...conditional, steps: [
    deployWorkflow.steps[1],
    { ...deployWorkflow.steps[0], condition: { stepId: "release-approval", outcome: "completed" } }
  ] }), /does not match/i);
  assert.throws(() => parseWorkflowManifest({ ...conditional, steps: [
    deployWorkflow.steps[0],
    { ...deployWorkflow.steps[1], condition: { stepId: "inspect", outcome: "approved" } }
  ] }), /does not match/i);
});

test("bounds workflow count, step count, and text size", () => {
  assert.throws(() => parseWorkflowManifest({ ...deployWorkflow, steps: [] }), /between 1 and 50/);
  assert.throws(() => parseWorkflowManifest({ ...deployWorkflow, steps: [{ id: "large", type: "instruction", title: "Large", instructions: "x".repeat(8001) }] }), /8000/);
  const registry = new WorkflowRegistry();
  for (let i = 0; i < 100; i++) registry.register({ ...deployWorkflow, id: `workflow-${i}` });
  assert.throws(() => registry.register({ ...deployWorkflow, id: "another-workflow" }), /limit/i);
});

test("registry returns copies and supports disabling workflows", () => {
  const registry = new WorkflowRegistry();
  registry.register(deployWorkflow);
  const copy = registry.get("release.deploy");
  copy.steps[0].title = "mutated";
  assert.equal(registry.get("release.deploy").steps[0].title, "Inspect changes");
  assert.equal(registry.setEnabled("release.deploy", false), true);
  assert.equal(registry.setEnabled("missing", false), false);
  assert.throws(() => startWorkflow(registry.get("release.deploy")), /disabled/i);
});

test("workflow pauses at approval checkpoints and continues only after approval", () => {
  let run = startWorkflow(deployWorkflow);
  assert.equal(run.status, "running");
  assert.equal(getCurrentWorkflowStep(run).id, "inspect");
  run = completeInstructionStep(run, "inspect");
  assert.equal(run.status, "awaiting-approval");
  assert.equal(getCurrentWorkflowStep(run).id, "release-approval");
  assert.throws(() => completeInstructionStep(run, "release-approval"), /current instruction/i);
  run = decideWorkflowApproval(run, "release-approval", true);
  assert.equal(run.status, "running");
  assert.equal(getCurrentWorkflowStep(run).id, "verify");
  run = completeInstructionStep(run, "verify");
  assert.equal(run.status, "completed");
  assert.deepEqual(run.outcomes.map(item => item.outcome), ["completed", "approved", "completed"]);
});

test("denying an approval checkpoint cancels the workflow without advancing", () => {
  let run = startWorkflow(deployWorkflow);
  run = completeInstructionStep(run, "inspect");
  run = decideWorkflowApproval(run, "release-approval", false);
  assert.equal(run.status, "cancelled");
  assert.equal(run.stepIndex, 1);
  assert.equal(run.outcomes.at(-1).outcome, "denied");
  assert.throws(() => decideWorkflowApproval(run, "release-approval", true), /awaiting/i);
});

test("an approval checkpoint at the beginning pauses immediately", () => {
  const run = startWorkflow({ ...deployWorkflow, steps: [deployWorkflow.steps[1]] });
  assert.equal(run.status, "awaiting-approval");
  assert.equal(getCurrentWorkflowStep(run).type, "approval");
});

test("workflow transitions are immutable and require the exact current step", () => {
  const original = startWorkflow(deployWorkflow);
  assert.throws(() => completeInstructionStep(original, "verify"), /current instruction/i);
  const advanced = completeInstructionStep(original, "inspect");
  assert.equal(original.stepIndex, 0);
  assert.equal(original.outcomes.length, 0);
  assert.equal(advanced.stepIndex, 1);
});

test("skips conditional steps when their prerequisite outcome does not match", () => {
  const workflow = { ...deployWorkflow, steps: [
    deployWorkflow.steps[0],
    deployWorkflow.steps[1],
    { id: "post-approval", type: "instruction", title: "Post approval", instructions: "Continue only after approval.", condition: { stepId: "release-approval", outcome: "approved" } },
    { id: "fallback", type: "instruction", title: "Fallback", instructions: "Record that release approval was denied.", condition: { stepId: "release-approval", outcome: "denied" } }
  ] };
  const branchWorkflow = { ...workflow, steps: workflow.steps.map((step) => step.id === "release-approval" ? { ...step, onDeny: "continue" } : step) };
  let run = startWorkflow(branchWorkflow);
  run = completeInstructionStep(run, "inspect");
  run = decideWorkflowApproval(run, "release-approval", false);
  assert.equal(getCurrentWorkflowStep(run).id, "fallback");
  run = completeInstructionStep(run, "fallback");
  assert.equal(run.status, "completed");
  assert.deepEqual(run.outcomes.map(item => item.outcome), ["completed", "denied", "skipped", "completed"]);
});

test("skips mismatched conditions and completes when all remaining steps are skipped", () => {
  const workflow = { ...deployWorkflow, steps: [
    deployWorkflow.steps[0],
    { ...deployWorkflow.steps[1], onDeny: "continue" },
    { id: "conditional", type: "instruction", title: "Conditional", instructions: "Only runs after approval.", condition: { stepId: "release-approval", outcome: "approved" } }
  ] };
  let run = startWorkflow(workflow);
  run = completeInstructionStep(run, "inspect");
  run = decideWorkflowApproval(run, "release-approval", false);
  assert.equal(run.status, "completed");
  assert.equal(run.stepIndex, 3);
  assert.deepEqual(run.outcomes.map(item => item.outcome), ["completed", "denied", "skipped"]);
});
