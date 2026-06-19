import OpenAI from "openai";
import { createLogger } from "../lib/logger.js";

export interface LLMRoleConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface CompleteOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * A thin, provider-agnostic wrapper over any OpenAI-compatible chat endpoint.
 * Works for OpenAI (GPT) and GLM/Zhipu (which exposes an OpenAI-compatible API)
 * by simply pointing baseURL/apiKey/model at the right place.
 */
export class LLMClient {
  private client: OpenAI;
  private model: string;
  private label: string;
  private log: ReturnType<typeof createLogger>;

  constructor(label: string, cfg: LLMRoleConfig) {
    this.label = label;
    this.model = cfg.model;
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey || "missing-key" });
    this.log = createLogger(`llm:${label}`);
  }

  get configured(): boolean {
    return Boolean(this.client.apiKey && this.client.apiKey !== "missing-key");
  }

  /** Plain text completion. */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });

    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1200,
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  }

  /**
   * Tool-calling turn. Sends the conversation + available tools and returns the
   * raw assistant message (which may contain `tool_calls`). The agent loop owns
   * the message array and executes any tool calls. Used by the strategist brain.
   */
  async chatWithTools(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    tools: OpenAI.Chat.ChatCompletionTool[],
    opts: { temperature?: number; maxTokens?: number } = {},
  ): Promise<OpenAI.Chat.ChatCompletionMessage> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1500,
    });
    return res.choices[0]?.message ?? { role: "assistant", content: "" };
  }

  /**
   * JSON completion. Asks the model for JSON and parses it defensively
   * (some providers ignore response_format, so we also extract the first
   * JSON object/array found in the text).
   */
  async completeJSON<T>(prompt: string, opts: CompleteOptions = {}): Promise<T> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });

    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1200,
      response_format: { type: "json_object" },
    });
    const raw = res.choices[0]?.message?.content ?? "";
    return parseJSONLoose<T>(raw);
  }
}

/** Extract and parse JSON even if the model wrapped it in prose or code fences. */
export function parseJSONLoose<T>(raw: string): T {
  const cleaned = raw.replace(/```json/gi, "```").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Find the first balanced { ... } or [ ... ] block.
    const match = cleaned.match(/[{[][\s\S]*[}\]]/);
    if (match) {
      return JSON.parse(match[0]) as T;
    }
    throw new Error(`Could not parse JSON from model output: ${raw.slice(0, 200)}`);
  }
}
