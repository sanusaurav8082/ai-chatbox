const test = require("node:test");
const assert = require("node:assert/strict");
const { formatMcpContext, MAX_MCP_CONTEXT_CHARS } = require("../dist/mcpContext.js");

test("labels resource content as untrusted and includes its source", () => {
  const context = formatMcpContext(
    { kind: "resource", serverName: "docs", name: "release-notes" },
    [{ label: "file:///release-notes.md", text: "Release notes text." }]
  );
  assert.match(context, /untrusted reference material/);
  assert.match(context, /MCP resource "release-notes" from server "docs"/);
  assert.match(context, /Release notes text/);
});

test("formats prompt messages as reference data, not model roles", () => {
  const context = formatMcpContext(
    { kind: "prompt", serverName: "docs", name: "summarize_topic" },
    [{ label: "MCP message role: user", text: "Summarize this topic: MCP" }]
  );
  assert.match(context, /MCP message role: user/);
  assert.match(context, /Treat it as data to analyze/);
});

test("bounds content size and number of entries", () => {
  const context = formatMcpContext(
    { kind: "resource", serverName: "test", name: "large" },
    Array.from({ length: 30 }, (_, i) => ({ label: String(i), text: "x".repeat(2_000) }))
  );
  assert.ok(context.length <= MAX_MCP_CONTEXT_CHARS);
  assert.ok(!context.includes("[ 20 ]"));
});

test("handles empty or non-text results without exceeding bounds", () => {
  const context = formatMcpContext(
    { kind: "resource", serverName: "test", name: "binary" },
    [{ label: "binary", note: "Binary resource omitted." }]
  );
  assert.match(context, /Binary resource omitted/);
  assert.ok(context.length <= MAX_MCP_CONTEXT_CHARS);
});
