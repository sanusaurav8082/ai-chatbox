# Roadmap

The roadmap is intentionally incremental. Each milestone should leave the main branch in a buildable state.

## Phase 1 — Foundation

- [x] Create extension manifest and TypeScript build.
- [x] Register `AI Chatbox: Open Chat`.
- [x] Render a theme-aware webview chat UI.
- [x] Add a validated, bounded webview-to-host message bridge.
- [x] Add a strict starter CSP and no local webview resource access.
- [x] Add a CI workflow for type-checking, build, and tests.
- [x] Add a CI integration test that launches the VS Code Extension Development Host and verifies activation, core command registration, and safe default settings.
- [x] Exercise the OpenAI-compatible model adapter and agent loop against a local deterministic mock server, including approved and denied tool calls.
- [x] Exercise MCP Streamable HTTP connection and discovery against a local SDK server, forward the discovered schema through the model adapter, and verify allow/deny execution boundaries.
- [ ] Verify interactively in the VS Code Extension Development Host.

## Phase 2 — Model connectivity (implementation in this PR)

- [x] Define a small model client contract and provider configuration.
- [x] Add OpenAI provider and OpenAI-compatible endpoint support.
- [x] Store the OpenAI API key in VS Code SecretStorage.
- [x] Stream model output to the chat UI.
- [x] Handle cancellation, timeouts, and provider errors.
- [x] Keep bounded in-memory conversation history for the current panel.
- [x] Add deterministic tests for endpoint validation, streaming, missing credentials, and HTTP errors.
- [ ] Verify against a live local model or OpenAI API from VS Code.

## Phase 3 — Agent runtime foundation (implementation in this PR)

- [x] Define typed AgentEvent, model adapter, tool, and AgentRuntime interfaces.
- [x] Implement the provider-independent model/tool-call loop.
- [x] Add bounded history, iteration count, per-turn tool-call count, and tool-output size.
- [x] Validate tool inputs and require explicit permission before executing tools.
- [x] Default to deny-all permissions when no approval policy is supplied.
- [x] Add deterministic tests with a fake model adapter.
- [x] Wire OpenAI-compatible structured tool calls into the agent runtime.
- [x] Show proposed tool arguments and require explicit per-call approval in the chat UI.
- [x] Add a bounded, read-only workspace file-listing tool as the first executable tool.
- [ ] Verify interactively against a local model that supports tool calling.

## Phase 4 — MCP client (implementation in this PR)

- [x] Add server configuration schema and runtime validation.
- [x] Connect to stdio MCP servers only after explicit confirmation.
- [x] Discover tools and forward their JSON Schemas to compatible models.
- [x] Validate tool arguments and gate execution through host-side per-call permissions.
- [x] Add Streamable HTTP transport and SecretStorage-backed static bearer tokens.
- [x] Browse MCP resources and preview bounded text content locally without automatically adding it to model context.
- [x] Discover MCP prompts, collect declared string arguments, and preview returned messages locally.
- [x] Add connection/disconnection commands, timeouts, pagination limits, and bounded tool output.
- [x] Attach a reviewed MCP resource or prompt to the next chat message only after explicit confirmation; bound and label the content as untrusted request-scoped context.
- [x] Handle MCP resource update, resource-list, prompt-list, and tool-list notifications; retain bounded diagnostics and redact resource URI query strings/fragments.
- [x] Automatically refresh bounded discovered tool schemas after tool-list-change notifications without bypassing per-call approval.
- [x] Report unexpected MCP transport errors and closures, remove disconnected tools from the active registry, and require deliberate reconnection.
- [x] Add a dedicated reconnect command that lists only disconnected configured servers and repeats the explicit configuration-review confirmation.
- [ ] Add OAuth and optional config importers after canonical configuration is stable.
- [ ] Verify interactively against a trusted local stdio server and remote Streamable HTTP server.

## Phase 5 — Extension experience

- [x] Add MCP server status inspection for configured, connected, disconnected, and invalid configurations.
- [x] Show discovered tool counts and recent connection errors.
- [x] Add an Output channel for MCP connection diagnostics while omitting URL query strings and fragments from endpoint summaries.
- [x] Add a repeatable VSIX package command with development files excluded.
- [x] Verify VSIX contents in CI and upload the package as a short-lived build artifact.
- [x] Document VSIX installation and a manual smoke-test checklist.
- [x] Add automated Extension Development Host coverage to CI (activation, command registration, and Open Chat entry point).
- [x] Test structured tool calling through a local mock model server and verify that denied calls never execute.
- [ ] Manually install and exercise the packaged extension in VS Code.
- [x] Add opt-in, bounded workspace-scoped conversation persistence (disabled by default).
- [x] Add a command to clear the saved conversation.
- [x] Validate persisted conversation structures and guard clear-history against in-flight request races.
- [x] Add a settings shortcut and clearer, one-invocation approval controls.
- [x] Add live status announcements, semantic approval groups, keyboard focus handling, and accessible error alerts.
- [ ] Manually verify keyboard-only and screen-reader behavior in VS Code.

## Phase 6 — Extensibility

- [x] Add a pure skill registry with versioned manifest validation, enable/disable controls, bounded metadata, and deterministic keyword-based context selection.
- [x] Load skills from documented workspace/user locations only when explicitly enabled, and expose selected instructions to request-scoped agent context.
- [x] Add a pure versioned workflow manifest registry and immutable state machine for instruction steps and explicit approval checkpoints.
- [x] Add opt-in, bounded workflow file loading from workspace and user storage, plus a native VS Code command UI for instruction and approval steps.
- [x] Keep workflow approval separate from per-tool approval; workflows do not execute tools or arbitrary code.
- [x] Integrate host-generated workflow progress into the chat webview and persist/resume validated run snapshots.
- [x] Add declarative workflow conditions based on prior step outcomes, explicit skipped-step records, and opt-in continuation after approval denial.
- [x] Add bounded manual retry policies for instruction steps, with a total-attempt limit, persisted attempt counts, and explicit retry/cancel decisions.
- [x] Add opt-in local Markdown/text knowledge indexing and bounded lexical retrieval into request-scoped agent context.
- [x] Improve lexical ranking by ignoring common stopwords and requiring exact token matches; add regression tests for natural-language queries and substring false positives.
- [ ] Add richer source providers and optional semantic/vector retrieval.
- [x] Document current extension seams, security invariants, and compatibility expectations; explicitly state that there is not yet a stable third-party TypeScript plugin API.

- [ ] Add richer source providers and optional semantic/vector retrieval.

## Definition of done for a milestone

- Type-check and tests pass.
- Security boundaries are documented.
- README and examples reflect actual behavior.
- No feature is described as working until it has been exercised.
