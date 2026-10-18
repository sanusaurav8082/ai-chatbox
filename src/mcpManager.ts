import { createHash } from "node:crypto";
import Ajv, { ValidateFunction } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolDefinition } from "./agentRuntime";

export interface StdioMcpServerConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface HttpMcpServerConfig {
  transport: "streamable-http";
  url: string;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ConnectedServer {
  name: string;
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: McpToolSummary[];
}

const MAX_SERVER_NAME_LENGTH = 48;
const MAX_ARGS = 100;
const MAX_ENV_ENTRIES = 100;
const MAX_TOOL_PAGES = 20;
const TOOL_CALL_TIMEOUT_MS = 30_000;
const ajv = new Ajv({ allErrors: true, strict: false });

/** Validates settings before any process is spawned or remote endpoint is contacted. */
export function parseMcpServerConfig(value: unknown): McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP server configuration must be an object.");
  }
  const config = value as Record<string, unknown>;
  if (config.transport === "stdio") {
    if (typeof config.command !== "string" || !config.command.trim() || config.command.length > 1_000) {
      throw new Error("stdio MCP server requires a non-empty command (max 1000 characters).");
    }
    const args = config.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_ARGS ||
        args.some((arg) => typeof arg !== "string" || arg.length > 4_000)) {
      throw new Error(`stdio args must be an array of at most ${MAX_ARGS} strings (max 4000 characters each).`);
    }
    if (config.cwd !== undefined && (typeof config.cwd !== "string" || config.cwd.length > 4_000)) {
      throw new Error("stdio cwd must be a string no longer than 4000 characters.");
    }
    const env = config.env ?? {};
    if (!env || typeof env !== "object" || Array.isArray(env) ||
        Object.keys(env).length > MAX_ENV_ENTRIES) {
      throw new Error(`stdio env must be an object with at most ${MAX_ENV_ENTRIES} entries.`);
    }
    for (const [key, entry] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          typeof entry !== "string" || entry.length > 8_000) {
        throw new Error("stdio env keys must be valid environment names and values must be strings up to 8000 characters.");
      }
    }
    return {
      transport: "stdio",
      command: config.command.trim(),
      args: args as string[],
      ...(typeof config.cwd === "string" && config.cwd ? { cwd: config.cwd } : {}),
      env: env as Record<string, string>
    };
  }
  if (config.transport === "streamable-http") {
    if (typeof config.url !== "string" || config.url.length > 4_000) {
      throw new Error("Streamable HTTP MCP server requires a URL.");
    }
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error("MCP server URL must be an absolute HTTP(S) URL.");
    }
    if (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("Remote MCP endpoints must use HTTPS. HTTP is allowed only for localhost.");
    }
    if (url.username || url.password) throw new Error("Do not embed credentials in an MCP server URL.");
    return { transport: "streamable-http", url: url.toString() };
  }
  throw new Error('MCP server transport must be "stdio" or "streamable-http".');
}

export function createMcpToolName(serverName: string, toolName: string): string {
  const raw = `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (raw.length <= 80) return raw;
  const suffix = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${raw.slice(0, 71)}_${suffix}`;
}

/**
 * Owns MCP client lifetimes. It never connects implicitly: callers must first
 * validate the config and obtain explicit approval for the reviewed command/URL.
 */
export class McpManager {
  private readonly connected = new Map<string, ConnectedServer>();

  constructor(private readonly getBearerToken: (serverName: string) => Promise<string | undefined>) {}

  getConnectedNames(): string[] {
    return [...this.connected.keys()].sort();
  }

  getToolSummaries(): Array<{ serverName: string; tools: McpToolSummary[] }> {
    return [...this.connected.values()].map((server) => ({
      serverName: server.name,
      tools: server.tools.map((tool) => ({ ...tool }))
    }));
  }

  async connect(serverName: string, rawConfig: unknown): Promise<McpToolSummary[]> {
    if (!/^[a-zA-Z0-9_.-]{1,48}$/.test(serverName) || serverName.length > MAX_SERVER_NAME_LENGTH) {
      throw new Error("MCP server name must use letters, numbers, dots, underscores or hyphens (max 48 characters).");
    }
    if (this.connected.has(serverName)) throw new Error(`MCP server "${serverName}" is already connected.`);
    const config = parseMcpServerConfig(rawConfig);
    const client = new Client({ name: "ai-chatbox", version: "0.4.0" });
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (config.transport === "stdio") {
      // Preserve only common runtime variables required to locate tools and run
      // processes. Do not pass every extension-host environment variable.
      const inherited: Record<string, string> = {};
      for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"]) {
        const value = process.env[key];
        if (value) inherited[key] = value;
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        ...(config.cwd ? { cwd: config.cwd } : {}),
        env: { ...inherited, ...config.env }
      });
    } else {
      const token = await this.getBearerToken(serverName);
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
      });
    }

    try {
      await client.connect(transport);
      const tools: McpToolSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of result.tools) {
          const schema = tool.inputSchema;
          tools.push({
            name: tool.name.slice(0, 200),
            description: (tool.description ?? "").slice(0, 4_000),
            inputSchema: isRecord(schema) ? schema : { type: "object", properties: {} }
          });
          if (tools.length > 500) throw new Error("MCP server exposes more than 500 tools; refusing to register them.");
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (page === MAX_TOOL_PAGES - 1) throw new Error("MCP server tool listing exceeded the pagination limit.");
      }
      const seen = new Set<string>();
      for (const tool of tools) {
        const name = createMcpToolName(serverName, tool.name);
        if (seen.has(name)) throw new Error(`MCP tool names collide after normalization: ${name}`);
        seen.add(name);
      }
      this.connected.set(serverName, { name: serverName, config, client, transport, tools });
      return tools;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error instanceof Error ? error : new Error("Could not connect to MCP server.");
    }
  }

  async disconnect(serverName: string): Promise<void> {
    const server = this.connected.get(serverName);
    if (!server) return;
    this.connected.delete(serverName);
    if (server.transport instanceof StreamableHTTPClientTransport) {
      await server.transport.terminateSession().catch(() => undefined);
    }
    await server.client.close();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connected.keys()].map((name) => this.disconnect(name).catch(() => undefined)));
  }

  getAgentTools(): AgentToolDefinition[] {
    const definitions: AgentToolDefinition[] = [];
    for (const server of this.connected.values()) {
      for (const tool of server.tools) {
        const publicName = createMcpToolName(server.name, tool.name);
        let validate: ValidateFunction;
        try {
          validate = ajv.compile(tool.inputSchema);
        } catch {
          definitions.push({
            name: publicName,
            description: `MCP tool from ${server.name}: ${tool.description}`.slice(0, 4_000),
            inputSchema: tool.inputSchema,
            validateInput: () => "The MCP server supplied an invalid JSON Schema; this tool is disabled.",
            execute: async () => { throw new Error("Tool disabled because its input schema is invalid."); }
          });
          continue;
        }
        definitions.push({
          name: publicName,
          description: `MCP server "${server.name}": ${tool.description || tool.name}`.slice(0, 4_000),
          inputSchema: tool.inputSchema,
          validateInput(input: unknown): string | undefined {
            if (validate(input)) return undefined;
            const errors = (validate.errors ?? []).slice(0, 5).map((error) =>
              `${error.instancePath || "/"} ${error.message || "is invalid"}`
            );
            return `arguments do not match the server's input schema: ${errors.join("; ")}`;
          },
          async execute(input: unknown, signal: AbortSignal): Promise<unknown> {
            if (signal.aborted) throw new Error("Request cancelled.");
            const result = await callWithTimeout(
              server.client,
              tool.name,
              input as Record<string, unknown>,
              signal,
              TOOL_CALL_TIMEOUT_MS
            );
            if (signal.aborted) throw new Error("Request cancelled.");
            return normalizeToolResult(result);
          }
        });
      }
    }
    return definitions;
  }
}

async function callWithTimeout(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<unknown> {
  if (signal.aborted) throw new Error("Request cancelled.");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("MCP tool call cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`MCP tool call timed out after ${timeoutMs} ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([
      client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal }),
      aborted,
      timedOut
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function normalizeToolResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const content = Array.isArray(result.content)
    ? result.content.slice(0, 100).map((item) => {
      if (!isRecord(item)) return item;
      if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text.slice(0, 20_000) };
      if (item.type === "image") return { type: "image", mimeType: item.mimeType, note: "Image content omitted from text context." };
      return item;
    })
    : [];
  return {
    isError: result.isError === true,
    content,
    structuredContent: result.structuredContent
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
