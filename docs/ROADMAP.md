# Roadmap

The roadmap is intentionally incremental. Each milestone should leave the main branch in a buildable state.

## Phase 1 — Foundation

- [x] Create extension manifest and TypeScript build.
- [x] Register `AI Chatbox: Open Chat`.
- [x] Render a theme-aware webview chat UI.
- [x] Add a validated, bounded webview-to-host message bridge.
- [x] Add a strict starter CSP and no local webview resource access.
- [x] Add a CI workflow for type-checking, build, and tests.
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
- [x] Add connection/disconnection commands, timeouts, pagination limits, and bounded tool output.
- [ ] Add OAuth and optional config importers after canonical configuration is stable.
- [ ] Verify interactively against a trusted local stdio server and remote Streamable HTTP server.

## Phase 5 — Extension experience

- [x] Add MCP server status inspection for configured, connected, disconnected, and invalid configurations.
- [x] Show discovered tool counts and recent connection errors.
- [x] Add an Output channel for MCP connection diagnostics while omitting URL query strings and fragments from endpoint summaries.
- [x] Add a repeatable VSIX package command with development files excluded.
- [x] Verify VSIX contents in CI and upload the package as a short-lived build artifact.
- [x] Document VSIX installation and a manual smoke-test checklist.
- [ ] Manually install and exercise the packaged extension in VS Code.
- [x] Add opt-in, bounded workspace-scoped conversation persistence (disabled by default).
- [x] Add a command to clear the saved conversation.
- [x] Validate persisted conversation structures and guard clear-history against in-flight request races.
- [x] Add a settings shortcut and clearer, one-invocation approval controls.
- [x] Add live status announcements, semantic approval groups, keyboard focus handling, and accessible error alerts.
- [ ] Manually verify keyboard-only and screen-reader behavior in VS Code.

## Phase 6 — Extensibility

- [ ] Add skills and context-selection rules.
- [ ] Add versioned workflows/SOPs and approval checkpoints.
- [ ] Add knowledge sources, local indexing, and retrieval.
- [ ] Document extension interfaces and compatibility guarantees.

## Definition of done for a milestone

- Type-check and tests pass.
- Security boundaries are documented.
- README and examples reflect actual behavior.
- No feature is described as working until it has been exercised.
