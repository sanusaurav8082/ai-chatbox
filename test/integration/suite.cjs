const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
  const extensionId = "sanusaurav8082.ai-chatbox";
  const extension = vscode.extensions.getExtension(extensionId);

  assert.ok(extension, `Expected extension ${extensionId} to be discoverable in the Extension Development Host.`);
  await extension.activate();

  const registeredCommands = new Set(await vscode.commands.getCommands(true));
  const expectedCommands = [
    "aiChatbox.open",
    "aiChatbox.setOpenAiApiKey",
    "aiChatbox.clearOpenAiApiKey",
    "aiChatbox.connectMcpServer",
    "aiChatbox.disconnectMcpServer",
    "aiChatbox.showMcpServerStatus",
    "aiChatbox.showMcpDiagnostics",
    "aiChatbox.clearConversation",
    "aiChatbox.runWorkflow",
    "aiChatbox.resumeWorkflow",
    "aiChatbox.showWorkflowDiagnostics"
  ];

  for (const command of expectedCommands) {
    assert.ok(registeredCommands.has(command), `Expected command to be registered: ${command}`);
  }

  const manifest = extension.packageJSON;
  const contributedCommands = new Set((manifest.contributes?.commands ?? []).map((item) => item.command));
  for (const command of expectedCommands) {
    assert.ok(contributedCommands.has(command), `Expected package manifest to contribute command: ${command}`);
  }

  const configuration = manifest.contributes?.configuration?.properties ?? {};
  assert.equal(configuration["aiChatbox.persistConversation"]?.default, false);
  assert.equal(configuration["aiChatbox.skillsEnabled"]?.default, false);
  assert.equal(configuration["aiChatbox.knowledgeEnabled"]?.default, false);
  assert.equal(configuration["aiChatbox.workflowsEnabled"]?.default, false);

  // Exercise the public command entry point. This must not require credentials or a model call.
  await vscode.commands.executeCommand("aiChatbox.open");

  console.log("AI Chatbox VS Code integration checks passed.");
}

module.exports = { run };
