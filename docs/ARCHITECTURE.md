# Architecture

## Goals

AI Chatbox is a learning-first AI chat and coding agent distributed as a VS Code extension. We will implement the agent loop and policy layer ourselves so that model/tool orchestration remains understandable.

## Runtime boundaries

- **Webview UI:** renders the conversation and sends typed messages. It must not hold provider credentials, start processes, access the filesystem, or call model APIs directly.
- **Extension host:** owns configuration, model/provider clients, agent runtime, MCP connections, permissions, and VS Code APIs.
- **Model adapters:** normalize provider-specific streaming and tool-call behavior behind a small interface.
- **Agent runtime:** builds context, asks the model for a response, validates proposed tool calls, requests approval where required, executes permitted tools, and returns tool results to the model.
- **MCP manager:** owns configured server lifecycle and maps MCP tool schemas/results into the agent's internal tool format.
- **Extension points:** skills, workflows/SOPs, and knowledge sources will be added behind explicit interfaces.

## Intended message flow

```text
React/Webview UI
  -- validated postMessage -->
Extension message router
  --> AgentRuntime
      --> Model adapter
      <-- text deltas / tool proposals
      --> PermissionService
      --> Tool registry (built-in or MCP)
      <-- bounded tool result
      --> Model adapter (continue loop)
  <-- typed agent events
Webview UI
```

The current Phase 1 scaffold uses a local echo instead of a model. This keeps the UI/extension-host bridge testable before model integration is introduced.

## Security principles

1. Treat every webview message as untrusted input and validate its shape and size in the extension host.
2. Use a strict Content Security Policy and restrict webview local resource roots.
3. Store credentials using VS Code SecretStorage; never put secrets in workspace settings, source control, or webview state.
4. Distinguish MCP server discovery from connection and tool authorization.
5. Never execute a tool just because a model requested it. Apply policy and approval checks in our own host-side permission service.
6. Bound model iterations, tool duration, output size, and concurrent work; support cancellation.
7. Treat tool output and retrieved documents as untrusted data, not instructions that override system policy.

## Model support

A model registry will identify provider, model ID, endpoint, and capabilities. We will prefer provider adapters where practical and use OpenAI-compatible endpoints for local servers such as Ollama or LM Studio when their API mode supports it. Credentials remain in SecretStorage.

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
