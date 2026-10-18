import type {
  AgentMessage,
  AgentModelAdapter,
  AgentModelRequest,
  AgentModelTurn
} from "./agentRuntime";
import { getCompletionEndpoint, ModelConfig } from "./modelClient";

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
  }>;
  error?: { message?: string };
}

function providerMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content
      };
    }
    if (message.role === "assistant" && "toolCalls" in message) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
      };
    }
    return { role: message.role, content: message.content };
  });
}

/** Small OpenAI Chat Completions adapter for the provider-independent AgentRuntime. */
export function createAgentModelAdapter(options: {
  config: ModelConfig;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): AgentModelAdapter {
  return {
    async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
      const { config, apiKey } = options;
      if (!config.modelId.trim()) throw new Error("Model ID is empty. Set aiChatbox.modelId in settings.");
      if (config.provider === "openai" && !apiKey) {
        throw new Error("OpenAI API key is missing. Run “AI Chatbox: Set OpenAI API Key”.");
      }
      if (request.signal.aborted) throw new Error("Request cancelled.");

      const timeoutMs = Math.max(1_000, Math.min(
        Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 120_000,
        300_000
      ));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        const body: Record<string, unknown> = {
          model: config.modelId,
          messages: providerMessages(request.messages),
          stream: false
        };
        if (request.tools.length) {
          body.tools = request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true }
            }
          }));
          body.tool_choice = "auto";
        }
        const endpoint = getCompletionEndpoint(
          config.provider === "openai" ? "https://api.openai.com/v1" : config.baseUrl
        );
        const response = await (options.fetchImpl ?? fetch)(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 2_000);
          let message = detail;
          try {
            message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail;
          } catch { /* use bounded response body */ }
          throw new Error(`Model request failed (${response.status}): ${message || response.statusText}`);
        }
        let payload: CompletionResponse;
        try {
          payload = await response.json() as CompletionResponse;
        } catch {
          throw new Error("Model endpoint returned invalid JSON.");
        }
        if (payload.error?.message) throw new Error(payload.error.message);
        const message = payload.choices?.[0]?.message;
        if (!message) throw new Error("Model endpoint returned no assistant message.");
        const content = typeof message.content === "string" ? message.content : "";
        const calls = message.tool_calls ?? [];
        if (!calls.length) return { type: "final", content };
        return {
          type: "toolCalls",
          content,
          toolCalls: calls.map((call, index) => {
            const raw = call.function?.arguments;
            let args: unknown = {};
            if (typeof raw === "string") {
              try { args = JSON.parse(raw); }
              catch { args = { __invalidJson: true, raw: raw.slice(0, 2_000) }; }
            } else if (raw !== undefined) args = raw;
            return {
              id: typeof call.id === "string" ? call.id.slice(0, 200) : `call-${index}`,
              name: typeof call.function?.name === "string" ? call.function.name : "",
              arguments: args
            };
          })
        };
      } catch (error) {
        if (request.signal.aborted) throw new Error("Request cancelled.");
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Model request timed out or was interrupted (limit ${timeoutMs} ms).`);
        }
        throw error instanceof Error ? error : new Error("Unknown model request failure.");
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);
      }
    }
  };
}
