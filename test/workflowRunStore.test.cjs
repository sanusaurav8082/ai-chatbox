const test = require("node:test");
const assert = require("node:assert/strict");
const { startWorkflow, completeInstructionStep, decideWorkflowApproval } = require("../dist/workflowRuntime.js");
const { validateSavedWorkflowRecords, upsertSavedWorkflowRun, MAX_SAVED_WORKFLOW_RUNS } = require("../dist/workflowRunStore.js");

const workflow = {
  id: "release.deploy", version: "1.2.0", name: "Release deployment", description: "A release checklist.",
  steps: [
    { id: "inspect", type: "instruction", title: "Inspect", instructions: "Review changes." },
    { id: "approve", type: "approval", title: "Approve", prompt: "Approve the release?" },
    { id: "verify", type: "instruction", title: "Verify", instructions: "Check health." }
  ]
};

test("validates and clones a resumable run snapshot", () => {
  let run = startWorkflow(workflow);
  run = completeInstructionStep(run, "inspect");
  const records = validateSavedWorkflowRecords([{ runId: "run-1", run }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].run.status, "awaiting-approval");
  records[0].run.workflow.steps[0].title = "tampered";
  assert.equal(validateSavedWorkflowRecords([{ runId: "run-1", run }])[0].run.workflow.steps[0].title, "Inspect");
});

test("drops malformed records without rejecting valid records", () => {
  const run = startWorkflow(workflow);
  const records = validateSavedWorkflowRecords([
    { runId: "bad/id", run },
    { runId: "broken", run: { ...run, status: "running", stepIndex: 1 } },
    { runId: "valid", run }
  ]);
  assert.deepEqual(records.map((item) => item.runId), ["valid"]);
});

test("requires state and outcomes to match the workflow state machine", () => {
  const run = startWorkflow(workflow);
  assert.equal(validateSavedWorkflowRecords([{ runId: "run-1", run: { ...run, status: "completed" } }]).length, 0);
  let cancelled = completeInstructionStep(run, "inspect");
  cancelled = decideWorkflowApproval(cancelled, "approve", false);
  assert.equal(validateSavedWorkflowRecords([{ runId: "run-2", run: cancelled }])[0].run.status, "cancelled");
});

test("upsert replaces same run ID and keeps only bounded newest records", () => {
  let saved = [];
  for (let i = 0; i < MAX_SAVED_WORKFLOW_RUNS + 2; i++) {
    saved = upsertSavedWorkflowRun(saved, `run-${i}`, startWorkflow(workflow));
  }
  assert.equal(saved.length, MAX_SAVED_WORKFLOW_RUNS);
  assert.equal(saved[0].runId, "run-2");
  saved = upsertSavedWorkflowRun(saved, "run-11", completeInstructionStep(startWorkflow(workflow), "inspect"));
  assert.equal(saved.filter((item) => item.runId === "run-11").length, 1);
  assert.equal(saved.at(-1).run.status, "awaiting-approval");
});
