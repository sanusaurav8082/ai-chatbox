# AI Chatbox

A learning-first, extensible AI chatbox and coding agent for Visual Studio Code. The goal is to build the important pieces—model adapters, the agent loop, MCP integration, and permissions—so the architecture stays understandable rather than hiding everything behind a large framework.

> **Current status: Phase 1 foundation.** The extension opens a chat webview and demonstrates the UI-to-extension-host message bridge with a local echo. It does **not** call an LLM or execute tools yet.

## Current features

- VS Code command: **AI Chatbox: Open Chat**
- Theme-aware chat UI with Enter-to-send and Shift+Enter for a newline
- Typed message contract and basic validation in the extension host
- Strict starter Content Security Policy; webview has no local file resource roots
- Architecture and milestone roadmap
- VS Code Extension Development Host launch configuration

## Prerequisites

- Node.js 20 or newer (Node.js 20 LTS is a good baseline)
- npm
- Visual Studio Code

## Run locally

```bash
npm install
npm run check-types
npm run build
```

Then open this folder in VS Code, press **F5**, and in the Extension Development Host run **AI Chatbox: Open Chat** from the Command Palette.

To rebuild automatically while editing:

```bash
npm run watch
```

To package an installable VSIX (after building):

```bash
npm run package
```

The generated `.vsix` is a local build artifact and is intentionally excluded from Git.

## Project layout

```text
src/
  extension.ts      Extension activation and command registration
  chatView.ts       Webview panel, message bridge, starter UI
docs/
  ARCHITECTURE.md   Runtime boundaries and security principles
  ROADMAP.md        Incremental implementation plan
.vscode/
  launch.json       F5 Extension Development Host configuration
  tasks.json        Build task
esbuild.mjs         Extension bundler
package.json        VS Code manifest and developer scripts
```

## Architecture principles

- The extension host owns model clients, credentials, tools, MCP processes, and permissions.
- The webview is an untrusted presentation layer; it must not hold API keys or execute tools.
- Model output and tool requests will pass through an explicit agent runtime and host-side policy checks.
- Discovering an MCP server will not automatically authorize connecting to it or executing its tools.
- Secrets will use VS Code `SecretStorage`, not source control, webview state, or ordinary settings.
- Keep each milestone buildable, tested, and documented.

Read [the architecture](docs/ARCHITECTURE.md) and [the roadmap](docs/ROADMAP.md) before starting the next phase.

## Development scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Bundle the extension to `dist/extension.js` |
| `npm run watch` | Watch and rebuild extension sources |
| `npm run check-types` | Run the TypeScript type checker |
| `npm test` | Run Node's built-in test runner |
| `npm run package` | Type-check, build, and create a VSIX |

## Planned work

1. Multi-provider model layer (cloud and OpenAI-compatible local endpoints)
2. Streaming, conversation state, cancellation, and error handling
3. A transparent agent loop with tool approval and execution limits
4. MCP client: stdio first, then Streamable HTTP
5. MCP configuration importers, VSIX distribution, and CI
6. Skills, SOP/workflows, and knowledge retrieval

See [docs/ROADMAP.md](docs/ROADMAP.md) for acceptance criteria and status.

## License

MIT. See [LICENSE](LICENSE).
