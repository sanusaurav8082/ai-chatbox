# Roadmap

The roadmap is intentionally incremental. Each milestone should leave the main branch in a buildable state.

## Phase 1 — Foundation (current)

- [x] Create extension manifest and TypeScript build.
- [x] Register `AI Chatbox: Open Chat`.
- [x] Render a theme-aware webview chat UI.
- [x] Add a validated, bounded webview-to-host message bridge.
- [x] Add a strict starter CSP and no local webview resource access.
- [ ] Verify build and run in the VS Code Extension Development Host.
- [ ] Add automated tests and CI.

## Phase 2 — Model connectivity

- [ ] Define model/provider interfaces and capabilities.
- [ ] Add provider configuration and SecretStorage-backed credentials.
- [ ] Add one cloud provider and one OpenAI-compatible local endpoint.
- [ ] Stream model output to the chat UI.
- [ ] Handle cancellation, timeouts, and provider errors.

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
- [ ] Add CI for type-checking, tests, and packaging.
- [ ] Add conversation persistence and settings UI.
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
