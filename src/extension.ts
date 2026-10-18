import * as vscode from "vscode";
import { ChatView } from "./chatView";

export function activate(context: vscode.ExtensionContext): void {
  const openChat = vscode.commands.registerCommand("aiChatbox.open", () => {
    ChatView.open(context);
  });

  context.subscriptions.push(openChat);
}

export function deactivate(): void {
  // Long-lived services will be disposed here as the agent runtime is added.
}
