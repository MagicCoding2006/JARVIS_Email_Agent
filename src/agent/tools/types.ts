import type OpenAI from "openai";

export type Risk = "low" | "high";

export interface ToolContext {
  source: "chat" | "autonomous" | "approval";
}

export interface Tool {
  name: string;
  description: string;
  /** "high" risk actions require approval under semi/propose autonomy. */
  risk: Risk;
  /** JSON Schema for the function parameters (OpenAI tool format). */
  parameters: Record<string, unknown>;
  run(args: any, ctx: ToolContext): Promise<unknown>;
}

export function toOpenAITool(t: Tool): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  };
}

/** Tiny helper to build a JSON-schema object for params. */
export function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
