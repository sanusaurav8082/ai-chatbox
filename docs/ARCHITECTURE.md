# Architecture

## Goals

AI Chatbox is a learning-first AI chat and coding agent distributed as a VS Code extension. We will implement the agent loop and policy layer ourselves so that model/tool orchestration remains understandable.

## Runtime boundaries

- **Webview UI:** renders the conversation and sends typed messages. It must not hold provider credentials, start processes, access the filesystem, or call model APIs directly.
- **Extension host:** owns configuration, model/provider clients, agent runtime, MCP connections, permissions, and VS Code APIs.
- **Model clients:** the chat client streams text over SSE; `agentModelAdapter` uses non-streaming OpenAI Chat Completions responses to preserve structured tool-call IDs and arguments. The OpenAI provider uses the official API endpoint; the compatible provider uses a configured HTTP(S) base URL.
- **Agent runtime:** connected to an OpenAI-compatible structured tool-call adapter and chat approval UI. It accepts an adapter contract, a tool registry, and a permission service; validates tool inputs; asks for a decision before execution; bounds iterations, tool calls per turn, history, and output; and emits typed lifecycle events.
- **MCP manager:** planned component that owns configured server lifecycle and maps MCP tool schemas/results into the agent's internal tool format.
- **Extension points:** skills, workflows/SOPs, and knowledge sources will be added behind explicit interfaces.

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
- The compatible provider omits Authorization unless an API key is added in a future milestone.

The chat client uses streaming Chat Completions (`stream: true`) for text-only chat. The agent adapter uses `stream: false` because the runtime needs complete structured tool-call IDs and JSON arguments before permission checks. Tool calling varies by local server and model; use a model/server that supports the OpenAI-compatible `tools` and `tool_calls` fields. The first built-in tool lists at most 100 relative workspace file paths and is read-only.

## Security principles

1. Treat every webview message as untrusted input and validate its shape and size in the extension host.
2. Use a strict Content Security Policy and restrict webview local resource roots.
3. Store credentials using VS Code SecretStorage; never put secrets in workspace settings, source control, or webview state.
4. Distinguish MCP server discovery from connection and tool authorization.
5. Never execute a tool just because a model requested it. The runtime asks the host-side permission service before every execution; the default permission service denies all tools.
6. Bound model iterations, tool duration, output size, request duration, and concurrent work; support cancellation.
7. Treat tool output and retrieved documents as untrusted data, not instructions that override system policy.
8. Model text is rendered with `textContent`; it is not interpreted as HTML.

## MCP support

Implement MCP client support in stages:
1. stdio transport and explicit user-configured server definitions;
2. Streamable HTTP transport with explicit authentication configuration;
3. optional importers for external client configuration formats;
4. resources, prompts, and notifications after tool calls are stable.

A discovered server is not automatically trusted. Starting a stdio server can execute a local command, so the user must review the command and approve the connection.

## Future extension points

- **Skills:** versioned metadata, instructions, and optional resources/scripts.
- **Workflows/SOPs:** versioned step definitions with conditions, retries, and approval checkpoints.
- **Knowledge:** local files, SQLite full-text search, and eventually optional embedding/vector retrieval.

## Agent runtime contract

The runtime is intentionally provider-independent. A model adapter returns either a final text turn or a set of proposed tool calls. Registered tools supply an input validator and an executor. The permission service must explicitly return `allow`; any other decision is treated as denial. Tool output is serialized and truncated before being returned to the model. The runtime also limits iterations, tool calls per turn, history length, and output size.

The current implementation supports model-proposed tool calls and displays their arguments in the chat panel. Each tool call waits for an explicit approval decision; cancellation or a missing decision does not authorize execution. Tool outputs are shown as text. The current built-in tool is read-only and bounded; MCP and file-writing tools are not yet implemented.
