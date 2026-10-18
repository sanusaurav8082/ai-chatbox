const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgentModelAdapter } = require("../dist/agentModelAdapter.js");

const config = {
  provider: "openai-compatible",
  modelId: "test-model",
  baseUrl: "http://localhost:11434/v1",
  requestTimeoutMs: 10_000
};

function request(messages = [{ role: "user", content: "list files" }], tools = [{ name: "list_workspace_files", description: "List workspace files" }]) {
  return { messages, tools, signal: new AbortController().signal };
}

test("sends structured tools to OpenAI-compatible endpoint and parses tool calls", async () => {
  let body;
  const adapter = createAgentModelAdapter({
    config,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{
          id: "call-1", type: "function", function: { name: "list_workspace_files", arguments: JSON.stringify({ pattern: "src/**/*.ts" }) }
        }] } }]
      }), { status: 200 });
    }
  });
  const result = await adapter.complete(request());
  assert.equal(body.stream, false);
  assert.equal(body.tools[0].function.name, "list_workspace_files");
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(result, {
    type: "toolCalls",
    content: "",
    toolCalls: [{ id: "call-1", name: "list_workspace_files", arguments: { pattern: "src/**/*.ts" } }]
  });
});

test("serializes assistant tool calls and tool results in provider message format", async () => {
  let body;
  const adapter = createAgentModelAdapter({
    config,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Done." } }] }), { status: 200 });
    }
  });
  await adapter.complete(request([
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "list_workspace_files", arguments: {} }] },
    { role: "tool", toolCallId: "call-1", name: "list_workspace_files", content: JSON.stringify({ files: [] }) }
  ], []));
  assert.equal(body.messages[0].tool_calls[0].function.arguments, "{}");
  assert.equal(body.messages[1].tool_call_id, "call-1");
  assert.equal(body.messages[1].content, JSON.stringify({ files: [] }));
});

test("returns a final assistant answer", async () => {
  const adapter = createAgentModelAdapter({
    config,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "There are 3 files." } }]
    }), { status: 200 })
  });
  assert.deepEqual(await adapter.complete(request()), { type: "final", content: "There are 3 files." });
});

test("rejects missing OpenAI credentials before making a request", async () => {
  let called = false;
  const adapter = createAgentModelAdapter({
    config: { ...config, provider: "openai" },
    fetchImpl: async () => { called = true; throw new Error("unexpected"); }
  });
  await assert.rejects(adapter.complete(request()), /API key is missing/);
  assert.equal(called, false);
});

test("marks malformed JSON arguments so tool validation can reject them", async () => {
  const adapter = createAgentModelAdapter({
    config,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        id: "call-1", function: { name: "list_workspace_files", arguments: "{bad" }
      }] } }]
    }), { status: 200 })
  });
  const result = await adapter.complete(request());
  assert.equal(result.type, "toolCalls");
  if (result.type === "toolCalls") assert.equal(result.toolCalls[0].arguments.__invalidJson, true);
});
