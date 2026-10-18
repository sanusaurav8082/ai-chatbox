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

## Smoke-test checklist

1. Open the Command Palette and run **AI Chatbox: Open Chat**.
2. Confirm the chat view opens and can show a response from a configured OpenAI-compatible model or OpenAI.
3. Run **AI Chatbox: Show MCP Server Status**. With no MCP servers configured, it should explain how to configure them.
4. Configure a trusted test MCP server, then run **AI Chatbox: Connect MCP Server**. Review the connection confirmation before accepting.
5. Confirm the status command shows the connected server and discovered tool count.
6. If the model proposes an MCP tool call, verify the per-call approval UI still appears before execution.
7. Run **AI Chatbox: Show MCP Diagnostics** and confirm the Output panel opens.

Do not test against an MCP server you do not trust. A successful package build or CI run verifies package structure, not live model-provider or third-party MCP interoperability.

## Uninstall

```bash
code --uninstall-extension sanusaurav8082.ai-chatbox
```

If you installed an older development build, uninstall/reinstall as needed before smoke testing the packaged version.
