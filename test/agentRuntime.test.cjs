const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AgentRuntime,
  CallbackPermissionService,
  DenyAllPermissionService
} = require("../dist/agentRuntime.js");

function fakeModel(turns) {
  const requests = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const turn = turns.shift();
      if (!turn) throw new Error("No fake model turn configured.");
      return turn;
    }
  };
}

function makeTool(overrides = {}) {
  return {
    name: "echo",
    description: "Echo input back to the caller.",
    validateInput(input) {
      return input && typeof input.text === "string" ? undefined : "text must be a string";
    },
    async execute(input) {
      return { echoed: input.text };
    },
    ...overrides
  };
}

function run(runtime, messages = [{ role: "user", content: "hello" }]) {
  const events = [];
  return runtime.run({
    messages,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event)
  }).then((result) => ({ result, events }));
}

test("returns a final answer without executing tools", async () => {
  const model = fakeModel([{ type: "final", content: "Hello there." }]);
  let executed = false;
  const runtime = new AgentRuntime({
    model,
    tools: [makeTool({ async execute() { executed = true; return "no"; } })],
    permissions: new DenyAllPermissionService()
  });

  const { result, events } = await run(runtime);
  assert.equal(result.finalText, "Hello there.");
  assert.equal(result.reason, "completed");
  assert.equal(result.iterations, 1);
  assert.equal(executed, false);
  assert.ok(events.some((event) => event.type === "assistantDelta" && event.text === "Hello there."));
});

test("asks permission before executing a proposed tool", async () => {
  const model = fakeModel([
    { type: "toolCalls", toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "ok" } }] },
    { type: "final", content: "The tool returned {"echoed":"ok"}." }
  ]);
  const decisions = [];
  const runtime = new AgentRuntime({
    model,
    tools: [makeTool()],
    permissions: new CallbackPermissionService(async ({ tool, input }) => {
      decisions.push({ name: tool.name, input });
      return "allow";
    })
  });

  const { result, events } = await run(runtime);
  assert.equal(result.finalText, 'The tool returned {"echoed":"ok"}.');
  assert.deepEqual(decisions, [{ name: "echo", input: { text: "ok" } }]);
  assert.ok(events.some((event) => event.type === "toolApprovalRequested"));
  assert.ok(events.some((event) => event.type === "toolFinished" && event.output === '{"echoed":"ok"}'));
  assert.equal(model.requests.length, 2);
  assert.ok(model.requests[1].messages.some((message) => message.role === "tool" && message.content === '{"echoed":"ok"}'));
});

test("denies tool calls by default and never invokes the tool", async () => {
  const model = fakeModel([
    { type: "toolCalls", toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "unsafe" } }] },
    { type: "final", content: "No tool was run." }
  ]);
  let executions = 0;
  const runtime = new AgentRuntime({
    model,
    tools: [makeTool({ async execute() { executions += 1; return "unexpected"; } })],
    permissions: new DenyAllPermissionService()
  });

  const { result, events } = await run(runtime);
  assert.equal(result.finalText, "No tool was run.");
  assert.equal(executions, 0);
  assert.ok(events.some((event) => event.type === "toolDenied"));
  assert.ok(model.requests[1].messages.some((message) => message.role === "tool" && /denied/.test(message.content)));
});

test("rejects invalid tool arguments without requesting approval", async () => {
  const model = fakeModel([
    { type: "toolCalls", toolCalls: [{ id: "call-1", name: "echo", arguments: { text: 12 } }] },
    { type: "final", content: "Input was invalid." }
  ]);
  let permissionRequests = 0;
  let executions = 0;
  const runtime = new AgentRuntime({
    model,
    tools: [makeTool({ async execute() { executions += 1; return "unexpected"; } })],
    permissions: new CallbackPermissionService(async () => { permissionRequests += 1; return "allow"; })
  });

  await run(runtime);
  assert.equal(permissionRequests, 0);
  assert.equal(executions, 0);
  assert.ok(model.requests[1].messages.some((message) => message.role === "tool" && /Invalid tool input/.test(message.content)));
});

test("reports unknown tools to the model instead of executing them", async () => {
  const model = fakeModel([
    { type: "toolCalls", toolCalls: [{ id: "call-1", name: "missing", arguments: {} }] },
    { type: "final", content: "Unknown tool handled." }
  ]);
  const runtime = new AgentRuntime({ model, tools: [], permissions: new DenyAllPermissionService() });

  await run(runtime);
  assert.ok(model.requests[1].messages.some((message) => message.role === "tool" && /Unknown tool/.test(message.content)));
});

test("bounds tool output before feeding it back to the model", async () => {
  const model = fakeModel([
    { type: "toolCalls", toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "x" } }] },
    { type: "final", content: "Done." }
  ]);
  const runtime = new AgentRuntime({
    model,
    tools: [makeTool({ async execute() { return "z".repeat(1000); } })],
    permissions: new CallbackPermissionService(async () => "allow"),
    maxToolResultChars: 256
  });

  await run(runtime);
  const toolMessage = model.requests[1].messages.find((message) => message.role === "tool");
  assert.ok(toolMessage.content.length < 300);
  assert.match(toolMessage.content, /tool output truncated/);
});

test("stops at the configured iteration limit", async () => {
  const model = fakeModel([
    { type: "toolCalls", toolCalls: [] },
    { type: "toolCalls", toolCalls: [] }
  ]);
  const runtime = new AgentRuntime({
    model,
    tools: [],
    permissions: new DenyAllPermissionService(),
    maxIterations: 1
  });

  const { result, events } = await run(runtime);
  assert.equal(result.reason, "iteration-limit");
  assert.equal(result.iterations, 1);
  assert.ok(events.some((event) => event.type === "done" && event.reason === "iteration-limit"));
});

test("handles cancellation before the first model call", async () => {
  const model = fakeModel([{ type: "final", content: "should not happen" }]);
  const runtime = new AgentRuntime({ model, tools: [], permissions: new DenyAllPermissionService() });
  const controller = new AbortController();
  controller.abort();
  const events = [];

  const result = await runtime.run({
    messages: [{ role: "user", content: "hello" }],
    signal: controller.signal,
    onEvent: (event) => events.push(event)
  });
  assert.equal(result.reason, "cancelled");
  assert.equal(model.requests.length, 0);
  assert.ok(events.some((event) => event.type === "done" && event.reason === "cancelled"));
});

test("rejects duplicate tool registrations", () => {
  assert.throws(
    () => new AgentRuntime({
      model: fakeModel([]),
      tools: [makeTool(), makeTool()],
      permissions: new DenyAllPermissionService()
    }),
    /Duplicate tool registration/
  );
});
