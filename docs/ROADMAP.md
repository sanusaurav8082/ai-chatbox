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

## Phase 3 — Agent runtime

- [ ] Define AgentEvent and AgentRuntime interfaces.
- [ ] Implement the model/tool-call loop without hiding it behind an agent framework.
- [ ] Add context assembly, conversation history, iteration bounds, and cancellation.
- [ ] Add tool approval and execution policy services.
- [ ] Add deterministic unit tests with a fake model adapter.

## Phase 4 — MCP client

- [ ] Add server configuration schema and validation.
- [ ] Connect to stdio MCP servers.
- [ ] Discover tools and normalize schemas.
- [ ] Gate tool execution through host-side permissions.
- [ ] Add Streamable HTTP transport and authentication.
- [ ] Add connection status, timeouts, and output limits.
- [ ] Add optional config importers after canonical configuration is stable.

## Phase 5 — Extension experience

- [ ] Package and install a VSIX.
- [ ] Add conversation persistence and richer settings/approval presentation.
- [ ] Improve accessibility and error/approval presentation.

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
