import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { ChatMessage, ModelConfig, ModelProvider, streamChatCompletion } from "./modelClient";

export const OPENAI_API_KEY_SECRET = "aiChatbox.openaiApiKey";

type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" };

type ModelUiMessage =
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone" }
  | { type: "assistantError"; text: string };

const MAX_PROMPT_LENGTH = 20_000;
const MAX_HISTORY_MESSAGES = 20;

export class ChatView {
  private static currentPanel: vscode.WebviewPanel | undefined;
  private static activeRequest: AbortController | undefined;
  private static conversation: ChatMessage[] = [];

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
    ChatView.conversation = [];
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
              text: "Welcome to AI Chatbox. Choose a local OpenAI-compatible endpoint in settings, or switch aiChatbox.provider to openai and set your key using “AI Chatbox: Set OpenAI API Key”."
            });
          }
          return;
        }

        if (message.type === "cancel") {
          ChatView.activeRequest?.abort();
          return;
        }

        if (message.type === "send" && typeof message.text === "string") {
          const text = message.text.trim();
          if (!text || text.length > MAX_PROMPT_LENGTH || ChatView.activeRequest) {
            return;
          }
          await ChatView.runModelRequest(context, panel, text);
        }
      },
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(() => {
      if (ChatView.currentPanel === panel) {
        ChatView.activeRequest?.abort();
        ChatView.activeRequest = undefined;
        ChatView.currentPanel = undefined;
        ChatView.conversation = [];
      }
    });
  }

  private static async runModelRequest(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    text: string
  ): Promise<void> {
    const controller = new AbortController();
    ChatView.activeRequest = controller;
    ChatView.conversation.push({ role: "user", content: text });
    ChatView.conversation = ChatView.conversation.slice(-MAX_HISTORY_MESSAGES);

    let assistantText = "";
    let completed = false;
    await panel.webview.postMessage({ type: "assistantStart" } satisfies ModelUiMessage);

    try {
      const settings = vscode.workspace.getConfiguration("aiChatbox");
      const providerValue = settings.get<string>("provider", "openai-compatible");
      const provider: ModelProvider =
        providerValue === "openai" ? "openai" : "openai-compatible";
      const config: ModelConfig = {
        provider,
        modelId: settings.get<string>("modelId", "qwen2.5-coder:7b"),
        baseUrl: settings.get<string>("baseUrl", "http://localhost:11434/v1"),
        requestTimeoutMs: settings.get<number>("requestTimeoutMs", 120_000)
      };
      const apiKey =
        provider === "openai"
          ? await context.secrets.get(OPENAI_API_KEY_SECRET)
          : undefined;

      await streamChatCompletion({
        config,
        apiKey,
        messages: [...ChatView.conversation],
        signal: controller.signal,
        onDelta: (delta) => {
          assistantText += delta;
          void panel.webview.postMessage({
            type: "assistantDelta",
            text: delta
          } satisfies ModelUiMessage);
        }
      });

      completed = true;
      if (assistantText) {
        ChatView.conversation.push({ role: "assistant", content: assistantText });
        ChatView.conversation = ChatView.conversation.slice(-MAX_HISTORY_MESSAGES);
      } else {
        await panel.webview.postMessage({
          type: "assistantError",
          text: "The model returned no text. Check the selected model and endpoint."
        } satisfies ModelUiMessage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown model request failure.";
      ChatView.conversation = ChatView.conversation.filter(
        (item, index, messages) =>
          !(index === messages.length - 1 && item.role === "user" && item.content === text)
      );
      await panel.webview.postMessage({
        type: "assistantError",
        text: message
      } satisfies ModelUiMessage);
    } finally {
      await panel.webview.postMessage({ type: "assistantDone" } satisfies ModelUiMessage);
      if (ChatView.activeRequest === controller) {
        ChatView.activeRequest = undefined;
      }
      if (!completed && controller.signal.aborted) {
        // The error event is already shown; this branch documents cancellation semantics.
      }
    }
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
    .error { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
    form { padding: 14px 20px 20px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; }
    textarea { flex: 1; resize: vertical; min-height: 44px; max-height: 180px; padding: 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; font: inherit; }
    button { padding: 0 16px; border: 0; border-radius: 6px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .6; cursor: default; }
    button:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    #cancel { display: none; }
    .hint { padding: 0 20px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  </style>
</head>
<body>
  <main class="app">
    <header><h1>AI Chatbox</h1><div class="sub">Streaming model chat · Model calls run in the extension host</div></header>
    <section id="messages" aria-live="polite" aria-label="Conversation"></section>
    <div class="hint">Configure aiChatbox.provider, aiChatbox.modelId and aiChatbox.baseUrl in Settings. Use the command palette to manage your OpenAI API key.</div>
    <form id="composer">
      <textarea id="prompt" aria-label="Message" placeholder="Ask something..." required></textarea>
      <button id="send" type="submit">Send</button>
      <button id="cancel" type="button">Stop</button>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const promptInput = document.getElementById("prompt");
    const form = document.getElementById("composer");
    const sendButton = document.getElementById("send");
    const cancelButton = document.getElementById("cancel");
    let activeAssistant = null;

    function addMessage(role, text) {
      const item = document.createElement("div");
      item.className = "message " + role;
      item.textContent = text;
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight;
      return item;
    }

    function setBusy(busy) {
      sendButton.disabled = busy;
      promptInput.disabled = busy;
      cancelButton.style.display = busy ? "block" : "none";
      if (!busy) promptInput.focus();
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = promptInput.value.trim();
      if (!text || sendButton.disabled) return;
      addMessage("user", text);
      setBusy(true);
      activeAssistant = null;
      vscode.postMessage({ type: "send", text });
      promptInput.value = "";
    });

    cancelButton.addEventListener("click", () => {
      cancelButton.disabled = true;
      vscode.postMessage({ type: "cancel" });
    });

    promptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message.type !== "string") return;

      if (message.type === "assistant" && typeof message.text === "string") {
        addMessage("assistant", message.text);
      } else if (message.type === "assistantStart") {
        activeAssistant = addMessage("assistant", "");
      } else if (message.type === "assistantDelta" && typeof message.text === "string" && activeAssistant) {
        activeAssistant.textContent += message.text;
        messages.scrollTop = messages.scrollHeight;
      } else if (message.type === "assistantError" && typeof message.text === "string") {
        const errorItem = activeAssistant ?? addMessage("assistant", "");
        errorItem.classList.add("error");
        errorItem.textContent += (errorItem.textContent ? "\\n\\n" : "") + "Error: " + message.text;
      } else if (message.type === "assistantDone") {
        setBusy(false);
        cancelButton.disabled = false;
        activeAssistant = null;
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return randomBytes(16).toString("base64");
}
