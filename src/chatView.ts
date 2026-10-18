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
import { McpManager } from "./mcpManager";
import { MAX_HISTORY_MESSAGES, toTranscriptMessages, validateStoredConversation } from "./conversationStore";
import { formatSkillContext, loadSkillFiles, MAX_SKILL_FILES, MAX_SKILL_FILE_BYTES } from "./skillLoader";
import { buildKnowledgeIndex, formatKnowledgeContext, searchKnowledge, MAX_KNOWLEDGE_FILES, MAX_KNOWLEDGE_FILE_BYTES } from "./knowledgeIndex";
import { MAX_MCP_CONTEXT_CHARS } from "./mcpContext";

export const OPENAI_API_KEY_SECRET = "aiChatbox.openaiApiKey";

type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "toolDecision"; toolCallId: string; decision: "allow" | "deny" }
  | { type: "openSettings" };

type ModelUiMessage =
  | { type: "conversationRestore"; messages: Array<{ role: "user" | "assistant"; content: string }> }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone" }
  | { type: "assistantError"; text: string }
  | { type: "toolEvent"; event: string; toolCallId: string; name: string; input?: unknown; output?: string }
  | { type: "toolApprovalRequest"; toolCallId: string; name: string; input: unknown }
  | { type: "workflowProgress"; runId: string; workflowName: string; version: string; stepIndex: number; stepCount: number; status: string; stepTitle?: string; detail?: string }
  | { type: "mcpContextStatus"; attached: boolean; label?: string };

const MAX_PROMPT_LENGTH = 20_000;
const MAX_TOOL_APPROVALS_PENDING = 8;
const CONVERSATION_STORAGE_KEY = "aiChatbox.conversation.v1";

export class ChatView {
  private static currentPanel: vscode.WebviewPanel | undefined;
  private static activeRequest: AbortController | undefined;
  private static conversation: AgentMessage[] = [];
  private static conversationEpoch = 0;
  private static pendingMcpContext: string | undefined;
  private static pendingMcpContextLabel: string | undefined;
  private static pendingApprovals = new Map<string, {
    resolve: (decision: ToolApprovalDecision) => void;
    abort: () => void;
  }>();

  static canAttachMcpContext(): boolean {
    return Boolean(ChatView.currentPanel) && !ChatView.activeRequest;
  }

  static attachMcpContext(content: string, label: string): boolean {
    if (!ChatView.canAttachMcpContext() || !content.trim() || content.length > MAX_MCP_CONTEXT_CHARS) return false;
    ChatView.pendingMcpContext = content;
    ChatView.pendingMcpContextLabel = label.slice(0, 200);
    void ChatView.currentPanel!.webview.postMessage({
      type: "mcpContextStatus", attached: true, label: ChatView.pendingMcpContextLabel
    } satisfies ModelUiMessage);
    return true;
  }

  static clearPendingMcpContext(): boolean {
    if (!ChatView.currentPanel) return false;
    ChatView.pendingMcpContext = undefined;
    ChatView.pendingMcpContextLabel = undefined;
    void ChatView.currentPanel.webview.postMessage({ type: "mcpContextStatus", attached: false } satisfies ModelUiMessage);
    return true;
  }

  static showWorkflowProgress(message: {
    runId: string; workflowName: string; version: string; stepIndex: number; stepCount: number;
    status: string; stepTitle?: string; detail?: string;
  }): void {
    if (!ChatView.currentPanel || !/^[a-zA-Z0-9-]{1,100}$/.test(message.runId)) return;
    void ChatView.currentPanel.webview.postMessage({ type: "workflowProgress", ...message } satisfies ModelUiMessage);
  }

  static open(context: vscode.ExtensionContext, mcpManager: McpManager): void {
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
    const persistConversation = vscode.workspace.getConfiguration("aiChatbox")
      .get<boolean>("persistConversation", false);
    ChatView.conversation = persistConversation
      ? validateStoredConversation(context.workspaceState.get<unknown>(CONVERSATION_STORAGE_KEY))
      : [];
    if (!persistConversation) void context.workspaceState.update(CONVERSATION_STORAGE_KEY, undefined);
    panel.webview.html = ChatView.getHtml(panel.webview);

    panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;

      if (message.type === "ready") {
        const showWelcome = vscode.workspace.getConfiguration("aiChatbox")
          .get<boolean>("showWelcomeMessage", true);
        const restoredMessages = toTranscriptMessages(ChatView.conversation);
        if (restoredMessages.length) {
          await panel.webview.postMessage({ type: "conversationRestore", messages: restoredMessages } satisfies ModelUiMessage);
        } else if (showWelcome) {
          await panel.webview.postMessage({
            type: "assistant",
            text: "Welcome to AI Chatbox. Tool calls require your approval before they run. Configure aiChatbox.mcpServers and use “AI Chatbox: Connect MCP Server” to connect a reviewed MCP server. Choose a local OpenAI-compatible model in settings, or set an OpenAI key with “AI Chatbox: Set OpenAI API Key”."
          });
        }
        return;
      }
      if (message.type === "openSettings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "aiChatbox");
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
        await ChatView.runAgentRequest(context, panel, text, mcpManager);
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
      ChatView.pendingMcpContext = undefined;
      ChatView.pendingMcpContextLabel = undefined;
    });
  }

  private static async runAgentRequest(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    text: string,
    mcpManager: McpManager
  ): Promise<void> {
    const controller = new AbortController();
    const mcpContext = ChatView.pendingMcpContext;
    ChatView.pendingMcpContext = undefined;
    ChatView.pendingMcpContextLabel = undefined;
    const conversationEpoch = ChatView.conversationEpoch;
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

      tools.push(...mcpManager.getAgentTools());

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
      const [skillContext, knowledgeContext] = await Promise.all([
        ChatView.getSkillContext(context, text),
        ChatView.getKnowledgeContext(context, text)
      ]);
      const requestContext = [skillContext, knowledgeContext, mcpContext].filter(Boolean).join("\n\n");
      // Reserve one history slot for request-scoped context so bounded history cannot
      // trim retrieved reference material before the model sees it.
      const conversationForRequest = requestContext
        ? ChatView.conversation.slice(-(MAX_HISTORY_MESSAGES - 1))
        : ChatView.conversation.slice(-MAX_HISTORY_MESSAGES);
      const requestMessages: AgentMessage[] = [
        ...(requestContext ? [{ role: "system" as const, content: requestContext }] : []),
        ...conversationForRequest
      ];
      const result = await runtime.run({
        messages: requestMessages,
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
      if (conversationEpoch !== ChatView.conversationEpoch) return;
      // Skill context is request-scoped and must not be persisted as conversation history.
      ChatView.conversation = result.messages.filter((message) => message.role !== "system").slice(-MAX_HISTORY_MESSAGES);
      await ChatView.saveConversation(context);
      if (!result.finalText && result.reason !== "cancelled") {
        await panel.webview.postMessage({
          type: "assistantError",
          text: "The model returned no text. Check that the selected model supports Chat Completions."
        } satisfies ModelUiMessage);
      }
    } catch (error) {
      if (conversationEpoch !== ChatView.conversationEpoch) return;
      const message = error instanceof Error ? error.message : "Unknown agent request failure.";
      ChatView.conversation = ChatView.conversation.filter(
        (item, index, messages) => !(index === messages.length - 1 && item.role === "user" && item.content === text)
      );
      await ChatView.saveConversation(context);
      await panel.webview.postMessage({ type: "assistantError", text: message } satisfies ModelUiMessage);
    } finally {
      await panel.webview.postMessage({ type: "assistantDone" } satisfies ModelUiMessage);
      if (ChatView.activeRequest === controller) ChatView.activeRequest = undefined;
    }
  }

  private static async getSkillContext(context: vscode.ExtensionContext, task: string): Promise<string> {
    const enabled = vscode.workspace.getConfiguration("aiChatbox").get<boolean>("skillsEnabled", false);
    if (!enabled) return "";

    const files: Array<{ path: string; content: string }> = [];
    const readSkillFile = async (uri: vscode.Uri, displayPath: string): Promise<void> => {
      if (files.length >= MAX_SKILL_FILES) return;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_SKILL_FILE_BYTES) {
          files.push({ path: displayPath, content: " ".repeat(MAX_SKILL_FILE_BYTES + 1) });
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        files.push({ path: displayPath, content: new TextDecoder().decode(bytes) });
      } catch {
        // A file may disappear or become unreadable while discovery is running.
      }
    };

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (files.length >= MAX_SKILL_FILES) break;
      try {
        const matches = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, ".ai-chatbox/skills/*.json"),
          "**/{node_modules,.git}/**",
          MAX_SKILL_FILES - files.length
        );
        for (const uri of matches) {
          if (files.length >= MAX_SKILL_FILES) break;
          await readSkillFile(uri, vscode.workspace.asRelativePath(uri, false));
        }
      } catch {
        // Workspace skill discovery is best-effort; invalid/missing folders do not block chat.
      }
    }

    // User-level skills live in extension global storage and are not shared with a workspace.
    if (files.length < MAX_SKILL_FILES) {
      const userSkillsUri = vscode.Uri.joinPath(context.globalStorageUri, "skills");
      try {
        const entries = await vscode.workspace.fs.readDirectory(userSkillsUri);
        for (const [name, type] of entries) {
          if (files.length >= MAX_SKILL_FILES) break;
          if (type !== vscode.FileType.File || !name.toLowerCase().endsWith(".json")) continue;
          await readSkillFile(vscode.Uri.joinPath(userSkillsUri, name), "user/" + name);
        }
      } catch {
        // The user skills directory is optional and may not exist yet.
      }
    }

    const loaded = loadSkillFiles(files);
    const selected = loaded.registry.select(task);
    return formatSkillContext(selected);
  }

  private static async getKnowledgeContext(context: vscode.ExtensionContext, task: string): Promise<string> {
    const enabled = vscode.workspace.getConfiguration("aiChatbox").get<boolean>("knowledgeEnabled", false);
    if (!enabled) return "";

    const files: Array<{ path: string; content: string }> = [];
    const readKnowledgeFile = async (uri: vscode.Uri, displayPath: string): Promise<void> => {
      if (files.length >= MAX_KNOWLEDGE_FILES) return;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_KNOWLEDGE_FILE_BYTES) {
          files.push({ path: displayPath, content: "x".repeat(MAX_KNOWLEDGE_FILE_BYTES + 1) });
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        files.push({ path: displayPath, content: new TextDecoder().decode(bytes) });
      } catch {
        // A knowledge file may disappear or become unreadable during discovery.
      }
    };

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (files.length >= MAX_KNOWLEDGE_FILES) break;
      try {
        const matches = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, ".ai-chatbox/knowledge/*.{md,markdown,txt}"),
          "**/{node_modules,.git}/**",
          MAX_KNOWLEDGE_FILES - files.length
        );
        for (const uri of matches) {
          if (files.length >= MAX_KNOWLEDGE_FILES) break;
          await readKnowledgeFile(uri, vscode.workspace.asRelativePath(uri, false));
        }
      } catch {
        // Workspace knowledge is optional; discovery failure should not block chat.
      }
    }

    if (files.length < MAX_KNOWLEDGE_FILES) {
      const userKnowledgeUri = vscode.Uri.joinPath(context.globalStorageUri, "knowledge");
      try {
        const entries = await vscode.workspace.fs.readDirectory(userKnowledgeUri);
        for (const [name, type] of entries) {
          if (files.length >= MAX_KNOWLEDGE_FILES) break;
          if (type !== vscode.FileType.File || !/\.(md|markdown|txt)$/i.test(name)) continue;
          await readKnowledgeFile(vscode.Uri.joinPath(userKnowledgeUri, name), "user/knowledge/" + name);
        }
      } catch {
        // The user knowledge directory is optional and may not exist.
      }
    }

    const indexed = buildKnowledgeIndex(files);
    return formatKnowledgeContext(searchKnowledge(indexed.chunks, task));
  }

  private static async saveConversation(context: vscode.ExtensionContext): Promise<void> {
    const enabled = vscode.workspace.getConfiguration("aiChatbox").get<boolean>("persistConversation", false);
    await context.workspaceState.update(
      CONVERSATION_STORAGE_KEY,
      enabled ? ChatView.conversation.slice(-MAX_HISTORY_MESSAGES) : undefined
    );
  }

  static async clearConversation(context: vscode.ExtensionContext): Promise<void> {
    // Invalidate in-flight work before clearing storage. A cancelled request may
    // still settle asynchronously; its epoch check prevents it from restoring old history.
    ChatView.conversationEpoch += 1;
    ChatView.activeRequest?.abort();
    for (const [id, pending] of ChatView.pendingApprovals) {
      pending.abort();
      pending.resolve("deny");
      ChatView.pendingApprovals.delete(id);
    }
    ChatView.conversation = [];
    ChatView.pendingMcpContext = undefined;
    ChatView.pendingMcpContextLabel = undefined;
    await context.workspaceState.update(CONVERSATION_STORAGE_KEY, undefined);
    if (ChatView.currentPanel) {
      await ChatView.currentPanel.webview.postMessage({
        type: "conversationRestore",
        messages: []
      } satisfies ModelUiMessage);
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
.header-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
h1 { margin:0; font-size:18px; font-weight:600; }
.sub { margin-top:5px; color:var(--vscode-descriptionForeground); font-size:12px; }
#messages { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:12px; }
#announcer, .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.tool-card:focus-within { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
.workflow-card { border:1px solid var(--vscode-panel-border); border-left:3px solid var(--vscode-textLink-foreground); border-radius:8px; padding:12px; background:var(--vscode-sideBar-background); }
.workflow-title { font-weight:600; }
.workflow-detail { margin-top:6px; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--vscode-descriptionForeground); }
.tool-status { margin-top:8px; color:var(--vscode-descriptionForeground); }
.approval-warning { margin-top:8px; font-weight:600; color:var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
button.secondary { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
button.secondary:hover { background:var(--vscode-button-secondaryHoverBackground); }
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
#cancel[hidden] { display:none; }
.hint { padding:0 20px 10px; color:var(--vscode-descriptionForeground); font-size:11px; }
#announcer { color:var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<main class="app">
<header>
  <div class="header-row">
    <h1>AI Chatbox</h1>
    <button id="settings" class="secondary" type="button" aria-label="Open AI Chatbox settings">Settings</button>
  </div>
  <div class="sub">Agent chat · Tool execution requires explicit approval</div>
</header>
<section id="messages" role="region" aria-live="off" aria-label="Conversation"></section>
<div id="announcer" role="status" aria-live="polite" aria-atomic="true"></div>
<div class="hint" id="composer-hint">Configure model settings and aiChatbox.mcpServers. Connect MCP servers through the Command Palette; each tool call still requires approval.</div>
<form id="composer" aria-label="Send a message">
<textarea id="prompt" aria-label="Message" aria-describedby="composer-hint" placeholder="Ask something..." maxlength="20000" required></textarea>
<button id="send" type="submit">Send</button><button id="cancel" type="button" hidden>Stop</button>
</form>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const messages = document.getElementById("messages");
const promptInput = document.getElementById("prompt");
const form = document.getElementById("composer");
const sendButton = document.getElementById("send");
const cancelButton = document.getElementById("cancel");
const settingsButton = document.getElementById("settings");
const announcer = document.getElementById("announcer");
let activeAssistant = null;
const toolCards = new Map();
const workflowCards = new Map();

function addMessage(role, text) {
  const item = document.createElement("div");
  item.className = "message " + role;
  item.textContent = text;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}
function announce(text) {
  announcer.textContent = "";
  requestAnimationFrame(() => { announcer.textContent = text; });
}
function setBusy(busy) {
  sendButton.disabled = busy;
  promptInput.disabled = busy;
  cancelButton.hidden = !busy;
  cancelButton.disabled = false;
  announce(busy ? "Assistant is responding. You can stop the response." : "Response finished. Message input is ready.");
  if (!busy) promptInput.focus();
}
function renderWorkflowProgress(message) {
  let card = workflowCards.get(message.runId);
  if (!card) {
    card = document.createElement("section");
    card.className = "workflow-card";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Workflow progress");
    const title = document.createElement("div");
    title.className = "workflow-title";
    card.appendChild(title);
    const detail = document.createElement("div");
    detail.className = "workflow-detail";
    detail.setAttribute("role", "status");
    detail.setAttribute("aria-live", "polite");
    card.appendChild(detail);
    card._title = title;
    card._detail = detail;
    messages.appendChild(card);
    workflowCards.set(message.runId, card);
  }
  card._title.textContent = message.workflowName + " · v" + message.version;
  const current = message.stepTitle ? ("Step " + Math.min(message.stepIndex + 1, message.stepCount) + " of " + message.stepCount + ": " + message.stepTitle) : "";
  card._detail.textContent = [message.status, current, message.detail || ""].filter(Boolean).join("\n");
  messages.scrollTop = messages.scrollHeight;
  announce("Workflow " + message.workflowName + ": " + message.status + (current ? ". " + current : ""));
}
function renderToolEvent(message) {
  let card = toolCards.get(message.toolCallId);
  if (!card) {
    card = document.createElement("div");
    card.className = "tool-card";
    card.setAttribute("role", "group");
    const title = document.createElement("div");
    title.className = "tool-title";
    title.textContent = "Tool: " + message.name;
    card.appendChild(title);
    const detail = document.createElement("div");
    detail.className = "tool-input";
    detail.textContent = message.input === undefined ? "" : JSON.stringify(message.input, null, 2);
    card.appendChild(detail);
    const status = document.createElement("div");
    status.className = "tool-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
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
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Tool approval request");
  const title = document.createElement("div");
  title.className = "tool-title";
  title.textContent = "Approval required: " + message.name;
  title.id = "approval-title-" + String(message.toolCallId).replace(/[^a-zA-Z0-9_-]/g, "");
  card.setAttribute("aria-labelledby", title.id);
  card.appendChild(title);
  const detail = document.createElement("div");
  detail.className = "tool-input";
  detail.textContent = JSON.stringify(message.input, null, 2);
  card.appendChild(detail);
  const warning = document.createElement("div");
  warning.className = "approval-warning";
  warning.textContent = "Review the requested action and arguments before allowing it. Approval allows this invocation only.";
  card.appendChild(warning);
  const decisionStatus = document.createElement("div");
  decisionStatus.className = "tool-status";
  decisionStatus.id = "approval-status-" + String(message.toolCallId).replace(/[^a-zA-Z0-9_-]/g, "");
  decisionStatus.setAttribute("role", "status");
  decisionStatus.setAttribute("aria-live", "polite");
  decisionStatus.textContent = "Waiting for your decision.";
  card.setAttribute("aria-describedby", decisionStatus.id);
  const actions = document.createElement("div");
  actions.className = "tool-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.textContent = "Approve once";
  approve.setAttribute("aria-label", "Approve this tool invocation once");
  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "secondary";
  deny.textContent = "Deny";
  deny.setAttribute("aria-label", "Deny this tool invocation");
  const decide = (decision) => {
    approve.disabled = true;
    deny.disabled = true;
    decisionStatus.textContent = decision === "allow"
      ? "Approved once. The tool may now run."
      : "Denied. The tool will not run.";
    announce(decision === "allow" ? "Tool invocation approved once." : "Tool invocation denied.");
    vscode.postMessage({ type: "toolDecision", toolCallId: message.toolCallId, decision });
  };
  approve.addEventListener("click", () => decide("allow"));
  deny.addEventListener("click", () => decide("deny"));
  actions.append(approve, deny);
  card.append(decisionStatus, actions);
  messages.appendChild(card);
  messages.scrollTop = messages.scrollHeight;
  announce("Approval required for tool " + message.name + ". Review its arguments, then approve once or deny.");
  deny.focus();
}
settingsButton.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
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
  announce("Stopping the current response.");
  vscode.postMessage({ type: "cancel" });
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "conversationRestore" && Array.isArray(message.messages)) {
    messages.replaceChildren();
    toolCards.clear();
    for (const item of message.messages) {
      if (!item || (item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") continue;
      addMessage(item.role, item.content);
    }
  } else if (message.type === "assistant" && typeof message.text === "string") addMessage("assistant", message.text);
  else if (message.type === "assistantStart") activeAssistant = addMessage("assistant", "");
  else if (message.type === "assistantDelta" && typeof message.text === "string" && activeAssistant) {
    activeAssistant.textContent += message.text;
    messages.scrollTop = messages.scrollHeight;
  } else if (message.type === "assistantError" && typeof message.text === "string") {
    const errorItem = activeAssistant ?? addMessage("assistant", "");
    errorItem.classList.add("error");
    errorItem.setAttribute("role", "alert");
    errorItem.textContent += (errorItem.textContent ? "\n\n" : "") + "Error: " + message.text;
    announce("Request failed: " + message.text);
  } else if (message.type === "workflowProgress" && typeof message.runId === "string" && typeof message.workflowName === "string") renderWorkflowProgress(message);
  else if (message.type === "mcpContextStatus") {
    addMessage("assistant", message.attached
      ? "MCP reference attached to the next message: " + String(message.label || "selected content") + ". It will be sent to the configured model once, as untrusted reference data."
      : "Pending MCP reference attachment cleared.");
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
