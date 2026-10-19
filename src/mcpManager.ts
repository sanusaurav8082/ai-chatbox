import { createHash } from "node:crypto";
import Ajv, { ValidateFunction } from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
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

export interface McpResourceSummary {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface McpPromptSummary {
  name: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

export type McpNotificationKind = "resource-updated" | "resources-changed" | "prompts-changed" | "tools-changed";

export interface McpNotification {
  serverName: string;
  kind: McpNotificationKind;
  uri?: string;
  receivedAt: string;
}

export interface McpConnectionEvent {
  serverName: string;
  state: "disconnected" | "error";
  message: string;
  receivedAt: string;
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
const MAX_RESOURCE_PAGES = 20;
const MAX_PROMPT_PAGES = 20;
const MAX_MCP_ITEMS = 500;
const MAX_RESOURCE_TEXT = 20_000;
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

export function describeMcpServerEndpoint(config: McpServerConfig): string {
  if (config.transport === "stdio") return `stdio command: ${config.command}`;
  const url = new URL(config.url);
  // Query strings and fragments can contain sensitive values; omit them from diagnostics.
  url.search = "";
  url.hash = "";
  return `Streamable HTTP endpoint: ${url.toString()}`;
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
  private readonly connectionErrors = new Map<string, string>();
  private readonly recentNotifications: McpNotification[] = [];
  private readonly refreshingTools = new Map<string, Promise<void>>();
  private readonly toolRefreshRequested = new Set<string>();

  constructor(
    private readonly getBearerToken: (serverName: string) => Promise<string | undefined>,
    private readonly onNotification?: (notification: McpNotification) => void,
    private readonly onConnectionEvent?: (event: McpConnectionEvent) => void
  ) {}

  getRecentNotifications(): McpNotification[] {
    return this.recentNotifications.map((notification) => ({ ...notification }));
  }

  private recordNotification(serverName: string, kind: McpNotificationKind, rawUri?: string): void {
    let uri: string | undefined;
    if (rawUri) {
      try {
        const parsed = new URL(rawUri);
        parsed.search = "";
        parsed.hash = "";
        uri = parsed.toString().slice(0, 4_000);
      } catch {
        uri = rawUri.split(/[?#]/, 1)[0].slice(0, 4_000);
      }
    }
    const notification: McpNotification = { serverName, kind, ...(uri ? { uri } : {}), receivedAt: new Date().toISOString() };
    this.recentNotifications.push(notification);
    if (this.recentNotifications.length > 100) this.recentNotifications.splice(0, this.recentNotifications.length - 100);
    try { this.onNotification?.({ ...notification }); } catch { /* Diagnostics must not disrupt the MCP connection. */ }
  }

  getConnectedNames(): string[] {
    return [...this.connected.keys()].sort();
  }

  getToolSummaries(): Array<{ serverName: string; tools: McpToolSummary[] }> {
    return [...this.connected.values()].map((server) => ({
      serverName: server.name,
      tools: server.tools.map((tool) => ({ ...tool }))
    }));
  }

  /** Last connection error for diagnostics. */
  getConnectionError(serverName: string): string | undefined {
    return this.connectionErrors.get(serverName);
  }

  recordConnectionError(serverName: string, message: string): void {
    this.connectionErrors.set(serverName, message.slice(0, 2_000));
  }

  clearConnectionError(serverName: string): void {
    this.connectionErrors.delete(serverName);
  }

  async connect(serverName: string, rawConfig: unknown): Promise<McpToolSummary[]> {
    if (!/^[a-zA-Z0-9_.-]{1,48}$/.test(serverName) || serverName.length > MAX_SERVER_NAME_LENGTH) {
      throw new Error("MCP server name must use letters, numbers, dots, underscores or hyphens (max 48 characters).");
    }
    if (this.connected.has(serverName)) throw new Error(`MCP server "${serverName}" is already connected.`);
    const config = parseMcpServerConfig(rawConfig);
    const client = new Client({ name: "ai-chatbox", version: "0.5.0" });
    client.onerror = () => {
      if (this.connected.get(serverName)?.client !== client) return;
      // A transport error means the server can no longer be trusted as an
      // executable tool source. Remove its tools until the user reconnects.
      this.connected.delete(serverName);
      this.refreshingTools.delete(serverName);
      this.toolRefreshRequested.delete(serverName);
      const message = "MCP transport failed. Its tools have been disabled; review diagnostics and reconnect manually if needed.";
      this.recordConnectionError(serverName, message);
      try { this.onConnectionEvent?.({ serverName, state: "error", message, receivedAt: new Date().toISOString() }); } catch { /* Diagnostics must not disrupt the MCP connection. */ }
    };
    client.onclose = () => {
      if (this.connected.get(serverName)?.client !== client) return;
      this.connected.delete(serverName);
      this.refreshingTools.delete(serverName);
      this.toolRefreshRequested.delete(serverName);
      const message = "MCP connection closed unexpectedly. Review the configured server and reconnect manually; AI Chatbox will not restart it automatically.";
      this.recordConnectionError(serverName, message);
      try { this.onConnectionEvent?.({ serverName, state: "disconnected", message, receivedAt: new Date().toISOString() }); } catch { /* Diagnostics must not disrupt the MCP connection. */ }
    };

    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
      this.recordNotification(serverName, "resource-updated", notification.params.uri);
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      this.recordNotification(serverName, "resources-changed");
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      this.recordNotification(serverName, "prompts-changed");
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      this.recordNotification(serverName, "tools-changed");
      try {
        await this.refreshToolSchemas(serverName, client);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        this.recordConnectionError(serverName, `Could not refresh MCP tool schemas: ${detail}`);
      }
    });
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
          if (typeof tool.name !== "string" || !tool.name || tool.name.length > 200) {
            throw new Error("MCP server returned a tool name that is empty or longer than 200 characters.");
          }
          tools.push({
            name: tool.name,
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

  async listResources(serverName: string): Promise<McpResourceSummary[]> {
    const server = this.requireConnectedServer(serverName);
    const resources: McpResourceSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_RESOURCE_PAGES; page += 1) {
      const result = await server.client.listResources(cursor ? { cursor } : undefined);
      for (const resource of result.resources) {
        resources.push({
          uri: String(resource.uri).slice(0, 4_000),
          name: String(resource.name ?? resource.uri).slice(0, 500),
          description: String(resource.description ?? "").slice(0, 2_000),
          ...(resource.mimeType ? { mimeType: String(resource.mimeType).slice(0, 200) } : {})
        });
        if (resources.length > MAX_MCP_ITEMS) throw new Error("MCP server exposes more than 500 resources; refusing to list them.");
      }
      cursor = result.nextCursor;
      if (!cursor) return resources;
      if (page === MAX_RESOURCE_PAGES - 1) throw new Error("MCP resource listing exceeded the pagination limit.");
    }
    return resources;
  }

  async readResource(serverName: string, uri: string): Promise<Array<{ uri: string; mimeType?: string; text?: string; note?: string }>> {
    const server = this.requireConnectedServer(serverName);
    if (typeof uri !== "string" || !uri.trim() || uri.length > 4_000) throw new Error("MCP resource URI must be a non-empty string up to 4000 characters.");
    const result = await server.client.readResource({ uri });
    let remaining = MAX_RESOURCE_TEXT;
    return result.contents.slice(0, 20).map((item) => {
      const normalized: { uri: string; mimeType?: string; text?: string; note?: string } = {
        uri: String(item.uri).slice(0, 4_000),
        ...(item.mimeType ? { mimeType: String(item.mimeType).slice(0, 200) } : {})
      };
      if ("text" in item && typeof item.text === "string") {
        normalized.text = item.text.slice(0, remaining);
        remaining -= normalized.text.length;
        if (item.text.length > normalized.text.length) normalized.note = "Resource text truncated by AI Chatbox size limit.";
      } else {
        normalized.note = "Binary resource content is not rendered by AI Chatbox.";
      }
      if (remaining <= 0) normalized.note = "Resource output reached the 20000-character limit.";
      return normalized;
    });
  }

  async listPrompts(serverName: string): Promise<McpPromptSummary[]> {
    const server = this.requireConnectedServer(serverName);
    const prompts: McpPromptSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PROMPT_PAGES; page += 1) {
      const result = await server.client.listPrompts(cursor ? { cursor } : undefined);
      for (const prompt of result.prompts) {
        prompts.push({
          name: String(prompt.name).slice(0, 500),
          description: String(prompt.description ?? "").slice(0, 2_000),
          arguments: (prompt.arguments ?? []).slice(0, 50).map((argument) => ({
            name: String(argument.name).slice(0, 200),
            ...(argument.description ? { description: String(argument.description).slice(0, 1_000) } : {}),
            ...(argument.required !== undefined ? { required: argument.required === true } : {})
          }))
        });
        if (prompts.length > MAX_MCP_ITEMS) throw new Error("MCP server exposes more than 500 prompts; refusing to list them.");
      }
      cursor = result.nextCursor;
      if (!cursor) return prompts;
      if (page === MAX_PROMPT_PAGES - 1) throw new Error("MCP prompt listing exceeded the pagination limit.");
    }
    return prompts;
  }

  async getPrompt(serverName: string, name: string, args: Record<string, string> = {}): Promise<Array<{ role: string; text: string }>> {
    const server = this.requireConnectedServer(serverName);
    if (typeof name !== "string" || !name.trim() || name.length > 500) throw new Error("MCP prompt name is invalid.");
    if (!isRecord(args) || Object.keys(args).length > 50 ||
        Object.entries(args).some(([key, value]) => !key || key.length > 200 || typeof value !== "string" || value.length > 4_000)) {
      throw new Error("MCP prompt arguments must be at most 50 string values (4000 characters each).");
    }
    const serialized = JSON.stringify(args);
    if (serialized.length > 20_000) throw new Error("MCP prompt arguments exceed 20000 characters.");
    const result = await server.client.getPrompt({ name, arguments: args });
    let remaining = MAX_RESOURCE_TEXT;
    return (result.messages ?? []).slice(0, 20).map((message) => {
      const content = message.content;
      let text = "";
      if (content && typeof content === "object" && "text" in content && typeof content.text === "string") text = content.text;
      else text = "[Non-text prompt content omitted.]";
      const bounded = text.slice(0, remaining);
      remaining -= bounded.length;
      return { role: String(message.role).slice(0, 40), text: bounded };
    });
  }

  /** Refreshes discovered schemas after an MCP tool-list-change notification. */
  private async refreshToolSchemas(serverName: string, client: Client): Promise<void> {
    this.toolRefreshRequested.add(serverName);
    const existing = this.refreshingTools.get(serverName);
    if (existing) return existing;

    const refresh = (async () => {
      while (this.toolRefreshRequested.delete(serverName)) {
        const server = this.connected.get(serverName);
        if (!server || server.client !== client) return;
        const tools: McpToolSummary[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
          const result = await client.listTools(cursor ? { cursor } : undefined);
          for (const tool of result.tools) {
            if (typeof tool.name !== "string" || !tool.name || tool.name.length > 200) {
              throw new Error("MCP server returned a tool name that is empty or longer than 200 characters.");
            }
            tools.push({
              name: tool.name,
              description: (tool.description ?? "").slice(0, 4_000),
              inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} }
            });
            if (tools.length > MAX_MCP_ITEMS) throw new Error("MCP server exposes more than 500 tools; refusing to register them.");
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
        const current = this.connected.get(serverName);
        if (!current || current.client !== client) return;
        current.tools = tools;
        this.clearConnectionError(serverName);
      }
    })();
    this.refreshingTools.set(serverName, refresh);
    try {
      await refresh;
    } finally {
      if (this.refreshingTools.get(serverName) === refresh) this.refreshingTools.delete(serverName);
      this.toolRefreshRequested.delete(serverName);
    }
  }


  private requireConnectedServer(serverName: string): ConnectedServer {
    const server = this.connected.get(serverName);
    if (!server) throw new Error(`MCP server "${serverName}" is not connected.`);
    return server;
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
            if (isRecord(input) && input.__invalidJson === true) return "model returned malformed JSON tool arguments";
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
    ? result.content.slice(0, 20).map((item) => {
      if (!isRecord(item)) return item;
      if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text.slice(0, 8_000) };
      if (item.type === "image") return { type: "image", mimeType: item.mimeType, note: "Image content omitted from text context." };
      return item;
    })
    : [];
  let structuredContent: unknown;
  if (result.structuredContent !== undefined) {
    try {
      const serialized = JSON.stringify(result.structuredContent);
      structuredContent = serialized && serialized.length > 20_000
        ? { note: "Structured MCP result omitted because it exceeded 20000 characters." }
        : result.structuredContent;
    } catch {
      structuredContent = { note: "Structured MCP result could not be serialized." };
    }
  }
  return { isError: result.isError === true, content, structuredContent };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
