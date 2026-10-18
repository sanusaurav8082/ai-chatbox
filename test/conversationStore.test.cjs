const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_HISTORY_MESSAGES,
  MAX_STORED_CONVERSATION_BYTES,
  validateStoredConversation,
  toTranscriptMessages
} = require("../dist/conversationStore.js");

test("restores valid user, assistant, tool-call, and tool-result messages", () => {
  const history = [
    { role: "user", content: "Find the files." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "list_workspace_files", arguments: { pattern: "src/**/*.ts" } }]
    },
    { role: "tool", toolCallId: "call-1", name: "list_workspace_files", content: "{\"files\":[\"src/extension.ts\"]}" },
    { role: "assistant", content: "I found one file." }
  ];

  assert.deepEqual(validateStoredConversation(history), history);
});

test("rejects non-arrays, excess messages, and oversized serialized history", () => {
  assert.deepEqual(validateStoredConversation(null), []);
  assert.deepEqual(validateStoredConversation("not history"), []);
  assert.deepEqual(validateStoredConversation(
    Array.from({ length: MAX_HISTORY_MESSAGES + 1 }, () => ({ role: "user", content: "x" }))
  ), []);
  assert.deepEqual(validateStoredConversation([
    { role: "user", content: "x".repeat(MAX_STORED_CONVERSATION_BYTES) }
  ]), []);
});

test("rejects malformed messages and unsupported roles instead of partially restoring them", () => {
  assert.deepEqual(validateStoredConversation([
    { role: "user", content: "valid" },
    { role: "admin", content: "unexpected" }
  ]), []);
  assert.deepEqual(validateStoredConversation([{ role: "user", content: 42 }]), []);
  assert.deepEqual(validateStoredConversation([{ role: "tool", toolCallId: "id", name: "tool", content: 42 }]), []);
});

test("rejects malformed or excessive assistant tool calls", () => {
  assert.deepEqual(validateStoredConversation([{
    role: "assistant", content: "",
    toolCalls: [{ id: "", name: "safe_tool", arguments: {} }]
  }]), []);
  assert.deepEqual(validateStoredConversation([{
    role: "assistant", content: "",
    toolCalls: [{ id: "call-1", name: "unsafe/name", arguments: {} }]
  }]), []);
  assert.deepEqual(validateStoredConversation([{
    role: "assistant", content: "",
    toolCalls: Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: "safe_tool", arguments: {} }))
  }]), []);
});

test("rejects tool-call metadata on non-assistant messages", () => {
  assert.deepEqual(validateStoredConversation([{
    role: "user", content: "hi", toolCalls: []
  }]), []);
  assert.deepEqual(validateStoredConversation([{
    role: "tool", content: "ok", toolCallId: "id", name: "tool", toolCalls: []
  }]), []);
});

test("creates a display transcript without system prompts or tool traffic", () => {
  const history = validateStoredConversation([
    { role: "system", content: "Internal instructions" },
    { role: "user", content: "List files" },
    { role: "assistant", content: "" },
    { role: "tool", toolCallId: "call-1", name: "list_workspace_files", content: "secret tool output" },
    { role: "assistant", content: "Here are the files." }
  ]);

  assert.deepEqual(toTranscriptMessages(history), [
    { role: "user", content: "List files" },
    { role: "assistant", content: "Here are the files." }
  ]);
});
