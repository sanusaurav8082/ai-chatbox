import * as vscode from "vscode";

type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string };

export class ChatView {
  private static currentPanel: vscode.WebviewPanel | undefined;

  static open(context: vscode.ExtensionContext): void {
    if (ChatView.currentPanel) {
      ChatView.currentPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "aiChatbox",
      "AI Chatbox",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );

    ChatView.currentPanel = panel;
    panel.webview.html = ChatView.getHtml(panel.webview);

    panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        if (!message || typeof message !== "object" || !("type" in message)) {
          return;
        }

        if (message.type === "ready") {
          const showWelcome = vscode.workspace
            .getConfiguration("aiChatbox")
            .get<boolean>("showWelcomeMessage", true);

          if (showWelcome) {
            await panel.webview.postMessage({
              type: "assistant",
              text: "Welcome! The chat UI is connected to the VS Code extension host. Model providers and the agent runtime will be added in the next milestone."
            });
          }
          return;
        }

        if (message.type === "send" && typeof message.text === "string") {
          const text = message.text.trim();
          if (!text || text.length > 20_000) {
            return;
          }

          // Phase 1 deliberately uses a local echo. Model calls will be routed
          // through AgentRuntime in a later milestone, never from the webview.
          await panel.webview.postMessage({
            type: "assistant",
            text: `I received: ${text}\n\nThis is the Phase 1 scaffold; model integration is the next milestone.`
          });
        }
      },
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(() => {
      if (ChatView.currentPanel === panel) {
        ChatView.currentPanel = undefined;
      }
    });
  }

  private static getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>AI Chatbox</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { padding: 0; margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .app { display: flex; flex-direction: column; height: 100vh; max-width: 900px; margin: 0 auto; }
    header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { margin: 0; font-size: 18px; font-weight: 600; }
    .sub { margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px 14px; border-radius: 8px; line-height: 1.5; }
    .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); align-self: flex-end; max-width: 85%; }
    .assistant { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); align-self: stretch; }
    form { padding: 14px 20px 20px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; }
    textarea { flex: 1; resize: vertical; min-height: 44px; max-height: 180px; padding: 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; font: inherit; }
    button { padding: 0 16px; border: 0; border-radius: 6px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .hint { padding: 0 20px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  </style>
</head>
<body>
  <main class="app">
    <header><h1>AI Chatbox</h1><div class="sub">Learning-first AI coding agent · Phase 1 foundation</div></header>
    <section id="messages" aria-live="polite" aria-label="Conversation"></section>
    <div class="hint">Starter scaffold only — no prompt is sent to an external model yet.</div>
    <form id="composer">
      <textarea id="prompt" aria-label="Message" placeholder="Ask something..." required></textarea>
      <button type="submit">Send</button>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const promptInput = document.getElementById("prompt");
    const form = document.getElementById("composer");

    function addMessage(role, text) {
      const item = document.createElement("div");
      item.className = "message " + role;
      item.textContent = text;
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight;
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = promptInput.value.trim();
      if (!text) return;
      addMessage("user", text);
      vscode.postMessage({ type: "send", text });
      promptInput.value = "";
      promptInput.focus();
    });

    promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "assistant" && typeof message.text === "string") {
        addMessage("assistant", message.text);
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
