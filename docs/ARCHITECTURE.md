# Architecture

## Goals

AI Chatbox is a learning-first AI chat and coding agent distributed as a VS Code extension. We will implement the agent loop and policy layer ourselves so that model/tool orchestration remains understandable.

## Runtime boundaries

- **Webview UI:** renders the conversation and sends typed messages. It must not hold provider credentials, start processes, access the filesystem, or call model APIs directly.
- **Extension host:** owns configuration, model/provider clients, agent runtime, MCP connections, permissions, and VS Code APIs.
- **Model clients:** the chat client streams text over SSE; `agentModelAdapter` uses non-streaming OpenAI Chat Completions responses to preserve structured tool-call IDs and arguments. The OpenAI provider uses the official API endpoint; the compatible provider uses a configured HTTP(S) base URL.
- **Agent runtime:** connected to an OpenAI-compatible structured tool-call adapter and chat approval UI. It accepts an adapter contract, a tool registry, and a permission service; validates tool inputs; asks for a decision before execution; bounds iterations, tool calls per turn, history, and output; and emits typed lifecycle events.
- **MCP manager:** owns explicitly approved stdio and Streamable HTTP connections, discovers tool schemas, validates arguments against JSON Schema, maps calls/results into the agent's internal tool format, and closes transports on disconnect/deactivation.
- **Skills:** when `aiChatbox.skillsEnabled` is explicitly enabled, the extension host loads bounded JSON manifests from workspace `.ai-chatbox/skills/` and user global storage, validates them through the skill registry, and adds up to five matching instructions to the current request. Skill context is labeled untrusted and never persisted as conversation history.
- **Workflow runtime:** validates versioned SOP definitions and advances an immutable, sequential run state machine. Instruction steps require an explicit host transition; approval checkpoints pause the run until a matching approval decision. The current pure runtime does not load workflow files or execute tools.

## Intended message flow

```text
Webview UI
  -- validated postMessage -->
Extension host
  --> Model client
      --> OpenAI or OpenAI-compatible HTTP endpoint
      <-- streamed text deltas
  <-- typed streaming events
Webview UI

Agent flow:
Extension host --> AgentRuntime --> Model adapter
                           <-- text deltas / tool proposals
                           --> PermissionService --> Tool registry (built-in or MCP)
                           <-- bounded tool result
                           --> Model adapter (continue loop)
```

The webview receives text events only. It never receives the API key and never performs model requests itself. The host keeps a bounded in-memory conversation history for the lifetime of the chat panel; closing the panel clears it.

## Model configuration

- `aiChatbox.provider`: `openai` or `openai-compatible`.
- `aiChatbox.modelId`: provider-specific model identifier.
- `aiChatbox.baseUrl`: base URL for compatible endpoints; the OpenAI provider always uses `https://api.openai.com/v1`.
- `aiChatbox.requestTimeoutMs`: request timeout bounded to 1–300 seconds.
- OpenAI credentials are managed through extension commands and VS Code `SecretStorage`, never ordinary settings or webview state.
- The compatible model provider omits Authorization unless an API key is added in a future milestone. MCP HTTP bearer tokens are stored separately in VS Code SecretStorage.

The chat client uses streaming Chat Completions (`stream: true`) for text-only chat. The agent adapter uses `stream: false` because the runtime needs complete structured tool-call IDs and JSON arguments before permission checks. Tool calling varies by local server and model; use a model/server that supports the OpenAI-compatible `tools` and `tool_calls` fields. The first built-in tool lists at most 100 relative workspace file paths and is read-only.

## Security principles

1. Treat every webview message as untrusted input and validate its shape and size in the extension host.
2. Use a strict Content Security Policy and restrict webview local resource roots.
3. Store credentials using VS Code SecretStorage; never put secrets in workspace settings, source control, or webview state.
4. Distinguish MCP server discovery from connection and tool authorization.
5. Never execute a tool just because a model requested it. The runtime asks the host-side permission service before every execution; the default permission service denies all tools.
6. Bound model iterations, tool duration, output size, request duration, and concurrent work; support cancellation.
7. Treat tool output, skill instructions, and retrieved documents as untrusted data, not instructions that override system policy. Retrieved knowledge is bounded and request-scoped; source paths are included so the model can cite where information came from.
9. Explicitly attached MCP resources/prompts are user-confirmed, bounded, one-request context. Their contents are still untrusted and never grant tool permissions.
8. Model text is rendered with `textContent`; it is not interpreted as HTML.

## MCP support

`aiChatbox.mcpServers` is a named object in VS Code settings. Each entry is either a stdio configuration (`command`, optional `args`, `cwd`, `env`) or a Streamable HTTP configuration (`url`). Configuration is validated before connecting. Stdio processes inherit only a small environment allowlist plus explicitly configured variables; remote endpoints must use HTTPS, with localhost HTTP allowed for development. Credentials must not be embedded in URLs or settings. A per-server bearer token can be stored in VS Code SecretStorage.

Connections are initiated only through **AI Chatbox: Connect MCP Server**, which displays the command or URL and requires explicit confirmation before process launch/network connection. Connecting only discovers tools; every tool invocation still passes through the same per-call approval UI as built-in tools. Tool arguments are checked against server-provided JSON Schema using Ajv. Tool names are prefixed with the server name, discovery and output are bounded, and the manager closes clients on disconnect or extension deactivation. **AI Chatbox: Show MCP Server Status** reports configured-server state, transport, discovered tool count, and recent connection errors. **AI Chatbox: Show MCP Diagnostics** opens the `AI Chatbox MCP` Output channel. Diagnostic endpoint summaries omit URL query strings and fragments to reduce accidental credential exposure.

The current implementation supports stdio and Streamable HTTP with static bearer tokens. **AI Chatbox: Browse MCP Resources** lists resources from a connected server and previews a selected resource in the local `AI Chatbox MCP Content` output channel. **AI Chatbox: Browse MCP Prompts** lists prompts, collects declared string arguments, and previews the returned messages in that same local channel. To use selected content in a request, run **AI Chatbox: Attach MCP Resource to Next Message** or **AI Chatbox: Attach MCP Prompt to Next Message**. The extension shows a bounded preview and asks for explicit confirmation; after confirmation, the selected content is attached to the next chat message only. **AI Chatbox: Clear Pending MCP Context** cancels a queued attachment. Attachments are bounded, labeled as untrusted reference material, never elevate MCP prompt roles to system/developer roles, and are excluded from persisted conversation history. They are sent to the configured model only after confirmation. OAuth, external config importers, and MCP notifications remain follow-up work. Treat an MCP server as an untrusted external program/service: connection approval is not a guarantee that its tools are safe.

## Future extension points

- **Skills:** versioned JSON manifests with instructions and keywords; discovery is opt-in, instructions are plain text, and scripts/resources are not executed.
- **Workflows/SOPs:** versioned JSON manifests loaded only when `aiChatbox.workflowsEnabled` is enabled. The extension host reads bounded files from workspace and user-storage workflow directories and exposes a native VS Code command to step through instructions and approval checkpoints. The runner displays instructions rather than executing them; progress is posted to the chat webview by the extension host. Up to 10 validated run snapshots (200 KB total) are persisted in extension global state and can be resumed from the saved workflow version and step index. Every future tool action must still pass the independent per-invocation approval gate.
- **Knowledge:** the opt-in MVP reads bounded Markdown/text files from `.ai-chatbox/knowledge/` and user extension storage, builds a deterministic in-memory lexical index per request, and adds only a few matching excerpts as request-scoped untrusted context. The initial implementation does not persist an index, call an embedding service, or execute content.

## Workflow runtime contract

`workflowRuntime.ts` validates stable IDs, semantic versions, unique step IDs, supported step types, and bounded workflow/step text. `workflowRunStore.ts` validates persisted run snapshots and enforces storage bounds before the extension host resumes a run. A run snapshots the chosen version so registry updates cannot change an active run. A denied checkpoint cancels the workflow. Workflow approval is not a substitute for tool authorization: every actual tool call must continue to pass through the agent runtime's per-invocation permission service. Workflow definitions are untrusted data and are never evaluated as code. See [the workflow guide](WORKFLOWS.md).

## Agent runtime contract

The runtime is intentionally provider-independent. A model adapter returns either a final text turn or a set of proposed tool calls. Registered tools supply an input validator and an executor. The permission service must explicitly return `allow`; any other decision is treated as denial. Tool output is serialized and truncated before being returned to the model. The runtime also limits iterations, tool calls per turn, history length, and output size.

The current implementation supports model-proposed tool calls and displays their arguments in the chat panel. Approval controls are keyboard operable, label the one-invocation decision, move focus to the safe Deny action when an approval prompt appears, and announce status/errors through live regions. Each tool call waits for an explicit approval decision; cancellation or a missing decision does not authorize execution. The built-in workspace listing tool is read-only and bounded. Connected MCP tools are discovered dynamically, validated against their advertised schemas, and still require explicit approval. No arbitrary shell or file-writing tool is built in.


## Extension interfaces and compatibility

See [Extension interfaces and compatibility policy](EXTENSION-INTERFACES.md) for the current model/agent/MCP/skills/workflows/knowledge seams, security invariants, and compatibility guidance. The project does not yet promise a stable third-party TypeScript plugin API.
