import * as vscode from "vscode";
import { ChatView, OPENAI_API_KEY_SECRET } from "./chatView";
import { McpManager, describeMcpServerEndpoint, parseMcpServerConfig, McpServerConfig } from "./mcpManager";
import { loadWorkflowFiles, getRunnableWorkflows, MAX_WORKFLOW_FILE_BYTES, WorkflowFile } from "./workflowLoader";
import { completeInstructionStep, decideWorkflowApproval, getCurrentWorkflowStep, startWorkflow } from "./workflowRuntime";

export const MCP_TOKEN_SECRET_PREFIX = "aiChatbox.mcpToken.";
let mcpManager: McpManager | undefined;

function configuredServers(): Record<string, unknown> {
  const value = vscode.workspace.getConfiguration("aiChatbox").get<unknown>("mcpServers", {});
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function describeServer(config: McpServerConfig): string {
  if (config.transport === "stdio") {
    const commandLine = [config.command, ...(config.args ?? [])].join(" ");
    return `stdio command: ${commandLine.slice(0, 1_200)}${config.cwd ? `\nWorking directory: ${config.cwd}` : ""}`;
  }
  return describeMcpServerEndpoint(config);
}

function safeErrorMessage(error: unknown, rawConfig?: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  try {
    const config = parseMcpServerConfig(rawConfig);
    if (config.transport === "streamable-http") {
      const safeEndpoint = describeMcpServerEndpoint(config).replace("Streamable HTTP endpoint: ", "");
      return message.split(config.url).join(safeEndpoint).slice(0, 2_000);
    }
  } catch { /* Configuration errors are already validated before logging. */ }
  return message.slice(0, 2_000);
}


async function collectWorkflowFiles(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<WorkflowFile[]> {
  const files: Array<{ uri: vscode.Uri; path: string; sourceOrder: number }> = [];
  const globalRoot = vscode.Uri.joinPath(context.globalStorageUri, "workflows");
  try {
    await vscode.workspace.fs.createDirectory(globalRoot);
    const entries = await vscode.workspace.fs.readDirectory(globalRoot);
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && name.toLowerCase().endsWith(".json")) {
        files.push({ uri: vscode.Uri.joinPath(globalRoot, name), path: `user/workflows/${name}`, sourceOrder: 0 });
      }
    }
  } catch (error) {
    output.appendLine(`Could not inspect user workflow directory: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, ".ai-chatbox/workflows/*.json"),
        new vscode.RelativePattern(folder, "**/{node_modules,.git}/**"),
        101
      );
      for (const uri of uris) {
        files.push({ uri, path: vscode.workspace.asRelativePath(uri, false), sourceOrder: 1 });
      }
    } catch (error) {
      output.appendLine(`Could not discover workflows in workspace "${folder.name}": ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // User workflows load first; a workspace manifest with the same stable ID takes precedence.
  files.sort((a, b) => a.sourceOrder - b.sourceOrder || a.path.localeCompare(b.path));
  const contents: WorkflowFile[] = [];
  for (const item of files.slice(0, 101)) {
    try {
      const stat = await vscode.workspace.fs.stat(item.uri);
      if (stat.size > MAX_WORKFLOW_FILE_BYTES) {
        contents.push({ path: item.path, content: "x".repeat(MAX_WORKFLOW_FILE_BYTES + 1) });
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(item.uri);
      contents.push({ path: item.path, content: Buffer.from(bytes).toString("utf8") });
    } catch (error) {
      output.appendLine(`Could not read workflow "${item.path}": ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return contents;
}

async function runSelectedWorkflow(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const enabled = vscode.workspace.getConfiguration("aiChatbox").get<boolean>("workflowsEnabled", false);
  if (!enabled) {
    void vscode.window.showWarningMessage(
      "Workflow loading is disabled. Set aiChatbox.workflowsEnabled to true to opt in, then run this command again."
    );
    return;
  }

  const files = await collectWorkflowFiles(context, output);
  const loaded = loadWorkflowFiles(files);
  for (const rejected of loaded.rejected) {
    output.appendLine(`Skipped workflow file "${rejected.path}": ${rejected.reason}`);
  }
  const workflows = getRunnableWorkflows(loaded.registry.list());
  if (!workflows.length) {
    const detail = loaded.rejected.length ? ` ${loaded.rejected.length} file(s) were skipped; see AI Chatbox Workflows output for details.` : "";
    void vscode.window.showInformationMessage(
      `No enabled workflows found. Add JSON files to .ai-chatbox/workflows/ or the AI Chatbox user storage workflows/ directory.${detail}`
    );
    return;
  }
  if (loaded.rejected.length) {
    output.appendLine(`Loaded ${loaded.loaded} workflow file(s); ${loaded.rejected.length} file(s) rejected.`);
  }

  const selected = await vscode.window.showQuickPick(workflows.map((workflow) => ({
    label: workflow.name,
    description: `${workflow.id} · v${workflow.version}`,
    detail: workflow.description,
    workflow
  })), { title: "Run AI Chatbox Workflow", placeHolder: "Choose a reviewed workflow definition" });
  if (!selected) return;

  let run = startWorkflow(selected.workflow);
  output.appendLine(`Started workflow "${run.workflow.id}" version ${run.workflow.version}.`);
  while (run.status === "running" || run.status === "awaiting-approval") {
    const step = getCurrentWorkflowStep(run);
    if (!step) {
      void vscode.window.showErrorMessage("Workflow runtime reached an invalid step state.");
      return;
    }
    const stepLabel = `Step ${run.stepIndex + 1} of ${run.workflow.steps.length}: ${step.title}`;
    if (step.type === "instruction") {
      const decision = await vscode.window.showInformationMessage(
        `${run.workflow.name}\n${stepLabel}`,
        { modal: true, detail: `${step.instructions}\n\nWorkflow instructions are untrusted reference text. They do not authorize tool execution.` },
        "Mark Complete",
        "Cancel Workflow"
      );
      if (decision !== "Mark Complete") {
        output.appendLine(`Workflow "${run.workflow.id}" stopped by user during step "${step.id}".`);
        return;
      }
      run = completeInstructionStep(run, step.id);
    } else {
      const decision = await vscode.window.showWarningMessage(
        `${run.workflow.name}\nApproval required: ${step.title}`,
        { modal: true, detail: `${step.prompt}\n\nApproving this workflow checkpoint does not grant permission to run any tool. Tool calls still require their own approval.` },
        "Approve and Continue",
        "Deny Workflow"
      );
      if (decision === undefined) {
        output.appendLine(`Workflow "${run.workflow.id}" dismissed at approval checkpoint "${step.id}".`);
        return;
      }
      run = decideWorkflowApproval(run, step.id, decision === "Approve and Continue");
      if (run.status === "cancelled") {
        output.appendLine(`Workflow "${run.workflow.id}" denied at checkpoint "${step.id}".`);
        void vscode.window.showInformationMessage(`Workflow "${run.workflow.name}" was cancelled because an approval checkpoint was denied.`);
        return;
      }
    }
  }
  output.appendLine(`Workflow "${run.workflow.id}" version ${run.workflow.version} completed.`);
  void vscode.window.showInformationMessage(`Workflow completed: ${run.workflow.name} (v${run.workflow.version}).`);
}

export function activate(context: vscode.ExtensionContext): void {
  mcpManager = new McpManager(async (serverName) => context.secrets.get(MCP_TOKEN_SECRET_PREFIX + serverName));
  const mcpOutput = vscode.window.createOutputChannel("AI Chatbox MCP");
  const workflowOutput = vscode.window.createOutputChannel("AI Chatbox Workflows");
  context.subscriptions.push(mcpOutput, workflowOutput);

  const openChat = vscode.commands.registerCommand("aiChatbox.open", () => {
    ChatView.open(context, mcpManager!);
  });
  const runWorkflow = vscode.commands.registerCommand("aiChatbox.runWorkflow", async () => {
    await runSelectedWorkflow(context, workflowOutput);
  });
  const showWorkflowDiagnostics = vscode.commands.registerCommand("aiChatbox.showWorkflowDiagnostics", () => {
    workflowOutput.show(true);
  });
  const clearConversation = vscode.commands.registerCommand("aiChatbox.clearConversation", async () => {
    await ChatView.clearConversation(context);
    void vscode.window.showInformationMessage("AI Chatbox: saved conversation cleared.");
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

    const detail = describeServer(config);
    const choice = await vscode.window.showWarningMessage(
      `Connecting starts a local process or contacts a remote MCP server. Its tools can request actions and may access data available to that server. Review the configuration before proceeding.\n\n${detail}`,
      { modal: true, detail: "Connection does not grant tool execution permission. Every tool call will still require a separate approval in the chat." },
      "Connect",
      "Cancel"
    );
    if (choice !== "Connect") return;

    mcpOutput.appendLine(`[${new Date().toISOString()}] Connecting to MCP server "${selected.label}" (${config.transport}).`);
    try {
      const tools = await mcpManager!.connect(selected.label, configured[selected.label]);
      mcpManager!.clearConnectionError(selected.label);
      mcpOutput.appendLine(`[${new Date().toISOString()}] Connected to "${selected.label}"; discovered ${tools.length} tool(s).`);
      void vscode.window.showInformationMessage(`Connected to MCP server "${selected.label}" and discovered ${tools.length} tool(s).`);
    } catch (error) {
      const message = safeErrorMessage(error, configured[selected.label]);
      mcpManager!.recordConnectionError(selected.label, message);
      mcpOutput.appendLine(`[${new Date().toISOString()}] Connection failed for "${selected.label}": ${message}`);
      void vscode.window.showErrorMessage(`Could not connect to MCP server "${selected.label}": ${message}`);
    }
  });

  const showMcpStatus = vscode.commands.registerCommand("aiChatbox.showMcpServerStatus", async () => {
    const configured = configuredServers();
    const names = Object.keys(configured).sort();
    if (!names.length) {
      void vscode.window.showInformationMessage("No MCP servers configured. Add entries to aiChatbox.mcpServers in VS Code Settings.");
      return;
    }
    const connected = new Set(mcpManager!.getConnectedNames());
    const toolCounts = new Map(mcpManager!.getToolSummaries().map((summary): [string, number] => [summary.serverName, summary.tools.length]));
    mcpOutput.appendLine(`[${new Date().toISOString()}] MCP status requested; ${connected.size} server(s) connected.`);
    const items = names.map((name) => {
      try {
        const config = parseMcpServerConfig(configured[name]);
        const isConnected = connected.has(name);
        const lastError = mcpManager!.getConnectionError(name);
        const endpoint = describeMcpServerEndpoint(config);
        return {
          label: `${isConnected ? "Connected" : "Disconnected"} — ${name}`,
          description: `${config.transport} · ${toolCounts.get(name) ?? 0} discovered tool(s)`,
          detail: lastError ? `Last connection error: ${lastError}` : endpoint
        };
      } catch (error) {
        return {
          label: `Invalid configuration — ${name}`,
          description: "Configuration validation failed",
          detail: safeErrorMessage(error, configured[name])
        };
      }
    });
    const selected = await vscode.window.showQuickPick(items, {
      title: "MCP Server Status",
      placeHolder: "Connections exist only in this VS Code session; servers are never started automatically."
    });
    if (selected) {
      mcpOutput.appendLine(`[${new Date().toISOString()}] Selected status entry: ${selected.label}.`);
      mcpOutput.show(true);
    }
  });

  const showMcpOutput = vscode.commands.registerCommand("aiChatbox.showMcpDiagnostics", () => {
    mcpOutput.appendLine(`[${new Date().toISOString()}] Diagnostics output opened.`);
    mcpOutput.show(true);
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
      mcpOutput.appendLine(`[${new Date().toISOString()}] Disconnected MCP server "${selected}".`);
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
    openChat, clearConversation, setOpenAiApiKey, clearOpenAiApiKey,
    connectMcpServer, disconnectMcpServer, setMcpToken, clearMcpToken,
    showMcpStatus, showMcpOutput, runWorkflow, showWorkflowDiagnostics
  );
}

export async function deactivate(): Promise<void> {
  await mcpManager?.disconnectAll();
  mcpManager = undefined;
}
