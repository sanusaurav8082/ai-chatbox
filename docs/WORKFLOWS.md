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


## Loading and running workflows

Workflow loading is opt-in. Set `aiChatbox.workflowsEnabled` to `true`, then run **AI Chatbox: Run Workflow** from the VS Code Command Palette.

The loader reads JSON files from:

- Each workspace's `.ai-chatbox/workflows/*.json` directory.
- The AI Chatbox extension global-storage `workflows/*.json` directory.

User-storage files are loaded before workspace files; a workspace workflow with the same stable ID takes precedence. The loader considers at most 100 files and 20,000 bytes per file. Invalid, unreadable, oversized, or malformed manifests are skipped and recorded in **AI Chatbox Workflows** output. Disabled workflows are not offered for execution.

The command uses native VS Code dialogs to show each instruction and asks the user to explicitly mark it complete. Approval steps use a modal confirmation and stop the workflow on denial. Dismissing a dialog stops the current run. Runs are currently session-only and are not persisted.

This milestone is a basic host-side execution UI, not an LLM-driven workflow planner. Instruction text is displayed to the user; the runtime does not automatically execute instructions or invoke tools. The approval checkpoint is separate from the existing per-tool approval gate.
