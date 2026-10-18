import { AgentMessage, AgentToolCall } from "./agentRuntime";

export const MAX_HISTORY_MESSAGES = 40;
export const MAX_STORED_CONVERSATION_BYTES = 250_000;
const MAX_MESSAGE_CONTENT_CHARS = 50_000;
const MAX_TOOL_CALLS_PER_MESSAGE = 8;
const MAX_TOOL_IDENTIFIER_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Treat persisted state as untrusted input. Return an empty history rather than
 * partially accepting a malformed transcript that could break provider requests.
 */
export function validateStoredConversation(value: unknown): AgentMessage[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_MESSAGES) return [];
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || serialized.length > MAX_STORED_CONVERSATION_BYTES) return [];
  } catch {
    return [];
  }

  const result: AgentMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.content !== "string" || item.content.length > MAX_MESSAGE_CONTENT_CHARS) {
      return [];
    }

    if (item.role === "user" || item.role === "system") {
      if ("toolCalls" in item || "toolCallId" in item || "name" in item) return [];
      result.push({ role: item.role, content: item.content });
      continue;
    }

    if (item.role === "assistant") {
      if ("toolCallId" in item || "name" in item) return [];
      if (item.toolCalls === undefined) {
        result.push({ role: "assistant", content: item.content });
        continue;
      }
      if (!Array.isArray(item.toolCalls) || item.toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE) return [];
      const calls: AgentToolCall[] = [];
      for (const call of item.toolCalls) {
        if (!isRecord(call) ||
            typeof call.id !== "string" || !call.id.length || call.id.length > MAX_TOOL_IDENTIFIER_CHARS ||
            typeof call.name !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(call.name) ||
            !("arguments" in call)) return [];
        try {
          if (JSON.stringify(call.arguments) === undefined) return [];
        } catch {
          return [];
        }
        calls.push({ id: call.id, name: call.name, arguments: call.arguments });
      }
      result.push({ role: "assistant", content: item.content, toolCalls: calls });
      continue;
    }

    if (item.role === "tool") {
      if (typeof item.toolCallId !== "string" || !item.toolCallId.length ||
          item.toolCallId.length > MAX_TOOL_IDENTIFIER_CHARS ||
          typeof item.name !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(item.name) ||
          "toolCalls" in item) return [];
      result.push({
        role: "tool",
        toolCallId: item.toolCallId,
        name: item.name,
        content: item.content
      });
      continue;
    }

    return [];
  }
  return result;
}

export function toTranscriptMessages(
  messages: AgentMessage[]
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.flatMap((message) =>
    (message.role === "user" || message.role === "assistant") && message.content.trim()
      ? [{ role: message.role, content: message.content }]
      : []
  );
}
