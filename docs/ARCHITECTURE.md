# Architecture

## Goals

AI Chatbox is a learning-first AI chat and coding agent distributed as a VS Code extension. We will implement the agent loop and policy layer ourselves so that model/tool orchestration remains understandable.

## Runtime boundaries

- **Webview UI:** renders the conversation and sends typed messages. It must not hold provider credentials, start processes, access the filesystem, or call model APIs directly.
- **Extension host:** owns configuration, model/provider clients, agent runtime, MCP connections, permissions, and VS Code APIs.
- **Model client:** currently sends OpenAI Chat Completions requests and parses server-sent event (SSE) deltas. The OpenAI provider uses the official API endpoint; the compatible provider uses a configured HTTP(S) base URL.
- **Agent runtime:** planned component that builds context, asks the model for a response, validates proposed tool calls, requests approval where required, executes permitted tools, and returns tool results to the model.
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

Future agent flow:
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

The current client uses the streaming Chat Completions format: requests set `stream: true`, and the client emits string content from `choices[0].delta.content`. This intentionally supports a small, understandable contract rather than every provider-specific extension. Local server compatibility varies; configure the endpoint and model ID expected by the selected server.

## Security principles

1. Treat every webview message as untrusted input and validate its shape and size in the extension host.
2. Use a strict Content Security Policy and restrict webview local resource roots.
3. Store credentials using VS Code SecretStorage; never put secrets in workspace settings, source control, or webview state.
4. Distinguish MCP server discovery from connection and tool authorization.
5. Never execute a tool just because a model requested it. Apply policy and approval checks in our own host-side permission service.
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
