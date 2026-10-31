# Extension interfaces and compatibility policy

This document describes the current seams that make AI Chatbox extensible, what is safe to build against today, and how changes should preserve existing user data and security boundaries.

## Stability levels

AI Chatbox is still an early, learning-first project. **It does not yet offer a stable third-party TypeScript plugin API.** The exported types and functions in `src/` are useful architectural seams and test targets, but they are internal implementation interfaces and may change between releases.

Use the documented settings, commands, and JSON manifest formats when configuring the extension. Manifest formats are user-facing data contracts, but they are not currently governed by a separate schema registry or formal migration framework. Validate every file on load and skip invalid input rather than trusting it.

Until a formal public API is announced:

- Treat `src/` module exports as internal, not as a compatibility promise.
- Treat documented VS Code settings, command IDs, and skill/workflow/knowledge file locations as supported user-facing behavior for the current release.
- Do not assume an undocumented field, file path, event, or storage key is stable.
- Keep changes backward compatible where practical, and document any intentional behavior or format change.

## Main extension seams

| Area | Current seam | What it allows today | Important limit |
| --- | --- | --- | --- |
| Model connectivity | `ModelClient` and the agent model adapter in `src/modelClient.ts` / `src/agentModelAdapter.ts` | OpenAI and OpenAI-compatible chat requests; structured tool proposals through the adapter | Tool calling depends on the selected model/server implementing the expected Chat Completions fields. There is no provider plug-in discovery API. |
| Agent orchestration | `AgentRuntime`, model adapter, tool definitions/registry, and permission service in `src/agentRuntime.ts` | Testable provider-independent loop with bounded iterations/history/output and explicit per-call authorization | New tools must validate input and pass through the same host-side permission decision. A model proposal is never authorization. |
| MCP | `src/mcpManager.ts` and `aiChatbox.mcpServers` configuration | Explicitly approved stdio and Streamable HTTP connections, tool discovery, schema validation, and tool calls through agent approval | Only connect to trusted servers. OAuth, resources, prompts, notifications, and config importers are not current supported features. |
| Skills | JSON manifests in `.ai-chatbox/skills/*.json` and user storage; registry/loader modules | Optional, bounded, keyword-selected plain-text instructions | Skills cannot register tools or execute code. Loading is off by default; content is untrusted. |
| Workflows/SOPs | Versioned JSON manifests in `.ai-chatbox/workflows/*.json` and user storage | Ordered instruction and approval steps, declarative conditions, manual retry, and resumable progress | Workflows display checklists; they do not execute commands/tools or grant permissions. Loading is off by default. |
| Knowledge | Markdown/text files in `.ai-chatbox/knowledge/` and user storage | Optional bounded lexical retrieval into request-scoped context | No semantic/vector retrieval or persisted index yet. Retrieved excerpts are sent to the configured model when enabled. |
| UI ↔ extension host | Validated VS Code webview message bridge | UI events and host-generated response/progress updates | The webview is untrusted presentation code; it must not own credentials, filesystem/process access, model calls, or tool authorization. |

The exact TypeScript signatures can be inspected in the named source files and are covered by unit tests. These modules are intentionally small so their contracts can be learned and tested without adopting a large agent framework.

## Security invariants for extensions

Any new provider, tool, source, workflow action, or UI feature must preserve these invariants:

1. **Host owns authority.** Credentials, network/model calls, MCP transports, filesystem operations, and permission decisions stay in the extension host.
2. **Validate at boundaries.** Treat settings, webview messages, model output, MCP schemas/results, persisted snapshots, and user-authored manifests as untrusted input.
3. **Approval is per action.** Discovering a tool or approving a workflow checkpoint does not authorize a tool call. Every executable tool invocation goes through the agent runtime's per-call permission service.
4. **Bound resource use.** Set explicit limits for file counts/sizes, context, history, model iterations, tool calls, outputs, and timeouts. Cancellation must not accidentally turn a denied or missing decision into permission.
5. **Keep untrusted text in context.** Skills and retrieved knowledge are reference material, not executable instructions that override system policy. Never evaluate manifest text as code.
6. **Protect secrets and diagnostics.** Use VS Code SecretStorage for credentials. Avoid logging tokens, full authorization headers, or URL query strings/fragments.
7. **Keep rendering safe.** Render model/tool/user text as text, not HTML; validate messages from the webview in the host.

A new extension point is not complete merely because it can be called. Include validation, bounds, denial/cancellation tests, error handling, and documentation of what data leaves the machine.

## Compatibility and change policy

These rules guide future changes; they are not a claim that a formal stable public SDK already exists.

- **Settings and commands:** Preserve existing IDs and documented semantics when possible. If a setting must change, provide a clear default and migration/deprecation path where feasible.
- **Manifest files:** Continue validating schema and limits at load time. Prefer additive optional fields with safe defaults. Reject unsupported required semantics rather than silently interpreting them. Keep existing example files valid or update them in the same change.
- **Persisted data:** Version storage formats when a structural change requires it. Validate old snapshots on read, tolerate documented legacy forms where feasible, and skip corrupt records instead of crashing activation.
- **Agent/tool behavior:** Preserve the default-deny permission model and per-call approval. Never broaden authority as an incidental effect of a refactor.
- **Tests and docs:** Add focused tests for accepted/rejected inputs and state transitions. Update README, architecture, and the relevant feature guide in the same PR.
- **Breaking changes:** Call them out in the PR description and release notes; do not imply compatibility where it has not been tested.

## Adding a new capability

For a proposed provider, tool, source provider, or workflow feature:

1. Identify which existing seam owns it; avoid coupling the webview directly to the provider or data source.
2. Define the smallest typed contract and the validation/bounds at its input boundary.
3. Keep side effects behind the extension host and existing permission/approval paths.
4. Add deterministic unit tests using fake providers or in-memory inputs.
5. Add an example or configuration documentation and describe privacy implications.
6. Update `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` when the architecture or planned work changes.
7. Do not mark a feature complete until its automated checks pass; separately record any manual VS Code/model/MCP verification still outstanding.

## Current non-goals

The current seams are not a general third-party plugin system. There is no dynamic loading of arbitrary TypeScript/JavaScript plugins, no public provider registry, no automatic installation of MCP servers, and no guarantee that internal module exports remain source-compatible across versions.
