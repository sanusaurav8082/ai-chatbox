import * as vscode from "vscode";
import { ChatView, OPENAI_API_KEY_SECRET } from "./chatView";
import { McpManager, parseMcpServerConfig, McpServerConfig } from "./mcpManager";

export const MCP_TOKEN_SECRET_PREFIX = "aiChatbox.mcpToken.";
let mcpManager: McpManager | undefined;

function configuredServers(): Record<string, unknown> {
  const value = vscode.workspace.getConfiguration("aiChatbox").get<unknown>("mcpServers", {});
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function describeServer(name: string, config: McpServerConfig): string {
  if (config.transport === "stdio") {
    const commandLine = [config.command, ...(config.args ?? [])].join(" ");
    return `stdio command: ${commandLine.slice(0, 1_200)}${config.cwd ? `\nWorking directory: ${config.cwd}` : ""}`;
  }
  return `Streamable HTTP endpoint: ${config.url}`;
}

export function activate(context: vscode.ExtensionContext): void {
  mcpManager = new McpManager((serverName) => context.secrets.get(MCP_TOKEN_SECRET_PREFIX + serverName));

  const openChat = vscode.commands.registerCommand("aiChatbox.open", () => {
    ChatView.open(context, mcpManager!);
  });

  const setOpenAiApiKey = vscode.commands.registerCommand(
    "aiChatbox.setOpenAiApiKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        title: "Set OpenAI API Key",
        prompt: "The key is stored in VS Code SecretStorage, not settings or source control.",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : "Enter a non-empty API key."
      });
      if (apiKey === undefined) return;
      await context.secrets.store(OPENAI_API_KEY_SECRET, apiKey.trim());
      void vscode.window.showInformationMessage("AI Chatbox: OpenAI API key saved securely.");
    }
  );

  const clearOpenAiApiKey = vscode.commands.registerCommand(
    "aiChatbox.clearOpenAiApiKey",
    async () => {
      await context.secrets.delete(OPENAI_API_KEY_SECRET);
      void vscode.window.showInformationMessage("AI Chatbox: OpenAI API key cleared.");
    }
  );

  const connectMcpServer = vscode.commands.registerCommand("aiChatbox.connectMcpServer", async () => {
    const configured = configuredServers();
    const names = Object.keys(configured).sort();
    if (!names.length) {
      void vscode.window.showWarningMessage("No MCP servers configured. Add named entries to aiChatbox.mcpServers in VS Code Settings.");
      return;
    }
    const selected = await vscode.window.showQuickPick(names.map((name) => ({ label: name, description: mcpManager!.getConnectedNames().includes(name) ? "Connected" : "Not connected" })), {
      title: "Choose an MCP server to connect",
      placeHolder: "Only configured servers are listed"
    });
    if (!selected) return;

    let config: McpServerConfig;
    try {
      config = parseMcpServerConfig(configured[selected.label]);
    } catch (error) {
      void vscode.window.showErrorMessage(`Invalid MCP configuration: ${error instanceof Error ? error.message : "unknown error"}`);
      return;
    }

    const detail = describeServer(selected.label, config);
    const choice = await vscode.window.showWarningMessage(
      `Connecting starts a local process or contacts a remote MCP server. Its tools can request actions and may access data available to that server. Review the configuration before proceeding.\n\n${detail}`,
      { modal: true, detail: "Connection does not grant tool execution permission. Every tool call will still require a separate approval in the chat." },
      "Connect",
      "Cancel"
    );
    if (choice !== "Connect") return;

    try {
      const tools = await mcpManager!.connect(selected.label, configured[selected.label]);
      void vscode.window.showInformationMessage(`Connected to MCP server "${selected.label}" and discovered ${tools.length} tool(s).`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not connect to MCP server "${selected.label}": ${error instanceof Error ? error.message : "unknown error"}`);
    }
  });

  const disconnectMcpServer = vscode.commands.registerCommand("aiChatbox.disconnectMcpServer", async () => {
    const names = mcpManager!.getConnectedNames();
    if (!names.length) {
      void vscode.window.showInformationMessage("No MCP servers are connected.");
      return;
    }
    const selected = await vscode.window.showQuickPick(names, { title: "Choose an MCP server to disconnect" });
    if (!selected) return;
    try {
      await mcpManager!.disconnect(selected);
      void vscode.window.showInformationMessage(`Disconnected MCP server "${selected}".`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not disconnect "${selected}": ${error instanceof Error ? error.message : "unknown error"}`);
    }
  });

  const setMcpToken = vscode.commands.registerCommand("aiChatbox.setMcpServerToken", async () => {
    const httpNames = Object.entries(configuredServers()).flatMap(([name, value]) => {
      try { return parseMcpServerConfig(value).transport === "streamable-http" ? [name] : []; }
      catch { return []; }
    });
    if (!httpNames.length) {
      void vscode.window.showInformationMessage("Configure a streamable-http MCP server before setting a bearer token.");
      return;
    }
    const selected = await vscode.window.showQuickPick(httpNames, { title: "Choose the HTTP MCP server" });
    if (!selected) return;
    const token = await vscode.window.showInputBox({
      title: `Set bearer token for ${selected}`,
      prompt: "Stored in VS Code SecretStorage. The token is sent only to this server's configured endpoint.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "Enter a non-empty token."
    });
    if (token === undefined) return;
    await context.secrets.store(MCP_TOKEN_SECRET_PREFIX + selected, token.trim());
    void vscode.window.showInformationMessage(`Bearer token saved for MCP server "${selected}". Reconnect the server to use the updated token.`);
  });

  const clearMcpToken = vscode.commands.registerCommand("aiChatbox.clearMcpServerToken", async () => {
    const httpNames = Object.entries(configuredServers()).flatMap(([name, value]) => {
      try { return parseMcpServerConfig(value).transport === "streamable-http" ? [name] : []; }
      catch { return []; }
    });
    if (!httpNames.length) {
      void vscode.window.showInformationMessage("No configured streamable-http MCP servers found.");
      return;
    }
    const selected = await vscode.window.showQuickPick(httpNames, { title: "Choose the HTTP MCP server token to clear" });
    if (!selected) return;
    await context.secrets.delete(MCP_TOKEN_SECRET_PREFIX + selected);
    void vscode.window.showInformationMessage(`Bearer token cleared for MCP server "${selected}".`);
  });

  context.subscriptions.push(
    openChat, setOpenAiApiKey, clearOpenAiApiKey,
    connectMcpServer, disconnectMcpServer, setMcpToken, clearMcpToken
  );
}

export async function deactivate(): Promise<void> {
  await mcpManager?.disconnectAll();
  mcpManager = undefined;
}
