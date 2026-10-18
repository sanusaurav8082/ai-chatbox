# AI Chatbox

A learning-first, extensible AI chatbox and coding agent for Visual Studio Code. The goal is to build the important pieces—model adapters, the agent loop, MCP integration, and permissions—so the architecture stays understandable rather than hiding everything behind a large framework.

> **Current status: Phase 4 — agent tool-call integration.** OpenAI-compatible structured tool calls now connect to the agent runtime. The chat UI displays requested arguments and requires explicit per-call approval. The first built-in tool lists workspace file paths (read-only, maximum 100). MCP integration follows in a later phase.

## Current features

- VS Code command: **AI Chatbox: Open Chat**
- Theme-aware chat UI with Enter-to-send and Shift+Enter for a newline
- Streaming chat client support, agent Stop/cancel control, bounded conversation history, and readable errors
- OpenAI-compatible structured tool calls routed through the agent runtime
- Per-call approval UI showing tool arguments; denied tools are not executed
- Read-only workspace file listing tool with a 100-path limit
- OpenAI API support with credentials stored in VS Code SecretStorage
- OpenAI-compatible local endpoint support (for example, Ollama or LM Studio when its OpenAI-compatible API is enabled)
- Configurable provider, model ID, endpoint, and request timeout
- Strict webview Content Security Policy; webview has no local file resource roots
- Focused tests for endpoint validation, streaming, missing credentials, and HTTP errors
- Agent runtime with model adapter interface, tool registry, argument validation, explicit permission service, iteration/output/history bounds, and cancellation
- Safe default permission implementation that denies tool calls unless an approval decision explicitly allows them
- Deterministic fake-model tests for tool execution, denial, invalid arguments, unknown tools, cancellation, and limits

## Prerequisites

- Node.js 20 or newer
- npm
- Visual Studio Code
- Either an OpenAI API key, or a running model server exposing an OpenAI-compatible Chat Completions API

## Run locally

```bash
npm install
npm run check-types
npm test
npm run build
```

Then open this folder in VS Code, press **F5**, and in the Extension Development Host run **AI Chatbox: Open Chat** from the Command Palette.

### Option A: use a local model (default)

Start a local model server with its OpenAI-compatible API enabled. The defaults target Ollama's OpenAI-compatible endpoint:

- `aiChatbox.provider`: `openai-compatible`
- `aiChatbox.baseUrl`: `http://localhost:11434/v1`
- `aiChatbox.modelId`: set this to a model ID available from your server, for example `qwen2.5-coder:7b`

These values are VS Code settings; the model must already be installed and the server must be running. If you use LM Studio or another compatible server, set `aiChatbox.baseUrl` to its local API base URL and use the model ID it expects.

### Option B: use OpenAI

1. Set `aiChatbox.provider` to `openai`.
2. Run **AI Chatbox: Set OpenAI API Key** from the Command Palette and enter your key.
3. Set `aiChatbox.modelId` to a model available to your API account.
4. Open the chat and send a message.

Use **AI Chatbox: Clear OpenAI API Key** to remove the stored key. The key is stored with VS Code `SecretStorage`, not in settings or the webview. API usage may incur charges according to your provider's terms.

### Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `aiChatbox.provider` | `openai-compatible` | `openai-compatible` or `openai` |
| `aiChatbox.modelId` | `qwen2.5-coder:7b` | Model identifier sent to the endpoint |
| `aiChatbox.baseUrl` | `http://localhost:11434/v1` | Base URL for compatible endpoints; ignored for OpenAI |
| `aiChatbox.requestTimeoutMs` | `120000` | Request timeout, from 1 to 300 seconds |
| `aiChatbox.showWelcomeMessage` | `true` | Show initial setup guidance |

To rebuild automatically while editing:

```bash
npm run watch
```

To package an installable VSIX:

```bash
npm run package
```

The generated `.vsix` is a local build artifact and is intentionally excluded from Git.

## Project layout

```text
src/
  extension.ts      Extension activation and secure key commands
  chatView.ts       Webview panel, message bridge, streaming UI
  modelClient.ts    OpenAI-compatible HTTP/SSE chat client
  agentModelAdapter.ts  Structured Chat Completions tool-call adapter
  agentRuntime.ts   Model/tool loop, event contract, tool registry, permission gates
test/
  modelClient.test.cjs   Focused model client tests
  agentRuntime.test.cjs  Deterministic agent runtime tests
  agentModelAdapter.test.cjs  Structured tool-call adapter tests
docs/
  ARCHITECTURE.md   Runtime boundaries and security principles
  ROADMAP.md        Incremental implementation plan
.vscode/
  launch.json       F5 Extension Development Host configuration
  tasks.json        Build task
esbuild.mjs         Extension and testable model client bundler
package.json        VS Code manifest and developer scripts
```

## Architecture principles

- The extension host owns model clients, credentials, tools, MCP processes, and permissions.
- The webview is an untrusted presentation layer; it must not hold API keys or execute tools.
- Model output and tool requests will pass through an explicit agent runtime and host-side policy checks.
- Discovering an MCP server will not automatically authorize connecting to it or executing its tools.
- Secrets use VS Code `SecretStorage`, not source control, webview state, or ordinary settings.
- Keep each milestone buildable, tested, and documented.

Read [the architecture](docs/ARCHITECTURE.md) and [the roadmap](docs/ROADMAP.md) before starting the next phase.

## Development scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Bundle the extension and model client to `dist/` |
| `npm run watch` | Watch and rebuild TypeScript sources |
| `npm run check-types` | Run the TypeScript type checker |
| `npm test` | Build the model client and run focused tests |
| `npm run package` | Type-check, build, and create a VSIX |

## Planned work

1. Wire provider-native tool calling into the agent runtime and expose approval events in the chat UI
2. MCP client: stdio first, then Streamable HTTP
3. Conversation persistence and richer settings/approval UX
4. Skills, SOP/workflows, and knowledge retrieval

See [docs/ROADMAP.md](docs/ROADMAP.md) for acceptance criteria and status.

## License

MIT. See [LICENSE](LICENSE).
