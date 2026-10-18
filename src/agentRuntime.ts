export type ToolApprovalDecision = "allow" | "deny";

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** Return a validation message for invalid input, or undefined when valid. */
  validateInput: (input: unknown) => string | undefined;
  execute: (input: unknown, signal: AbortSignal) => Promise<unknown>;
}

export interface AgentToolSpec {
  name: string;
  description: string;
}

export type AgentMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface AgentModelRequest {
  messages: AgentMessage[];
  tools: AgentToolSpec[];
  signal: AbortSignal;
}

export type AgentModelTurn =
  | { type: "final"; content: string }
  | { type: "toolCalls"; content?: string; toolCalls: AgentToolCall[] };

export interface AgentModelAdapter {
  complete(request: AgentModelRequest): Promise<AgentModelTurn>;
}

export interface ToolPermissionRequest {
  tool: AgentToolDefinition;
  input: unknown;
  signal: AbortSignal;
}

export interface ToolPermissionService {
  requestPermission(request: ToolPermissionRequest): Promise<ToolApprovalDecision>;
}

export type AgentEvent =
  | { type: "thinking"; iteration: number }
  | { type: "assistantDelta"; text: string }
  | { type: "toolProposed"; toolCallId: string; name: string; input: unknown }
  | { type: "toolApprovalRequested"; toolCallId: string; name: string }
  | { type: "toolStarted"; toolCallId: string; name: string }
  | { type: "toolFinished"; toolCallId: string; name: string; output: string }
  | { type: "toolDenied"; toolCallId: string; name: string }
  | { type: "error"; message: string }
  | { type: "done"; reason: "completed" | "iteration-limit" | "cancelled" };

export interface AgentRuntimeOptions {
  model: AgentModelAdapter;
  tools: AgentToolDefinition[];
  permissions: ToolPermissionService;
  maxIterations?: number;
  maxToolResultChars?: number;
  maxHistoryMessages?: number;
}

export interface AgentRunRequest {
  messages: AgentMessage[];
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  messages: AgentMessage[];
  finalText: string;
  iterations: number;
  reason: "completed" | "iteration-limit" | "cancelled";
}

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;
const DEFAULT_MAX_HISTORY_MESSAGES = 40;
const MAX_TOOL_CALLS_PER_TURN = 8;

export class AgentRuntime {
  private readonly tools = new Map<string, AgentToolDefinition>();
  private readonly maxIterations: number;
  private readonly maxToolResultChars: number;
  private readonly maxHistoryMessages: number;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.maxIterations = boundedInteger(options.maxIterations, 1, 20, DEFAULT_MAX_ITERATIONS);
    this.maxToolResultChars = boundedInteger(
      options.maxToolResultChars,
      256,
      50_000,
      DEFAULT_MAX_TOOL_RESULT_CHARS
    );
    this.maxHistoryMessages = boundedInteger(
      options.maxHistoryMessages,
      2,
      200,
      DEFAULT_MAX_HISTORY_MESSAGES
    );

    for (const tool of options.tools) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(tool.name)) {
        throw new Error(`Invalid tool name: ${tool.name}`);
      }
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate tool registration: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const messages = request.messages.slice(-this.maxHistoryMessages);
    let iterations = 0;

    try {
      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        this.throwIfCancelled(request.signal);
        iterations = iteration;
        request.onEvent({ type: "thinking", iteration });

        const turn = await this.options.model.complete({
          messages: messages.slice(),
          tools: [...this.tools.values()].map(({ name, description }) => ({ name, description })),
          signal: request.signal
        });
        this.throwIfCancelled(request.signal);

        if (turn.type === "final") {
          const finalText = turn.content ?? "";
          messages.push({ role: "assistant", content: finalText });
          if (finalText) request.onEvent({ type: "assistantDelta", text: finalText });
          request.onEvent({ type: "done", reason: "completed" });
          return {
            messages: messages.slice(-this.maxHistoryMessages),
            finalText,
            iterations,
            reason: "completed"
          };
        }

        messages.push({
          role: "assistant",
          content: turn.content ?? "",
          toolCalls: turn.toolCalls
        });
        if (turn.content) request.onEvent({ type: "assistantDelta", text: turn.content });

        if (turn.toolCalls.length === 0) {
          const finalText = turn.content ?? "";
          request.onEvent({ type: "done", reason: "completed" });
          return {
            messages: messages.slice(-this.maxHistoryMessages),
            finalText,
            iterations,
            reason: "completed"
          };
        }

        for (const [callIndex, call] of turn.toolCalls.entries()) {
          this.throwIfCancelled(request.signal);
          if (callIndex >= MAX_TOOL_CALLS_PER_TURN) {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: "Tool call skipped: the per-turn tool-call limit was reached."
            });
            continue;
          }
          request.onEvent({
            type: "toolProposed",
            toolCallId: call.id,
            name: call.name,
            input: call.arguments
          });

          const tool = this.tools.get(call.name);
          if (!tool) {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: this.boundResult(`Unknown tool: ${call.name}`)
            });
            continue;
          }

          const validationError = tool.validateInput(call.arguments);
          if (validationError) {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: this.boundResult(`Invalid tool input: ${validationError}`)
            });
            continue;
          }

          request.onEvent({
            type: "toolApprovalRequested",
            toolCallId: call.id,
            name: call.name
          });
          const decision = await this.options.permissions.requestPermission({
            tool,
            input: call.arguments,
            signal: request.signal
          });
          this.throwIfCancelled(request.signal);

          if (decision !== "allow") {
            request.onEvent({
              type: "toolDenied",
              toolCallId: call.id,
              name: call.name
            });
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: "Tool execution denied by the user."
            });
            continue;
          }

          request.onEvent({ type: "toolStarted", toolCallId: call.id, name: call.name });
          try {
            const output = await tool.execute(call.arguments, request.signal);
            this.throwIfCancelled(request.signal);
            const boundedOutput = this.boundResult(serializeToolOutput(output));
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: boundedOutput
            });
            request.onEvent({
              type: "toolFinished",
              toolCallId: call.id,
              name: call.name,
              output: boundedOutput
            });
          } catch (error) {
            this.throwIfCancelled(request.signal);
            const detail = error instanceof Error ? error.message : "Unknown tool failure.";
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: this.boundResult(`Tool failed: ${detail}`)
            });
          }
        }

        // Keep only a bounded context between model turns. Preserve at least
        // the newest user request when possible, even if tool traffic is large.
        while (messages.length > this.maxHistoryMessages) {
          const removableIndex = messages.findIndex((message) => message.role !== "system");
          if (removableIndex < 0) break;
          messages.splice(removableIndex, 1);
        }
      }

      request.onEvent({ type: "done", reason: "iteration-limit" });
      return {
        messages: messages.slice(-this.maxHistoryMessages),
        finalText: "Stopped because the agent reached its iteration limit.",
        iterations,
        reason: "iteration-limit"
      };
    } catch (error) {
      if (request.signal.aborted) {
        request.onEvent({ type: "done", reason: "cancelled" });
        return {
          messages: messages.slice(-this.maxHistoryMessages),
          finalText: "",
          iterations,
          reason: "cancelled"
        };
      }

      const message = error instanceof Error ? error.message : "Unknown agent runtime failure.";
      request.onEvent({ type: "error", message });
      throw error;
    }
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Agent run cancelled.");
  }

  private boundResult(value: string): string {
    if (value.length <= this.maxToolResultChars) return value;
    return value.slice(0, this.maxToolResultChars) + "\n[tool output truncated]";
  }
}

/** A safe default: every tool request is denied unless an approval UI decides otherwise. */
export class CallbackPermissionService implements ToolPermissionService {
  constructor(
    private readonly decide: (request: ToolPermissionRequest) => Promise<ToolApprovalDecision>
  ) {}

  requestPermission(request: ToolPermissionRequest): Promise<ToolApprovalDecision> {
    return this.decide(request);
  }
}

export class DenyAllPermissionService implements ToolPermissionService {
  async requestPermission(): Promise<ToolApprovalDecision> {
    return "deny";
  }
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value), maximum));
}

function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return "[Tool returned a value that could not be serialized.]";
  }
}
