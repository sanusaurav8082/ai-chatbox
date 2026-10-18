const test = require("node:test");
const assert = require("node:assert/strict");
const { getCompletionEndpoint, streamChatCompletion } = require("../dist/modelClient.js");

const config = {
  provider: "openai-compatible",
  modelId: "test-model",
  baseUrl: "http://localhost:11434/v1",
  requestTimeoutMs: 10_000
};

test("normalizes a base URL to the chat completions endpoint", () => {
  assert.equal(
    getCompletionEndpoint("http://localhost:11434/v1/"),
    "http://localhost:11434/v1/chat/completions"
  );
  assert.equal(
    getCompletionEndpoint("https://example.test/v1/chat/completions"),
    "https://example.test/v1/chat/completions"
  );
});

test("rejects invalid and non-HTTP endpoint URLs", () => {
  assert.throws(() => getCompletionEndpoint("not a URL"), /invalid/i);
  assert.throws(() => getCompletionEndpoint("file:///tmp/model"), /HTTP or HTTPS/i);
});

test("streams text deltas from server-sent events", async () => {
  let requestedUrl;
  let requestedBody;
  let requestedHeaders;
  const fakeFetch = async (url, init) => {
    requestedUrl = url;
    requestedBody = JSON.parse(init.body);
    requestedHeaders = init.headers;
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        "",
        "data: [DONE]",
        ""
      ].join("\n"),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  };

  const deltas = [];
  await streamChatCompletion({
    config,
    messages: [{ role: "user", content: "Hi" }],
    signal: new AbortController().signal,
    onDelta: (delta) => deltas.push(delta),
    fetchImpl: fakeFetch
  });

  assert.equal(requestedUrl, "http://localhost:11434/v1/chat/completions");
  assert.deepEqual(deltas, ["Hello", " world"]);
  assert.equal(requestedBody.model, "test-model");
  assert.equal(requestedBody.stream, true);
  assert.equal(requestedHeaders.Authorization, undefined);
});

test("requires an API key for the OpenAI provider", async () => {
  await assert.rejects(
    streamChatCompletion({
      config: { ...config, provider: "openai" },
      messages: [],
      signal: new AbortController().signal,
      onDelta() {},
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    }),
    /API key is missing/
  );
});

test("surfaces bounded HTTP error details", async () => {
  await assert.rejects(
    streamChatCompletion({
      config,
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onDelta() {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 })
    }),
    /Model request failed \(400\): bad model/
  );
});
