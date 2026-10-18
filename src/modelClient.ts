export type ModelProvider = "openai" | "openai-compatible";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelConfig {
  provider: ModelProvider;
  modelId: string;
  baseUrl: string;
  requestTimeoutMs: number;
}

export interface StreamChatOptions {
  config: ModelConfig;
  apiKey?: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: unknown };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

export function getCompletionEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("Model endpoint URL is empty. Set aiChatbox.baseUrl in settings.");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Model endpoint URL is invalid. Use an absolute HTTP or HTTPS URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Model endpoint must use HTTP or HTTPS.");
  }

  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

export async function streamChatCompletion(options: StreamChatOptions): Promise<void> {
  const { config, apiKey, messages, signal, onDelta } = options;
  if (!config.modelId.trim()) {
    throw new Error("Model ID is empty. Set aiChatbox.modelId in settings.");
  }
  if (config.provider === "openai" && !apiKey) {
    throw new Error("OpenAI API key is missing. Run “AI Chatbox: Set OpenAI API Key”.");
  }

  const endpoint = getCompletionEndpoint(
    config.provider === "openai" ? "https://api.openai.com/v1" : config.baseUrl
  );
  const controller = new AbortController();
  let timedOut = false;
  const configuredTimeout = Number.isFinite(config.requestTimeoutMs)
    ? config.requestTimeoutMs
    : 120_000;
  const timeoutMs = Math.max(1_000, Math.min(configuredTimeout, 300_000));
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort();
  signal.addEventListener("abort", abortFromCaller, { once: true });
  if (signal.aborted) controller.abort();

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.modelId,
        messages,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 2_000);
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        detail = parsed.error?.message ?? body;
      } catch {
        // The server may return plain text or HTML; keep a bounded excerpt.
      }
      throw new Error(`Model request failed (${response.status}): ${detail || response.statusText}`);
    }

    if (!response.body) {
      throw new Error("Model endpoint returned an empty response stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          finished = true;
          break;
        }

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(payload) as ChatCompletionChunk;
        } catch {
          throw new Error("Model endpoint sent an invalid streaming response.");
        }

        if (chunk.error?.message) {
          throw new Error(chunk.error.message);
        }

        const content = chunk.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          onDelta(content);
        }
      }

      if (done) finished = true;
    }

    // Some compatible servers omit the final [DONE] event.
    const trailing = buffer.trim();
    if (trailing.startsWith("data:") && trailing.slice(5).trim() !== "[DONE]") {
      const payload = trailing.slice(5).trim();
      try {
        const chunk = JSON.parse(payload) as ChatCompletionChunk;
        const content = chunk.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content) onDelta(content);
      } catch {
        throw new Error("Model endpoint sent an invalid final streaming event.");
      }
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(`Model request timed out after ${timeoutMs} ms.`);
    }
    if (signal.aborted) {
      throw new Error("Request cancelled.");
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Model request was interrupted.");
    }
    throw error instanceof Error ? error : new Error("Unknown model request failure.");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}
