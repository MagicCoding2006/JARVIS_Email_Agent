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
  /**
   * Optional per-call risk. Lets a tool that is high-risk when it writes drop to
   * low-risk for a read-only invocation (e.g. `dryRun: true`), so previewing a
   * destructive action doesn't need its own approval round-trip.
   */
  riskFor?(args: any): Risk;
  /** JSON Schema for the function parameters (OpenAI tool format). */
  parameters: Record<string, unknown>;
  run(args: any, ctx: ToolContext): Promise<unknown>;
}

/** The risk of one specific invocation — never lower than the tool's floor. */
export function riskOf(tool: Tool, args: unknown): Risk {
  return tool.riskFor?.(args) ?? tool.risk;
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
