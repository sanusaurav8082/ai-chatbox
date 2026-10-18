import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  AgentMessage,
  AgentRuntime,
  CallbackPermissionService,
  ToolApprovalDecision,
  ToolPermissionRequest
} from "./agentRuntime";
import { createAgentModelAdapter } from "./agentModelAdapter";
import { ModelConfig, ModelProvider } from "./modelClient";

export const OPENAI_API_KEY_SECRET = "aiChatbox.openaiApiKey";

type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "toolDecision"; toolCallId: string; decision: "allow" | "deny" };

type ModelUiMessage =
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone" }
  | { type: "assistantError"; text: string }
  | { type: "toolEvent"; event: string; toolCallId: string; name: string; input?: unknown; output?: string }
  | { type: "toolApprovalRequest"; toolCallId: string; name: string; input: unknown };

const MAX_PROMPT_LENGTH = 20_000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_TOOL_APPROVALS_PENDING = 8;

export class ChatView {
  private static currentPanel: vscode.WebviewPanel | undefined;
  private static activeRequest: AbortController | undefined;
  private static conversation: AgentMessage[] = [];
  private static pendingApprovals = new Map<string, {
    resolve: (decision: ToolApprovalDecision) => void;
    abort: () => void;
  }>();

  static open(context: vscode.ExtensionContext): void {
    if (ChatView.currentPanel) {
      ChatView.currentPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel("aiChatbox", "AI Chatbox", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: []
    });
    ChatView.currentPanel = panel;
    ChatView.conversation = [];
    panel.webview.html = ChatView.getHtml(panel.webview);

    panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;

      if (message.type === "ready") {
        const showWelcome = vscode.workspace.getConfiguration("aiChatbox")
          .get<boolean>("showWelcomeMessage", true);
        if (showWelcome) {
          await panel.webview.postMessage({
            type: "assistant",
            text: "Welcome to AI Chatbox. Tool calls are shown for review and require your approval before they run. Choose a local OpenAI-compatible endpoint in settings, or switch aiChatbox.provider to openai and set your key using “AI Chatbox: Set OpenAI API Key”."
          });
        }
        return;
      }
      if (message.type === "cancel") {
        ChatView.activeRequest?.abort();
        return;
      }
      if (message.type === "toolDecision") {
        if (typeof message.toolCallId !== "string" || message.toolCallId.length > 200 ||
            (message.decision !== "allow" && message.decision !== "deny")) return;
        const pending = ChatView.pendingApprovals.get(message.toolCallId);
        if (!pending) return;
        ChatView.pendingApprovals.delete(message.toolCallId);
        pending.abort();
        pending.resolve(message.decision);
        return;
      }
      if (message.type === "send" && typeof message.text === "string") {
        const text = message.text.trim();
        if (!text || ChatView.activeRequest) return;
        if (text.length > MAX_PROMPT_LENGTH) {
          await panel.webview.postMessage({ type: "assistantStart" } satisfies ModelUiMessage);
          await panel.webview.postMessage({
            type: "assistantError",
            text: `Message is too long. Keep prompts under ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`
          } satisfies ModelUiMessage);
          await panel.webview.postMessage({ type: "assistantDone" } satisfies ModelUiMessage);
          return;
        }
        await ChatView.runAgentRequest(context, panel, text);
      }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
      if (ChatView.currentPanel !== panel) return;
      ChatView.activeRequest?.abort();
      for (const [id, pending] of ChatView.pendingApprovals) {
        pending.abort();
        pending.resolve("deny");
        ChatView.pendingApprovals.delete(id);
      }
      ChatView.activeRequest = undefined;
      ChatView.currentPanel = undefined;
      ChatView.conversation = [];
    });
  }

  private static async runAgentRequest(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    text: string
  ): Promise<void> {
    const controller = new AbortController();
    ChatView.activeRequest = controller;
    ChatView.conversation.push({ role: "user", content: text });
    ChatView.conversation = ChatView.conversation.slice(-MAX_HISTORY_MESSAGES);
    await panel.webview.postMessage({ type: "assistantStart" } satisfies ModelUiMessage);

    try {
      const settings = vscode.workspace.getConfiguration("aiChatbox");
      const providerValue = settings.get<string>("provider", "openai-compatible");
      const provider: ModelProvider = providerValue === "openai" ? "openai" : "openai-compatible";
      const config: ModelConfig = {
        provider,
        modelId: settings.get<string>("modelId", "qwen2.5-coder:7b"),
        baseUrl: settings.get<string>("baseUrl", "http://localhost:11434/v1"),
        requestTimeoutMs: settings.get<number>("requestTimeoutMs", 120_000)
      };
      const apiKey = provider === "openai"
        ? await context.secrets.get(OPENAI_API_KEY_SECRET)
        : undefined;

      const tools = [{
        name: "list_workspace_files",
        description: "List relative file paths in the current VS Code workspace. Read-only; returns at most 100 paths. Optional input property pattern is a VS Code glob, for example src/**/*.ts.",
        validateInput(input: unknown): string | undefined {
          if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
          if (Object.keys(input).some((key) => key !== "pattern")) return "only the optional pattern property is supported";
          const pattern = (input as { pattern?: unknown }).pattern;
          if (pattern !== undefined && (typeof pattern !== "string" || pattern.length > 200)) {
            return "pattern must be a string of at most 200 characters";
          }
          return undefined;
        },
        async execute(input: unknown, signal: AbortSignal): Promise<unknown> {
          if (signal.aborted) throw new Error("Request cancelled.");
          if (!vscode.workspace.workspaceFolders?.length) return { files: [], note: "No workspace is open." };
          const pattern = (input as { pattern?: string }).pattern?.trim() || "**/*";
          const uris = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git}/**", 100);
          if (signal.aborted) throw new Error("Request cancelled.");
          return {
            files: uris.map((uri) => vscode.workspace.asRelativePath(uri, false)),
            truncated: uris.length === 100
          };
        }
      }];

      const permissions = new CallbackPermissionService(async (request) =>
        ChatView.requestToolApproval(panel, request, controller.signal)
      );
      const runtime = new AgentRuntime({
        model: createAgentModelAdapter({ config, apiKey }),
        tools,
        permissions,
        maxIterations: 8,
        maxHistoryMessages: MAX_HISTORY_MESSAGES
      });
      const result = await runtime.run({
        messages: ChatView.conversation,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "assistantDelta") {
            void panel.webview.postMessage({ type: "assistantDelta", text: event.text } satisfies ModelUiMessage);
          } else if (event.type === "toolProposed") {
            void panel.webview.postMessage({
              type: "toolEvent", event: "proposed", toolCallId: event.toolCallId, name: event.name, input: event.input
            } satisfies ModelUiMessage);
          } else if (event.type === "toolApprovalRequested") {
            void panel.webview.postMessage({
              type: "toolEvent", event: "approval-requested", toolCallId: event.toolCallId, name: event.name
            } satisfies ModelUiMessage);
          } else if (event.type === "toolStarted") {
            void panel.webview.postMessage({
              type: "toolEvent", event: "started", toolCallId: event.toolCallId, name: event.name
            } satisfies ModelUiMessage);
          } else if (event.type === "toolFinished") {
            void panel.webview.postMessage({
              type: "toolEvent", event: "finished", toolCallId: event.toolCallId, name: event.name, output: event.output
            } satisfies ModelUiMessage);
          } else if (event.type === "toolDenied") {
            void panel.webview.postMessage({
              type: "toolEvent", event: "denied", toolCallId: event.toolCallId, name: event.name
            } satisfies ModelUiMessage);
          } else if (event.type === "error") {
            void panel.webview.postMessage({ type: "assistantError", text: event.message } satisfies ModelUiMessage);
          }
        }
      });
      ChatView.conversation = result.messages.slice(-MAX_HISTORY_MESSAGES);
      if (!result.finalText && result.reason !== "cancelled") {
        await panel.webview.postMessage({
          type: "assistantError",
          text: "The model returned no text. Check that the selected model supports Chat Completions."
        } satisfies ModelUiMessage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown agent request failure.";
      ChatView.conversation = ChatView.conversation.filter(
        (item, index, messages) => !(index === messages.length - 1 && item.role === "user" && item.content === text)
      );
      await panel.webview.postMessage({ type: "assistantError", text: message } satisfies ModelUiMessage);
    } finally {
      await panel.webview.postMessage({ type: "assistantDone" } satisfies ModelUiMessage);
      if (ChatView.activeRequest === controller) ChatView.activeRequest = undefined;
    }
  }

  private static async requestToolApproval(
    panel: vscode.WebviewPanel,
    request: ToolPermissionRequest,
    signal: AbortSignal
  ): Promise<ToolApprovalDecision> {
    if (signal.aborted || ChatView.pendingApprovals.size >= MAX_TOOL_APPROVALS_PENDING) return "deny";
    const callId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
    return new Promise<ToolApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (decision: ToolApprovalDecision) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        ChatView.pendingApprovals.delete(callId);
        resolve(decision);
      };
      const onAbort = () => finish("deny");
      ChatView.pendingApprovals.set(callId, { resolve: finish, abort: () => signal.removeEventListener("abort", onAbort) });
      signal.addEventListener("abort", onAbort, { once: true });
      void panel.webview.postMessage({
        type: "toolApprovalRequest",
        toolCallId: callId,
        name: request.tool.name,
        input: request.input
      } satisfies ModelUiMessage);
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
body { padding:0; margin:0; color:var(--vscode-foreground); background:var(--vscode-editor-background); font-family:var(--vscode-font-family); }
.app { display:flex; flex-direction:column; height:100vh; max-width:900px; margin:0 auto; }
header { padding:16px 20px; border-bottom:1px solid var(--vscode-panel-border); }
h1 { margin:0; font-size:18px; font-weight:600; }
.sub { margin-top:5px; color:var(--vscode-descriptionForeground); font-size:12px; }
#messages { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:12px; }
.message { white-space:pre-wrap; overflow-wrap:anywhere; padding:12px 14px; border-radius:8px; line-height:1.5; }
.user { background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); align-self:flex-end; max-width:85%; }
.assistant { background:var(--vscode-sideBar-background); border:1px solid var(--vscode-panel-border); align-self:stretch; }
.error { border-color:var(--vscode-errorForeground); color:var(--vscode-errorForeground); }
.tool-card { border:1px solid var(--vscode-panel-border); border-radius:8px; padding:12px; background:var(--vscode-editorWidget-background); }
.tool-title { font-weight:600; margin-bottom:6px; }
.tool-input { white-space:pre-wrap; overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family); font-size:12px; margin:8px 0; }
.tool-actions { display:flex; gap:8px; margin-top:10px; }
form { padding:14px 20px 20px; border-top:1px solid var(--vscode-panel-border); display:flex; gap:8px; }
textarea { flex:1; resize:vertical; min-height:44px; max-height:180px; padding:10px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:6px; font:inherit; }
button { padding:8px 14px; border:0; border-radius:6px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; font:inherit; }
button:hover { background:var(--vscode-button-hoverBackground); }
button:disabled { opacity:.6; cursor:default; }
button:focus-visible, textarea:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:2px; }
#cancel { display:none; }
.hint { padding:0 20px 10px; color:var(--vscode-descriptionForeground); font-size:11px; }
</style>
</head>
<body>
<main class="app">
<header><h1>AI Chatbox</h1><div class="sub">Agent chat · Tool execution requires explicit approval</div></header>
<section id="messages" aria-live="polite" aria-label="Conversation"></section>
<div class="hint">Configure aiChatbox.provider, aiChatbox.modelId and aiChatbox.baseUrl in Settings. Use the command palette to manage your OpenAI API key.</div>
<form id="composer">
<textarea id="prompt" aria-label="Message" placeholder="Ask something..." maxlength="20000" required></textarea>
<button id="send" type="submit">Send</button><button id="cancel" type="button">Stop</button>
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
const toolCards = new Map();

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
function renderToolEvent(message) {
  let card = toolCards.get(message.toolCallId);
  if (!card) {
    card = document.createElement("div");
    card.className = "tool-card";
    const title = document.createElement("div");
    title.className = "tool-title";
    title.textContent = "Tool: " + message.name;
    card.appendChild(title);
    const detail = document.createElement("div");
    detail.className = "tool-input";
    detail.textContent = message.input === undefined ? "" : JSON.stringify(message.input, null, 2);
    card.appendChild(detail);
    const status = document.createElement("div");
    status.textContent = "Proposed by the model";
    card.appendChild(status);
    card._status = status;
    messages.appendChild(card);
    toolCards.set(message.toolCallId, card);
  }
  if (message.event === "started") card._status.textContent = "Approved · Running";
  else if (message.event === "finished") {
    card._status.textContent = "Completed";
    const output = document.createElement("pre");
    output.className = "tool-input";
    output.textContent = "Output: " + (message.output || "");
    card.appendChild(output);
  } else if (message.event === "denied") card._status.textContent = "Denied · Tool was not executed";
  messages.scrollTop = messages.scrollHeight;
}
function renderApproval(message) {
  const card = document.createElement("div");
  card.className = "tool-card";
  const title = document.createElement("div");
  title.className = "tool-title";
  title.textContent = "Approval required: " + message.name;
  card.appendChild(title);
  const detail = document.createElement("div");
  detail.className = "tool-input";
  detail.textContent = JSON.stringify(message.input, null, 2);
  card.appendChild(detail);
  const warning = document.createElement("div");
  warning.textContent = "Review the requested action and arguments before allowing it.";
  card.appendChild(warning);
  const actions = document.createElement("div");
  actions.className = "tool-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.textContent = "Approve once";
  const deny = document.createElement("button");
  deny.type = "button";
  deny.textContent = "Deny";
  const decide = (decision) => {
    approve.disabled = true;
    deny.disabled = true;
    vscode.postMessage({ type: "toolDecision", toolCallId: message.toolCallId, decision });
  };
  approve.addEventListener("click", () => decide("allow"));
  deny.addEventListener("click", () => decide("deny"));
  actions.append(approve, deny);
  card.appendChild(actions);
  messages.appendChild(card);
  messages.scrollTop = messages.scrollHeight;
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = promptInput.value.trim();
  if (!text || sendButton.disabled) return;
  addMessage("user", text);
  setBusy(true);
  activeAssistant = null;
  toolCards.clear();
  vscode.postMessage({ type: "send", text });
  promptInput.value = "";
});
cancelButton.addEventListener("click", () => {
  cancelButton.disabled = true;
  vscode.postMessage({ type: "cancel" });
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "assistant" && typeof message.text === "string") addMessage("assistant", message.text);
  else if (message.type === "assistantStart") activeAssistant = addMessage("assistant", "");
  else if (message.type === "assistantDelta" && typeof message.text === "string" && activeAssistant) {
    activeAssistant.textContent += message.text;
    messages.scrollTop = messages.scrollHeight;
  } else if (message.type === "assistantError" && typeof message.text === "string") {
    const errorItem = activeAssistant ?? addMessage("assistant", "");
    errorItem.classList.add("error");
    errorItem.textContent += (errorItem.textContent ? "\n\n" : "") + "Error: " + message.text;
  } else if (message.type === "toolEvent") renderToolEvent(message);
  else if (message.type === "toolApprovalRequest") renderApproval(message);
  else if (message.type === "assistantDone") {
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
