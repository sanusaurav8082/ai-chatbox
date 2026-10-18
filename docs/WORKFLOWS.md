# Workflows and SOPs

The workflow runtime is the foundation for repeatable, versioned procedures. Unlike a skill, which contributes optional guidance to a prompt, a workflow defines an ordered checklist with explicit human approval checkpoints.

## Manifest format

Workflow definitions are JSON data. Each manifest contains:

- `id`: stable lowercase identifier (for example, `release.deploy`).
- `version`: semantic version such as `1.2.0`.
- `name` and `description`: human-readable metadata.
- `steps`: an ordered list of instruction and approval steps.
- Optional `enabled`: defaults to enabled when registered; disabled workflows cannot be started.

Example:

```json
{
  "id": "release.deploy",
  "version": "1.2.0",
  "name": "Release deployment",
  "description": "A staged release checklist with explicit approval checkpoints.",
  "steps": [
    {
      "id": "inspect",
      "type": "instruction",
      "title": "Inspect changes",
      "instructions": "Review the change summary, tests, and rollback plan."
    },
    {
      "id": "release-approval",
      "type": "approval",
      "title": "Approve release",
      "prompt": "Confirm the release and rollback plan before proceeding."
    },
    {
      "id": "verify",
      "type": "instruction",
      "title": "Verify release",
      "instructions": "Check deployment health and report the result."
    }
  ]
}
```

## Runtime contract

The pure TypeScript runtime validates manifests and bounds the registry to 100 workflows, 50 steps per workflow, 8,000 characters per step, and 32,000 characters of step text per workflow. Step IDs must be unique within a workflow. The registry returns copies rather than references to its internal data.

A run snapshots the selected workflow version at start, so later registry edits do not mutate an in-progress run. The state machine supports:

- `running`: the current step is an instruction step.
- `awaiting-approval`: the current step is an approval checkpoint; progression stops until an explicit decision is supplied.
- `completed`: every step has completed or been approved.
- `cancelled`: an approval checkpoint was denied.

Instruction steps advance only when the host calls `completeInstructionStep` for the exact current step. Approval checkpoints advance only when the host calls `decideWorkflowApproval` with an explicit approval. Denial cancels the run. Transitions return new state and do not mutate the previous run.

## Security boundary and current scope

Workflow files are definitions, not executable code. The current runtime supports instruction and approval steps only; it does not execute shell commands, call tools, evaluate expressions, or implement conditional branches/retries. This makes the state machine independently testable before adding file discovery or UI integration.

**A workflow approval is not a blanket permission to use tools.** Any future tool action must still pass through the agent runtime's existing per-invocation permission service and approval UI. Workflow content is untrusted user-provided guidance and must not override system/developer instructions or security policy. Do not automatically trust workflow files from repositories you do not control.
