import * as vscode from "vscode";
import { ChatView, OPENAI_API_KEY_SECRET } from "./chatView";
import { McpManager, describeMcpServerEndpoint, parseMcpServerConfig, McpServerConfig } from "./mcpManager";
import { loadWorkflowFiles, getRunnableWorkflows, MAX_WORKFLOW_FILE_BYTES, WorkflowFile } from "./workflowLoader";
import { WorkflowRun, completeInstructionStep, decideWorkflowApproval, failInstructionStep, getCurrentWorkflowStep, getWorkflowStepAttempt, retryInstructionStep, startWorkflow } from "./workflowRuntime";
import { upsertSavedWorkflowRun, validateSavedWorkflowRecords } from "./workflowRunStore";
import { formatMcpContext } from "./mcpContext";

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



function safeResourceUri(rawUri: string): string {
  try {
    const uri = new URL(rawUri);
    uri.search = "";
    uri.hash = "";
    return uri.toString().slice(0, 4_000);
  } catch {
    return rawUri.split(/[?#]/, 1)[0].slice(0, 4_000);
  }
}

async function chooseConnectedMcpServer(manager: McpManager, title: string): Promise<string | undefined> {
  const names = manager.getConnectedNames();
  if (!names.length) {
    void vscode.window.showInformationMessage("Connect an MCP server first using AI Chatbox: Connect MCP Server.");
    return undefined;
  }
  return vscode.window.showQuickPick(names, { title, placeHolder: "Only currently connected MCP servers are listed" });
}

async function connectConfiguredMcpServer(
  serverName: string,
  rawConfig: unknown,
  manager: McpManager,
  output: vscode.OutputChannel
): Promise<void> {
  let config: McpServerConfig;
  try {
    config = parseMcpServerConfig(rawConfig);
  } catch (error) {
    void vscode.window.showErrorMessage(`Invalid MCP configuration: ${error instanceof Error ? error.message : "unknown error"}`);
    return;
  }

  const detail = describeServer(config);
  const choice = await vscode.window.showWarningMessage(
    `Connecting starts a local process or contacts a remote MCP server. Its tools can request actions and may access data available to that server. Review the configuration before proceeding.\\n\\n${detail}`,
    { modal: true, detail: "Connection does not grant tool execution permission. Every tool call will still require a separate approval in the chat." },
    "Connect",
    "Cancel"
  );
  if (choice !== "Connect") return;

  output.appendLine(`[${new Date().toISOString()}] Connecting to MCP server "${serverName}" (${config.transport}).`);
  try {
    const tools = await manager.connect(serverName, rawConfig);
    manager.clearConnectionError(serverName);
    output.appendLine(`[${new Date().toISOString()}] Connected to "${serverName}"; discovered ${tools.length} tool(s).`);
    void vscode.window.showInformationMessage(`Connected to MCP server "${serverName}" and discovered ${tools.length} tool(s).`);
  } catch (error) {
    const message = safeErrorMessage(error, rawConfig);
    manager.recordConnectionError(serverName, message);
    output.appendLine(`[${new Date().toISOString()}] Connection failed for "${serverName}": ${message}`);
    void vscode.window.showErrorMessage(`Could not connect to MCP server "${serverName}": ${message}`);
  }
}

async function browseMcpResources(manager: McpManager, output: vscode.OutputChannel): Promise<void> {
  const serverName = await chooseConnectedMcpServer(manager, "Browse MCP Resources");
  if (!serverName) return;
  try {
    const resources = await manager.listResources(serverName);
    if (!resources.length) {
      void vscode.window.showInformationMessage(`MCP server "${serverName}" exposes no resources.`);
      return;
    }
    const selected = await vscode.window.showQuickPick(resources.map((resource, index) => ({
      label: resource.name || resource.uri,
      description: resource.mimeType ?? "",
      detail: `${safeResourceUri(resource.uri)}${resource.description ? ` — ${resource.description}` : ""}`,
      index
    })), { title: `Resources from ${serverName}`, placeHolder: "Select a resource to read it locally" });
    if (!selected) return;
    const resource = resources[selected.index];
    const contents = await manager.readResource(serverName, resource.uri);
    output.appendLine(`Resource preview from MCP server "${serverName}" — ${resource.name}`);
    output.appendLine(`URI: ${safeResourceUri(resource.uri)}`);
    output.appendLine("Resource content is untrusted data; it is displayed locally and is not automatically sent to the model.");
    output.appendLine("=".repeat(72));
    for (const item of contents) {
      output.appendLine(`Content URI: ${safeResourceUri(item.uri)}`);
      if (item.mimeType) output.appendLine(`MIME type: ${item.mimeType}`);
      if (item.text) output.appendLine(item.text);
      if (item.note) output.appendLine(`[Note: ${item.note}]`);
    }
    output.show(true);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not browse MCP resources: ${error instanceof Error ? error.message.slice(0, 500) : "unknown error"}`);
  }
}

async function browseMcpPrompts(manager: McpManager, output: vscode.OutputChannel): Promise<void> {
  const serverName = await chooseConnectedMcpServer(manager, "Browse MCP Prompts");
  if (!serverName) return;
  try {
    const prompts = await manager.listPrompts(serverName);
    if (!prompts.length) {
      void vscode.window.showInformationMessage(`MCP server "${serverName}" exposes no prompts.`);
      return;
    }
    const selected = await vscode.window.showQuickPick(prompts.map((prompt, index) => ({
      label: prompt.name,
      description: prompt.arguments.length ? `${prompt.arguments.length} argument(s)` : "No arguments",
      detail: prompt.description,
      index
    })), { title: `Prompts from ${serverName}`, placeHolder: "Select a prompt to preview its generated messages" });
    if (!selected) return;
    const prompt = prompts[selected.index];
    const args: Record<string, string> = {};
    for (const argument of prompt.arguments) {
      const value = await vscode.window.showInputBox({
        title: `MCP prompt: ${prompt.name}`,
        prompt: `${argument.name}${argument.required ? " (required)" : " (optional)"}${argument.description ? ` — ${argument.description}` : ""}`,
        ignoreFocusOut: true,
        validateInput: (input) => argument.required && !input.trim() ? "This argument is required." : undefined
      });
      if (value === undefined) return;
      if (value.length) args[argument.name] = value;
    }
    const messages = await manager.getPrompt(serverName, prompt.name, args);
    output.appendLine(`Prompt preview from MCP server "${serverName}" — ${prompt.name}`);
    output.appendLine("Prompt content is untrusted data; it is displayed locally and is not automatically sent to the model.");
    output.appendLine("=".repeat(72));
    for (const message of messages) {
      output.appendLine(`[${message.role}]`);
      output.appendLine(message.text);
      output.appendLine("");
    }
    output.show(true);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not retrieve MCP prompt: ${error instanceof Error ? error.message.slice(0, 500) : "unknown error"}`);
  }
}

async function attachMcpResourceToNextMessage(manager: McpManager, output: vscode.OutputChannel): Promise<void> {
  if (!ChatView.canAttachMcpContext()) {
    void vscode.window.showWarningMessage("Open AI Chatbox: Open Chat first, and wait for any active response to finish.");
    return;
  }
  const serverName = await chooseConnectedMcpServer(manager, "Attach MCP Resource to Next Message");
  if (!serverName) return;
  try {
    const resources = await manager.listResources(serverName);
    if (!resources.length) {
      void vscode.window.showInformationMessage(`MCP server "${serverName}" exposes no resources.`);
      return;
    }
    const selected = await vscode.window.showQuickPick(resources.map((resource, index) => ({
      label: resource.name || resource.uri,
      description: resource.mimeType ?? "",
      detail: `${safeResourceUri(resource.uri)}${resource.description ? ` — ${resource.description}` : ""}`,
      index
    })), { title: `Attach a resource from ${serverName}`, placeHolder: "Select one resource to review before sending it to the model" });
    if (!selected) return;
    const resource = resources[selected.index];
    const contents = await manager.readResource(serverName, resource.uri);
    const formatted = formatMcpContext(
      { kind: "resource", serverName, name: resource.name },
      contents.map((item) => ({ label: safeResourceUri(item.uri), text: item.text, note: item.note }))
    );
    output.appendLine(`Explicit attachment preview — MCP resource "${resource.name}" from "${serverName}".`);
    output.appendLine("Content is untrusted and will only be sent after confirmation, with the next chat message.");
    output.appendLine("=".repeat(72));
    output.appendLine(formatted);
    output.show(true);
    const decision = await vscode.window.showWarningMessage(
      `Attach MCP resource "${resource.name}" to the next chat message?`,
      { modal: true, detail: `This sends the bounded resource text to your configured model once as untrusted reference data. Review the local "AI Chatbox MCP Content" output before continuing.\n\nPreview:\n${formatted.slice(0, 1_200)}${formatted.length > 1_200 ? "\n[Preview truncated]" : ""}` },
      "Attach Once",
      "Cancel"
    );
    if (decision !== "Attach Once") return;
    if (!ChatView.attachMcpContext(formatted, `MCP resource ${resource.name} (${serverName})`)) {
      void vscode.window.showWarningMessage("Could not attach the resource. Open chat and ensure no response is in progress.");
      return;
    }
    void vscode.window.showInformationMessage("MCP resource attached to the next chat message only.");
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not attach MCP resource: ${error instanceof Error ? error.message.slice(0, 500) : "unknown error"}`);
  }
}

async function attachMcpPromptToNextMessage(manager: McpManager, output: vscode.OutputChannel): Promise<void> {
  if (!ChatView.canAttachMcpContext()) {
    void vscode.window.showWarningMessage("Open AI Chatbox: Open Chat first, and wait for any active response to finish.");
    return;
  }
  const serverName = await chooseConnectedMcpServer(manager, "Attach MCP Prompt to Next Message");
  if (!serverName) return;
  try {
    const prompts = await manager.listPrompts(serverName);
    if (!prompts.length) {
      void vscode.window.showInformationMessage(`MCP server "${serverName}" exposes no prompts.`);
      return;
    }
    const selected = await vscode.window.showQuickPick(prompts.map((prompt, index) => ({
      label: prompt.name,
      description: prompt.arguments.length ? `${prompt.arguments.length} argument(s)` : "No arguments",
      detail: prompt.description,
      index
    })), { title: `Attach a prompt from ${serverName}`, placeHolder: "Select a prompt to review before sending it to the model" });
    if (!selected) return;
    const prompt = prompts[selected.index];
    const args: Record<string, string> = {};
    for (const argument of prompt.arguments) {
      const value = await vscode.window.showInputBox({
        title: `MCP prompt: ${prompt.name}`,
        prompt: `${argument.name}${argument.required ? " (required)" : " (optional)"}${argument.description ? ` — ${argument.description}` : ""}`,
        ignoreFocusOut: true,
        validateInput: (input) => argument.required && !input.trim() ? "This argument is required." : undefined
      });
      if (value === undefined) return;
      if (value.length) args[argument.name] = value;
    }
    const messages = await manager.getPrompt(serverName, prompt.name, args);
    const formatted = formatMcpContext(
      { kind: "prompt", serverName, name: prompt.name },
      messages.map((message) => ({ label: `MCP message role: ${message.role}`, text: message.text }))
    );
    output.appendLine(`Explicit attachment preview — MCP prompt "${prompt.name}" from "${serverName}".`);
    output.appendLine("Content is untrusted and will only be sent after confirmation, with the next chat message.");
    output.appendLine("=".repeat(72));
    output.appendLine(formatted);
    output.show(true);
    const decision = await vscode.window.showWarningMessage(
      `Attach MCP prompt "${prompt.name}" to the next chat message?`,
      { modal: true, detail: `This sends the bounded prompt text to your configured model once as untrusted reference data. Prompt messages are not elevated to system/developer roles. Review the local output before continuing.\n\nPreview:\n${formatted.slice(0, 1_200)}${formatted.length > 1_200 ? "\n[Preview truncated]" : ""}` },
      "Attach Once",
      "Cancel"
    );
    if (decision !== "Attach Once") return;
    if (!ChatView.attachMcpContext(formatted, `MCP prompt ${prompt.name} (${serverName})`)) {
      void vscode.window.showWarningMessage("Could not attach the prompt. Open chat and ensure no response is in progress.");
      return;
    }
    void vscode.window.showInformationMessage("MCP prompt attached to the next chat message only.");
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not attach MCP prompt: ${error instanceof Error ? error.message.slice(0, 500) : "unknown error"}`);
  }
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

const WORKFLOW_RUNS_KEY = "aiChatbox.workflowRuns.v1";

async function saveWorkflowRun(context: vscode.ExtensionContext, runId: string, run: WorkflowRun): Promise<void> {
  const current = context.globalState.get<unknown>(WORKFLOW_RUNS_KEY);
  await context.globalState.update(WORKFLOW_RUNS_KEY, upsertSavedWorkflowRun(current, runId, run));
}

async function removeWorkflowRun(context: vscode.ExtensionContext, runId: string): Promise<void> {
  const current = validateSavedWorkflowRecords(context.globalState.get<unknown>(WORKFLOW_RUNS_KEY));
  await context.globalState.update(WORKFLOW_RUNS_KEY, current.filter((record) => record.runId !== runId));
}

function publishWorkflowProgress(runId: string, run: WorkflowRun, status: string, detail?: string): void {
  const step = getCurrentWorkflowStep(run);
  ChatView.showWorkflowProgress({
    runId,
    workflowName: run.workflow.name,
    version: run.workflow.version,
    stepIndex: run.stepIndex,
    stepCount: run.workflow.steps.length,
    status,
    stepTitle: step?.title,
    detail
  });
}

async function executeWorkflowRun(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  runId: string,
  initialRun: WorkflowRun
): Promise<void> {
  let run = initialRun;
  await saveWorkflowRun(context, runId, run);
  output.appendLine(`Workflow "${run.workflow.id}" v${run.workflow.version} run "${runId}" is ${run.status}.`);

  while (run.status === "running" || run.status === "awaiting-approval" || run.status === "awaiting-retry") {
    const step = getCurrentWorkflowStep(run);
    if (!step) {
      publishWorkflowProgress(runId, run, "Error", "The workflow reached an invalid step state.");
      void vscode.window.showErrorMessage("Workflow runtime reached an invalid step state.");
      return;
    }
    const status = run.status === "awaiting-approval" ? "Awaiting approval" : run.status === "awaiting-retry" ? "Awaiting retry" : "In progress";
    publishWorkflowProgress(runId, run, status);
    const stepLabel = `Step ${run.stepIndex + 1} of ${run.workflow.steps.length}: ${step.title}`;

    if (run.status === "awaiting-retry") {
      if (step.type !== "instruction") {
        publishWorkflowProgress(runId, run, "Error", "Retry state did not point to an instruction step.");
        void vscode.window.showErrorMessage("Workflow retry state is invalid.");
        return;
      }
      const attempt = getWorkflowStepAttempt(run, step.id);
      const maxAttempts = step.retryPolicy?.maxAttempts ?? 1;
      const decision = await vscode.window.showWarningMessage(
        `${run.workflow.name}\nRetry instruction: ${step.title}`,
        { modal: true, detail: `Attempt ${attempt} of ${maxAttempts} failed. Retrying repeats this manual checklist instruction; it does not automatically rerun commands, tools, or code.` },
        "Retry Step",
        "Cancel Workflow"
      );
      if (decision === undefined) {
        publishWorkflowProgress(runId, run, "Paused", "Retry decision dismissed. Resume this saved run with AI Chatbox: Resume Workflow.");
        output.appendLine(`Workflow "${run.workflow.id}" run "${runId}" paused while awaiting a retry decision.`);
        return;
      }
      if (decision === "Cancel Workflow") {
        await removeWorkflowRun(context, runId);
        publishWorkflowProgress(runId, run, "Cancelled", "Cancelled by the user.");
        output.appendLine(`Workflow "${run.workflow.id}" run "${runId}" cancelled by the user.`);
        return;
      }
      run = retryInstructionStep(run, step.id);
      await saveWorkflowRun(context, runId, run);
      continue;
    }

    if (step.type === "instruction") {
      const decision = await vscode.window.showInformationMessage(
        `${run.workflow.name}\n${stepLabel}`,
        { modal: true, detail: `${step.instructions}\n\nWorkflow instructions are untrusted reference text. They do not authorize tool execution.` },
        "Mark Complete",
        "Mark Failed",
        "Cancel Workflow"
      );
      if (decision === undefined) {
        publishWorkflowProgress(runId, run, "Paused", "Dialog dismissed. Resume this saved run with AI Chatbox: Resume Workflow.");
        output.appendLine(`Workflow "${run.workflow.id}" run "${runId}" paused when its instruction dialog was dismissed.`);
        return;
      }
      if (decision === "Cancel Workflow") {
        await removeWorkflowRun(context, runId);
        publishWorkflowProgress(runId, run, "Cancelled", "Cancelled by the user.");
        output.appendLine(`Workflow "${run.workflow.id}" run "${runId}" cancelled by the user.`);
        return;
      }
      run = decision === "Mark Failed" ? failInstructionStep(run, step.id) : completeInstructionStep(run, step.id);
    } else {
      const decision = await vscode.window.showWarningMessage(
        `${run.workflow.name}\nApproval required: ${step.title}`,
        { modal: true, detail: `${step.prompt}\n\n${step.onDeny === "continue" ? "If denied, this workflow is explicitly configured to continue to conditional follow-up steps." : "Denial cancels this workflow."}\nApproving this workflow checkpoint does not grant permission to run any tool. Tool calls still require their own approval.` },
        "Approve and Continue",
        "Deny Workflow"
      );
      if (decision === undefined) {
        publishWorkflowProgress(runId, run, "Paused", "Approval dialog dismissed. Resume this saved run with AI Chatbox: Resume Workflow.");
        output.appendLine(`Workflow "${run.workflow.id}" run "${runId}" paused at approval checkpoint "${step.id}".`);
        return;
      }
      run = decideWorkflowApproval(run, step.id, decision === "Approve and Continue");
    }

    await saveWorkflowRun(context, runId, run);
    if (run.status === "cancelled") {
      const failureDetail = step.type === "instruction"
        ? `Retry limit exhausted at instruction "${step.title}".`
        : `Approval denied at checkpoint "${step.title}".`;
      publishWorkflowProgress(runId, run, "Cancelled", failureDetail);
      output.appendLine(`Workflow "${run.workflow.id}" run "${runId}" cancelled: ${failureDetail}`);
      void vscode.window.showInformationMessage(step.type === "instruction"
        ? `Workflow "${run.workflow.name}" was cancelled because the instruction retry limit was exhausted.`
        : `Workflow "${run.workflow.name}" was cancelled because an approval checkpoint was denied.`);
      return;
    }
  }

  publishWorkflowProgress(runId, run, "Completed", "All workflow steps are complete.");
  output.appendLine(`Workflow "${run.workflow.id}" version ${run.workflow.version} run "${runId}" completed.`);
  void vscode.window.showInformationMessage(`Workflow completed: ${run.workflow.name} (v${run.workflow.version}).`);
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
  for (const rejected of loaded.rejected) output.appendLine(`Skipped workflow file "${rejected.path}": ${rejected.reason}`);
  const workflows = getRunnableWorkflows(loaded.registry.list());
  if (!workflows.length) {
    const detail = loaded.rejected.length ? ` ${loaded.rejected.length} file(s) were skipped; see AI Chatbox Workflows output for details.` : "";
    void vscode.window.showInformationMessage(
      `No enabled workflows found. Add JSON files to .ai-chatbox/workflows/ or the AI Chatbox user storage workflows/ directory.${detail}`
    );
    return;
  }
  if (loaded.rejected.length) output.appendLine(`Loaded ${loaded.loaded} workflow file(s); ${loaded.rejected.length} file(s) rejected.`);

  const selected = await vscode.window.showQuickPick(workflows.map((workflow) => ({
    label: workflow.name,
    description: `${workflow.id} · v${workflow.version}`,
    detail: workflow.description,
    workflow
  })), { title: "Run AI Chatbox Workflow", placeHolder: "Choose a reviewed workflow definition" });
  if (!selected) return;

  const runId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await executeWorkflowRun(context, output, runId, startWorkflow(selected.workflow));
}

async function resumeWorkflowRun(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const enabled = vscode.workspace.getConfiguration("aiChatbox").get<boolean>("workflowsEnabled", false);
  if (!enabled) {
    void vscode.window.showWarningMessage("Set aiChatbox.workflowsEnabled to true before resuming workflows.");
    return;
  }
  const records = validateSavedWorkflowRecords(context.globalState.get<unknown>(WORKFLOW_RUNS_KEY))
    .filter((record) => record.run.status === "running" || record.run.status === "awaiting-approval" || record.run.status === "awaiting-retry");
  if (!records.length) {
    void vscode.window.showInformationMessage("No resumable workflow runs were found.");
    return;
  }
  const selected = await vscode.window.showQuickPick(records.map((record) => ({
    label: record.run.workflow.name,
    description: `${record.run.workflow.id} · v${record.run.workflow.version} · ${record.run.status}`,
    detail: `Run ${record.runId} · step ${Math.min(record.run.stepIndex + 1, record.run.workflow.steps.length)} of ${record.run.workflow.steps.length}`,
    record
  })), { title: "Resume AI Chatbox Workflow", placeHolder: "Resumes the saved workflow version and step state" });
  if (!selected) return;
  await executeWorkflowRun(context, output, selected.record.runId, selected.record.run);
}

export function activate(context: vscode.ExtensionContext): void {
  const mcpOutput = vscode.window.createOutputChannel("AI Chatbox MCP");
  mcpManager = new McpManager(
    async (serverName) => context.secrets.get(MCP_TOKEN_SECRET_PREFIX + serverName),
    (notification) => {
      const detail = notification.uri ? ` — ${notification.uri}` : "";
      mcpOutput.appendLine(`[${notification.receivedAt}] MCP notification from "${notification.serverName}": ${notification.kind}${detail}`);
      if (notification.kind === "tools-changed") {
        mcpOutput.appendLine("Tool list changed. AI Chatbox is refreshing the discovered schemas; the updated tools are available on subsequent chat turns. Tool calls still require explicit approval.");
      }
    },
    (event) => {
      mcpOutput.appendLine(`[${event.receivedAt}] MCP ${event.state} event for "${event.serverName}": ${event.message}`);
      if (event.state === "disconnected") {
        void vscode.window.showWarningMessage(`MCP server "${event.serverName}" disconnected unexpectedly. Review its configuration and reconnect manually.`);
      }
    }
  );
  const workflowOutput = vscode.window.createOutputChannel("AI Chatbox Workflows");
  const mcpContentOutput = vscode.window.createOutputChannel("AI Chatbox MCP Content");
  context.subscriptions.push(mcpOutput, workflowOutput, mcpContentOutput);

  const openChat = vscode.commands.registerCommand("aiChatbox.open", () => {
    ChatView.open(context, mcpManager!);
  });
  const runWorkflow = vscode.commands.registerCommand("aiChatbox.runWorkflow", async () => {
    await runSelectedWorkflow(context, workflowOutput);
  });
  const resumeWorkflow = vscode.commands.registerCommand("aiChatbox.resumeWorkflow", async () => {
    await resumeWorkflowRun(context, workflowOutput);
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
    const connected = new Set(mcpManager!.getConnectedNames());
    const selected = await vscode.window.showQuickPick(names.map((name) => ({
      label: name,
      description: connected.has(name) ? "Connected" : mcpManager!.getConnectionError(name) ? "Connection failed" : "Not connected"
    })), {
      title: "Choose an MCP server to connect",
      placeHolder: "Only configured servers are listed"
    });
    if (!selected) return;
    await connectConfiguredMcpServer(selected.label, configured[selected.label], mcpManager!, mcpOutput);
  });

  const reconnectMcpServer = vscode.commands.registerCommand("aiChatbox.reconnectMcpServer", async () => {
    const configured = configuredServers();
    const names = Object.keys(configured).sort();
    if (!names.length) {
      void vscode.window.showWarningMessage("No MCP servers configured. Add named entries to aiChatbox.mcpServers in VS Code Settings.");
      return;
    }
    const connected = new Set(mcpManager!.getConnectedNames());
    const disconnected = names.filter((name) => !connected.has(name));
    if (!disconnected.length) {
      void vscode.window.showInformationMessage("All configured MCP servers are already connected.");
      return;
    }

    const selected = await vscode.window.showQuickPick(disconnected.map((name) => {
      const lastError = mcpManager!.getConnectionError(name);
      let transport = "Invalid configuration";
      try {
        transport = parseMcpServerConfig(configured[name]).transport;
      } catch { /* Keep invalid configurations visible so the user can inspect/fix them. */ }
      return {
        label: name,
        description: lastError ? "Connection failed — review and reconnect" : "Disconnected — reconnect manually",
        detail: lastError ? `${transport} · ${lastError}` : transport
      };
    }), {
      title: "Reconnect MCP Server",
      placeHolder: "Select a disconnected server; review its configuration before connecting"
    });
    if (!selected) return;
    await connectConfiguredMcpServer(selected.label, configured[selected.label], mcpManager!, mcpOutput);
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

  const browseMcpResourcesCommand = vscode.commands.registerCommand("aiChatbox.browseMcpResources", async () => {
    await browseMcpResources(mcpManager!, mcpContentOutput);
  });
  const browseMcpPromptsCommand = vscode.commands.registerCommand("aiChatbox.browseMcpPrompts", async () => {
    await browseMcpPrompts(mcpManager!, mcpContentOutput);
  });
  const attachMcpResourceCommand = vscode.commands.registerCommand("aiChatbox.attachMcpResource", async () => {
    await attachMcpResourceToNextMessage(mcpManager!, mcpContentOutput);
  });
  const attachMcpPromptCommand = vscode.commands.registerCommand("aiChatbox.attachMcpPrompt", async () => {
    await attachMcpPromptToNextMessage(mcpManager!, mcpContentOutput);
  });
  const clearMcpContextCommand = vscode.commands.registerCommand("aiChatbox.clearMcpContext", () => {
    if (ChatView.clearPendingMcpContext()) {
      void vscode.window.showInformationMessage("Pending MCP context attachment cleared.");
    } else {
      void vscode.window.showInformationMessage("Open AI Chatbox first; there is no active chat panel.");
    }
  });

  const showMcpOutput = vscode.commands.registerCommand("aiChatbox.showMcpDiagnostics", () => {
    mcpOutput.appendLine(`[${new Date().toISOString()}] Diagnostics output opened.`);
    const recent = mcpManager!.getRecentNotifications();
    mcpOutput.appendLine(`Recent MCP notifications retained: ${recent.length} (maximum 100).`);
    for (const notification of recent.slice(-20)) {
      mcpOutput.appendLine(`[${notification.receivedAt}] ${notification.serverName}: ${notification.kind}${notification.uri ? ` — ${notification.uri}` : ""}`);
    }
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
    connectMcpServer, reconnectMcpServer, disconnectMcpServer, setMcpToken, clearMcpToken,
    showMcpStatus, showMcpOutput, browseMcpResourcesCommand, browseMcpPromptsCommand,
    attachMcpResourceCommand, attachMcpPromptCommand, clearMcpContextCommand, runWorkflow, resumeWorkflow, showWorkflowDiagnostics
  );
}

export async function deactivate(): Promise<void> {
  await mcpManager?.disconnectAll();
  mcpManager = undefined;
}
