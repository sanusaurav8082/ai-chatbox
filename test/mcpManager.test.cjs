const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMcpServerConfig, createMcpToolName, describeMcpServerEndpoint } = require("../dist/mcpManager.js");

test("accepts a valid stdio MCP server configuration", () => {
  assert.deepEqual(parseMcpServerConfig({
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    cwd: "/tmp/example",
    env: { NODE_ENV: "test" }
  }), {
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    cwd: "/tmp/example",
    env: { NODE_ENV: "test" }
  });
});

test("accepts HTTPS remote endpoints and localhost HTTP endpoints", () => {
  assert.equal(parseMcpServerConfig({
    transport: "streamable-http", url: "https://mcp.example.com/mcp"
  }).transport, "streamable-http");
  assert.equal(parseMcpServerConfig({
    transport: "streamable-http", url: "http://localhost:3000/mcp"
  }).transport, "streamable-http");
});

test("rejects remote plain HTTP and credentials embedded in URLs", () => {
  assert.throws(() => parseMcpServerConfig({
    transport: "streamable-http", url: "http://mcp.example.com/mcp"
  }), /must use HTTPS/);
  assert.throws(() => parseMcpServerConfig({
    transport: "streamable-http", url: "https://user:secret@mcp.example.com/mcp"
  }), /Do not embed credentials/);
});

test("rejects malformed stdio configuration and oversized arguments", () => {
  assert.throws(() => parseMcpServerConfig({ transport: "stdio", command: "" }), /non-empty command/);
  assert.throws(() => parseMcpServerConfig({
    transport: "stdio", command: "node", args: Array.from({ length: 101 }, () => "arg")
  }), /at most 100 strings/);
  assert.throws(() => parseMcpServerConfig({
    transport: "stdio", command: "node", env: { "NOT VALID": "value" }
  }), /valid environment names/);
});

test("redacts query strings and fragments from MCP endpoint diagnostics", () => {
  const config = parseMcpServerConfig({
    transport: "streamable-http", url: "https://mcp.example.com/mcp?access_token=secret#fragment"
  });
  assert.equal(describeMcpServerEndpoint(config), "Streamable HTTP endpoint: https://mcp.example.com/mcp");
  assert.equal(describeMcpServerEndpoint({ transport: "stdio", command: "node" }), "stdio command: node");
});

test("names MCP tools with a stable server prefix and safe characters", () => {
  assert.equal(createMcpToolName("filesystem", "read_file"), "mcp_filesystem_read_file");
  assert.match(createMcpToolName("server", "unsafe/name"), /^mcp_server_unsafe_name$/);
});

test("bounds long provider tool names to 80 characters", () => {
  const name = createMcpToolName("s".repeat(48), "t".repeat(200));
  assert.ok(name.length <= 80);
  assert.match(name, /_[a-f0-9]{8}$/);
});
