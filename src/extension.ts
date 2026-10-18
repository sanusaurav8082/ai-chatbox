import * as vscode from "vscode";
import { ChatView, OPENAI_API_KEY_SECRET } from "./chatView";

export function activate(context: vscode.ExtensionContext): void {
  const openChat = vscode.commands.registerCommand("aiChatbox.open", () => {
    ChatView.open(context);
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

  context.subscriptions.push(openChat, setOpenAiApiKey, clearOpenAiApiKey);
}

export function deactivate(): void {
  // Long-lived services will be disposed here as the agent runtime is added.
}
