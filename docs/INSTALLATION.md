# Install and smoke-test the VSIX

## Build the package

Requirements: Node.js 20+, npm, and VS Code.

```bash
npm install
npm run package
```

The command type-checks the TypeScript, bundles the extension, and writes `ai-chatbox-0.5.0.vsix` in the repository root. The VSIX is a local artifact and is not committed.

## Install locally

From the repository root:

```bash
code --install-extension ./ai-chatbox-0.5.0.vsix
```

Alternatively, open VS Code → Extensions → **…** → **Install from VSIX…** and select the file. Reload the window if VS Code prompts you.

## Automated Extension Development Host test

The integration test launches a real VS Code Extension Development Host and verifies extension activation, core command registration, documented command contributions, opt-in privacy-sensitive settings defaults, and the Open Chat command entry point. It also starts a loopback-only mock HTTP model server and exercises streaming, request cancellation, and the real OpenAI-compatible adapter/agent loop through a structured tool proposal, checking both allow and deny outcomes. It does not call an external model API. It also starts a loopback-only MCP Streamable HTTP server using the official SDK, verifies connection and tool discovery, checks the discovered JSON Schema is forwarded through the real model adapter, and confirms approved calls execute while denied calls never reach the MCP server. The same fixture also verifies MCP resource listing/reading and prompt listing/retrieval through the manager, and sends resource-updated and tool-list-change notifications through the SDK server to verify URI query/fragment redaction and automatic tool-schema refresh. Unit tests cover bounded, untrusted MCP context formatting; integration checks verify attachment commands are registered.

```bash
npm install
npm run test:integration
```

The first run downloads a compatible VS Code test instance. CI runs this alongside unit tests and VSIX packaging. This automated check complements—but does not replace—the manual checks below, especially live model responses, trusted MCP interoperability, keyboard-only navigation, and screen-reader behavior.

## Smoke-test checklist

1. Open the Command Palette and run **AI Chatbox: Open Chat**.
2. Confirm the chat view opens and can show a response from a configured OpenAI-compatible model or OpenAI.
3. Run **AI Chatbox: Show MCP Server Status**. With no MCP servers configured, it should explain how to configure them.
4. Configure a trusted test MCP server, then run **AI Chatbox: Connect MCP Server**. Review the connection confirmation before accepting.
5. Confirm the status command shows the connected server and discovered tool count.
6. If the model proposes an MCP tool call, verify the per-call approval UI still appears before execution.
7. Run **AI Chatbox: Browse MCP Resources** or **AI Chatbox: Browse MCP Prompts** and inspect locally previewed content from the connected server.
8. To include selected content in a model request, run **AI Chatbox: Attach MCP Resource to Next Message** or **AI Chatbox: Attach MCP Prompt to Next Message**. Review the confirmation preview and choose **Attach Once**; send a chat message to use it. The attachment is one-shot. Run **AI Chatbox: Clear Pending MCP Context** to remove it before sending.
9. Run **AI Chatbox: Show MCP Diagnostics** and confirm the Output panel opens. MCP notifications, when sent by a server, appear in this channel; resource content is never read automatically in response to a notification. If the server reports a tool-list change, AI Chatbox refreshes the discovered tool schemas automatically for subsequent chat turns. Tool calls still require explicit approval. If a connection closes unexpectedly, AI Chatbox removes its tools and reports the failure stage and a suggested next step in the Output channel; it never restarts a local process automatically.
10. Run **AI Chatbox: Reconnect MCP Server** to select a disconnected or failed server. Review the displayed command or sanitized endpoint in the confirmation dialog before connecting. Reconnection is always user-initiated, and every tool call continues to require separate approval.
11. If connection fails, run **AI Chatbox: Show MCP Server Status** and read the failure stage and suggested action. The Output channel distinguishes configuration, transport connection, tool discovery, tool-schema refresh, and unexpected-disconnect issues. Error details are bounded; endpoint query strings and fragments must not appear in diagnostics.

Do not test against an MCP server you do not trust. A successful package build or CI run verifies package structure, not live model-provider or third-party MCP interoperability.

## Conversation persistence and privacy

Conversation persistence is disabled by default. To enable it, set `aiChatbox.persistConversation` to `true` in VS Code Settings. When enabled, the bounded conversation history is stored in VS Code workspace state for the current workspace and restored when the chat is reopened. This may include prompts, model responses, and tool outputs; enable it only if that is appropriate for your workspace. Run **AI Chatbox: Clear Saved Conversation** to remove the saved history. Turning persistence off stops future saves and removes the stored copy the next time the chat is opened or updated.

## Uninstall

```bash
code --uninstall-extension sanusaurav8082.ai-chatbox
```

If you installed an older development build, uninstall/reinstall as needed before smoke testing the packaged version.
