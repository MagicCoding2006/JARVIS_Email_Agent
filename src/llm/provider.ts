import OpenAI from "openai";
import { createOpenAIOptions } from "@openai-oauth/openai-client";
import { openaiCredentials } from "@openai-oauth/local";
import { createLogger } from "../lib/logger.js";

export interface LLMRoleConfig {
  auth: "api-key" | "openai-oauth" | "openai-oauth-proxy";
  baseURL: string;
  apiKey: string;
  model: string;
  oauthFile?: string;
}

export interface CompleteOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 10_000;

/**
 * Reasoning-family models (gpt-5*, o1/o3/o4) accept ONLY the default
 * temperature — passing any value is a hard 400 ("Unsupported value:
 * 'temperature' does not support 0.7 with this model"). This holds whichever
 * way we authenticate, so the check is on the model name alone.
 */
const DEFAULT_TEMPERATURE_ONLY = /^(gpt-5|o1|o3|o4)([.\-]|$)/i;

/** True when the provider rejected the request specifically over `temperature`. */
function isUnsupportedTemperatureError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /temperature/i.test(msg) && /unsupported|not support|only the default|unrecognized/i.test(msg);
}

/**
 * A thin, provider-agnostic wrapper over any OpenAI-compatible chat endpoint.
 * Works for OpenAI (GPT) and GLM/Zhipu (which exposes an OpenAI-compatible API)
 * by simply pointing baseURL/apiKey/model at the right place.
 */
export class LLMClient {
  private client: OpenAI;
  private baseURL: string;
  private model: string;
  private label: string;
  private auth: LLMRoleConfig["auth"];
  private log: ReturnType<typeof createLogger>;
  /** Latched once the provider tells us this model refuses custom temperatures. */
  private temperatureRejected = false;

  constructor(label: string, cfg: LLMRoleConfig) {
    this.label = label;
    this.auth = cfg.auth;
    this.baseURL = cfg.auth === "openai-oauth" ? "openai-oauth" : cfg.baseURL;
    this.model = cfg.model;
    this.client =
      cfg.auth === "openai-oauth"
        ? new OpenAI(
            createOpenAIOptions(openaiCredentials({ authFilePath: cfg.oauthFile || undefined })) as unknown as ConstructorParameters<
              typeof OpenAI
            >[0],
          )
        : new OpenAI({
            baseURL: cfg.baseURL,
            apiKey: cfg.auth === "openai-oauth-proxy" ? "openai-oauth" : cfg.apiKey || "missing-key",
          });
    this.log = createLogger(`llm:${label}`);
  }

  get configured(): boolean {
    if (this.auth === "openai-oauth" || this.auth === "openai-oauth-proxy") return true;
    return Boolean(this.client.apiKey && this.client.apiKey !== "missing-key");
  }

  /** Plain text completion. */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });

    const res = await this.create({
      model: this.model,
      messages,
      ...this.temperatureParam(opts.temperature ?? 0.7),
      ...this.maxTokenParam(opts.maxTokens ?? DEFAULT_MAX_TOKENS),
    });
    this.logUsage("complete", res.usage);
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
    const res = await this.create({
      model: this.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      ...this.temperatureParam(opts.temperature ?? 0.4),
      ...this.maxTokenParam(opts.maxTokens ?? DEFAULT_MAX_TOKENS),
    });
    this.logUsage("chatWithTools", res.usage);
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

    const res = await this.create({
      model: this.model,
      messages,
      ...this.temperatureParam(opts.temperature ?? 0.4),
      ...this.maxTokenParam(opts.maxTokens ?? DEFAULT_MAX_TOKENS),
      response_format: { type: "json_object" },
    });
    this.logUsage("completeJSON", res.usage);
    const raw = res.choices[0]?.message?.content ?? "";
    return parseJSONLoose<T>(raw);
  }

  /**
   * Single entry point to the chat endpoint. If a provider rejects the request
   * over `temperature` — a model we haven't classified that only takes the
   * default — drop the parameter, latch that for the rest of the process, and
   * retry once instead of failing the caller.
   */
  private async create(params: Record<string, unknown>): Promise<OpenAI.Chat.ChatCompletion> {
    const body = { ...params };
    if (this.temperatureRejected) delete body.temperature;
    const send = () =>
      this.client.chat.completions.create(
        body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      ) as Promise<OpenAI.Chat.ChatCompletion>;
    try {
      return await send();
    } catch (err) {
      if (!("temperature" in body) || !isUnsupportedTemperatureError(err)) throw err;
      this.temperatureRejected = true;
      this.log.warn(`${this.model} rejects custom temperature — retrying with the default`);
      delete body.temperature;
      return send();
    }
  }

  private maxTokenParam(maxTokens: number): { max_tokens: number } | { max_completion_tokens: number } {
    if (this.usesOpenAINewTokenParam()) return { max_completion_tokens: maxTokens };
    return { max_tokens: maxTokens };
  }

  private temperatureParam(temperature: number): { temperature: number } | Record<string, never> {
    if (!this.supportsCustomTemperature()) return {};
    return { temperature };
  }

  /** Exposed for the smoke test: does this model take a custom temperature? */
  supportsCustomTemperature(): boolean {
    return !this.temperatureRejected && !DEFAULT_TEMPERATURE_ONLY.test(this.model);
  }

  private usesOpenAINewTokenParam(): boolean {
    return this.baseURL.includes("api.openai.com") || /^(gpt-5|o\d|o-|chatgpt-)/i.test(this.model);
  }

  private logUsage(method: string, usage: OpenAI.Completions.CompletionUsage | undefined): void {
    if (!usage) {
      this.log.debug(`${method} token usage unavailable`, { model: this.model });
      return;
    }
    this.log.info(`${method} token usage`, {
      model: this.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    });
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
