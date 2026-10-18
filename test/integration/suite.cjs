const assert = require("node:assert/strict");
const http = require("node:http");
const vscode = require("vscode");
const { createAgentModelAdapter } = require("../../dist/agentModelAdapter.js");
const { streamChatCompletion } = require("../../dist/modelClient.js");
const {
  AgentRuntime,
  CallbackPermissionService
} = require("../../dist/agentRuntime.js");

async function withMockModelServer(handler, callback) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400).end("invalid json");
      return;
    }
    await handler(body, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonResponse(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function testAgentProviderToolApproval(decision) {
  let requestCount = 0;
  let executionCount = 0;
  const serverRequests = [];

  await withMockModelServer(async (body, response) => {
    requestCount += 1;
    serverRequests.push(body);
    assert.equal(body.model, "integration-test-model");
    assert.equal(body.stream, false);
    if (requestCount === 1) {
      assert.ok(Array.isArray(body.tools) && body.tools.length === 1, "Expected tool schema on first model request.");
      return jsonResponse(response, {
        choices: [{
          message: {
            role: "assistant",
            content: "I can inspect the fixture.",
            tool_calls: [{
              id: "integration-call-1",
              type: "function",
              function: { name: "fixture_echo", arguments: JSON.stringify({ text: "hello from test" }) }
            }]
          }
        }]
      });
    }

    assert.ok(body.messages.some((message) =>
      message.role === "tool" && message.tool_call_id === "integration-call-1"
    ), "Expected tool result/denial to be sent back to the model.");
    return jsonResponse(response, {
      choices: [{ message: { role: "assistant", content: "Mock model completed the turn." } }]
    });
  }, async (baseUrl) => {
    const runtime = new AgentRuntime({
      model: createAgentModelAdapter({
        config: {
          provider: "openai-compatible",
          modelId: "integration-test-model",
          baseUrl,
          requestTimeoutMs: 5_000
        }
      }),
      tools: [{
        name: "fixture_echo",
        description: "A deterministic test-only tool.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false
        },
        validateInput(input) {
          return input && typeof input.text === "string" ? undefined : "text must be a string";
        },
        async execute(input) {
          executionCount += 1;
          return { echoed: input.text };
        }
      }],
      permissions: new CallbackPermissionService(async () => decision),
      maxIterations: 3
    });

    const result = await runtime.run({
      messages: [{ role: "user", content: "Use the fixture echo tool." }],
      signal: new AbortController().signal,
      onEvent: () => {}
    });

    assert.equal(result.reason, "completed");
    assert.equal(result.finalText, "Mock model completed the turn.");
    assert.equal(requestCount, 2);
    assert.equal(executionCount, decision === "allow" ? 1 : 0);
    assert.ok(serverRequests[0].tools[0].function.parameters);
    const toolResult = serverRequests[1].messages.find((message) => message.role === "tool");
    assert.ok(toolResult);
    if (decision === "deny") assert.match(toolResult.content, /denied/i);
    else assert.match(toolResult.content, /hello from test/);
  });
}


async function testStreamingModelClient() {
  const deltas = [];
  await withMockModelServer(async (_body, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"stream"}}]}\n\n');
    response.end("data: [DONE]\n\n");
  }, async (baseUrl) => {
    await streamChatCompletion({
      config: {
        provider: "openai-compatible",
        modelId: "integration-test-model",
        baseUrl,
        requestTimeoutMs: 5_000
      },
      messages: [{ role: "user", content: "Stream a test response." }],
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta)
    });
  });
  assert.equal(deltas.join(""), "hello stream");
}

async function testAgentCancellation() {
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  await withMockModelServer(async (_body, response) => {
    requestStarted();
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!response.destroyed) jsonResponse(response, {
      choices: [{ message: { role: "assistant", content: "This response should be cancelled." } }]
    });
  }, async (baseUrl) => {
    const controller = new AbortController();
    const runtime = new AgentRuntime({
      model: createAgentModelAdapter({
        config: {
          provider: "openai-compatible",
          modelId: "integration-test-model",
          baseUrl,
          requestTimeoutMs: 5_000
        }
      }),
      tools: [],
      permissions: new CallbackPermissionService(async () => "deny"),
      maxIterations: 2
    });
    const runPromise = runtime.run({
      messages: [{ role: "user", content: "Cancel this request." }],
      signal: controller.signal,
      onEvent: () => {}
    });
    await started;
    controller.abort();
    const result = await runPromise;
    assert.equal(result.reason, "cancelled");
  });
}


async function withMockMcpServer(callback) {
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { z } = require("zod");
  const mcpServer = new McpServer({ name: "ai-chatbox-integration-fixture", version: "1.0.0" });
  let toolCallCount = 0;
  mcpServer.resource(
    "release-notes",
    "file:///release-notes.md",
    { description: "Fixture release notes", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "Fixture release notes: safe deterministic content." }] })
  );
  mcpServer.prompt(
    "summarize_topic",
    "Create a short summary prompt for a topic.",
    { topic: z.string() },
    async ({ topic }) => ({ messages: [{ role: "user", content: { type: "text", text: `Summarize this topic: ${topic}` } }] })
  );
  mcpServer.tool(
    "fixture_echo",
    "Echo text for deterministic integration testing.",
    { text: z.string() },
    async ({ text }) => {
      toolCallCount += 1;
      return { content: [{ type: "text", text: `echo:${text}` }] };
    }
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => require("node:crypto").randomUUID() });
  await mcpServer.connect(transport);
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/mcp")) {
      void transport.handleRequest(request, response);
      return;
    }
    response.writeHead(404).end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}/mcp`, () => toolCallCount);
  } finally {
    await mcpServer.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testMcpAgentToolApproval(decision) {
  const { McpManager } = require("../../dist/mcpManager.js");
  let requestCount = 0;
  const serverRequests = [];
  const manager = new McpManager(async () => undefined);

  await withMockMcpServer(async (mcpUrl, getMcpToolCallCount) => {
    const discovered = await manager.connect("fixture", {
      transport: "streamable-http",
      url: mcpUrl
    });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].name, "fixture_echo");
    assert.equal(discovered[0].inputSchema.type, "object");
    assert.ok(discovered[0].inputSchema.properties.text);

    const resources = await manager.listResources("fixture");
    assert.equal(resources.length, 1);
    assert.equal(resources[0].name, "release-notes");
    const resourceContents = await manager.readResource("fixture", resources[0].uri);
    assert.match(resourceContents[0].text, /safe deterministic content/);

    const prompts = await manager.listPrompts("fixture");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].name, "summarize_topic");
    assert.equal(prompts[0].arguments[0].name, "topic");
    const promptMessages = await manager.getPrompt("fixture", "summarize_topic", { topic: "MCP resources" });
    assert.equal(promptMessages.length, 1);
    assert.match(promptMessages[0].text, /MCP resources/);

    await withMockModelServer(async (body, response) => {
      requestCount += 1;
      serverRequests.push(body);
      assert.equal(body.model, "integration-test-model");
      assert.equal(body.stream, false);
      if (requestCount === 1) {
        assert.ok(Array.isArray(body.tools), "Expected MCP tool schema to be forwarded to the model.");
        const tool = body.tools.find((item) => item.function?.name === "mcp_fixture_fixture_echo");
        assert.ok(tool, "Expected normalized MCP tool name in model request.");
        assert.ok(tool.function.parameters.properties.text, "Expected discovered input schema to reach the model.");
        return jsonResponse(response, {
          choices: [{
            message: {
              role: "assistant",
              content: "I will use the discovered MCP tool.",
              tool_calls: [{
                id: "mcp-integration-call-1",
                type: "function",
                function: {
                  name: "mcp_fixture_fixture_echo",
                  arguments: JSON.stringify({ text: "hello from MCP" })
                }
              }]
            }
          }]
        });
      }

      assert.ok(body.messages.some((message) =>
        message.role === "tool" && message.tool_call_id === "mcp-integration-call-1"
      ), "Expected MCP tool result or denial to be returned to the model.");
      return jsonResponse(response, {
        choices: [{ message: { role: "assistant", content: "MCP tool turn completed." } }]
      });
    }, async (baseUrl) => {
      const runtime = new AgentRuntime({
        model: createAgentModelAdapter({
          config: {
            provider: "openai-compatible",
            modelId: "integration-test-model",
            baseUrl,
            requestTimeoutMs: 5_000
          }
        }),
        tools: manager.getAgentTools(),
        permissions: new CallbackPermissionService(async () => decision),
        maxIterations: 3
      });
      const result = await runtime.run({
        messages: [{ role: "user", content: "Use the connected MCP echo tool." }],
        signal: new AbortController().signal,
        onEvent: () => {}
      });
      assert.equal(result.reason, "completed");
      assert.equal(result.finalText, "MCP tool turn completed.");
    });

    assert.equal(requestCount, 2);
    assert.equal(getMcpToolCallCount(), decision === "allow" ? 1 : 0,
      "Denied MCP tools must never reach the MCP server.");
    assert.equal(serverRequests.length, 2);
    const toolResult = serverRequests[1].messages.find((message) =>
      message.role === "tool" && message.tool_call_id === "mcp-integration-call-1"
    );
    assert.ok(toolResult);
    if (decision === "deny") assert.match(toolResult.content, /denied/i);
    else assert.match(toolResult.content, /echo:hello from MCP/);
  });

  await manager.disconnectAll();
}

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

  // Exercise the public command entry point without credentials or a model call.
  await vscode.commands.executeCommand("aiChatbox.open");

  // Exercise the actual HTTP adapter and agent loop against a local deterministic server.
  await testAgentProviderToolApproval("allow");
  await testAgentProviderToolApproval("deny");
  await testMcpAgentToolApproval("allow");
  await testMcpAgentToolApproval("deny");

  console.log("AI Chatbox VS Code, streaming, cancellation, agent/provider, and MCP integration checks passed.");
}

module.exports = { run };
