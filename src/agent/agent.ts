import type OpenAI from "openai";
import { config } from "../config/index.js";
import { strategist } from "../llm/roles.js";
import { createLogger } from "../lib/logger.js";
import { allTools, getTool } from "./tools/index.js";
import { toOpenAITool, type ToolContext } from "./tools/types.js";
import { needsApproval } from "./autonomy.js";
import { requestApproval } from "./approvals.js";

const log = createLogger("agent");

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

export const AGENT_SYSTEM = `You are the autonomous SDR/BDR operator ("the brain") for a cold-email sales system.
You run the funnel: leads, campaigns, multi-touch sequences, A/B experiments, lead research, and optimization.
Division of labor: YOU (the strategist) make decisions and call tools; a separate WRITER model (GPT) writes the actual emails. You NEVER write prospect-facing email copy yourself — you delegate all writing to GPT. Keep your own chatter minimal to control cost.

How emails get written:
- By default GPT writes each email in full from the step's angle + thread context (it always has the prior email on follow-ups).
- You can also give a step a HYBRID TEMPLATE: fixed copy with slots GPT fills per prospect — {{firstName|there}} merge fields, {{ai: instruction}} (GPT-written fragment), {{research: task}} (web-research fragment). Use templates when you want structural control or to test a templated style vs fully-AI.
- To author a template, call draft_step_template (GPT writes it from your guidance) → review → set_step_template to apply it (high-risk; changes live copy). Pass an empty bodyTemplate to revert a step to fully-AI. Do not hand-write template copy yourself — always author via draft_step_template so GPT does the writing.

Operating rules:
- NEVER fabricate numbers. Call get_metrics / get_breakdowns / list_variants etc. to get real data before concluding.
- Current autonomy is "${config.agent.autonomy}". When a tool returns {status:"pending_approval"}, it has NOT run — tell the user it's awaiting their approval and stop assuming it happened.
- Prefer cheap, reversible experiments. When performance is weak, generate/prune variants, research leads, test templates, and propose new offers/segments.
- Be concise and concrete in your final replies. Lead with the decision/finding, then 1-2 supporting facts.`;

function safeParseArgs(s: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

/**
 * Core agent loop: the strategist model reasons with tools until it produces a
 * final text answer or hits the step cap. High-risk tool calls are intercepted
 * and queued for human approval instead of executing.
 */
export async function runAgent(messages: Msg[], source: ToolContext["source"], approvalChatId?: string): Promise<string> {
  if (!strategist.configured) {
    return "Strategist LLM not configured — set STRATEGIST_API_KEY (GLM) to enable the agent.";
  }
  const tools = allTools().map(toOpenAITool);

  for (let step = 0; step < config.agent.maxSteps; step++) {
    const assistant = await strategist.chatWithTools(messages, tools);
    messages.push(assistant as Msg);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return assistant.content ?? "(no response)";
    }

    for (const call of calls) {
      if (call.type !== "function") continue;
      const tool = getTool(call.function.name);
      let result: unknown;

      if (!tool) {
        result = { error: `unknown tool ${call.function.name}` };
      } else {
        const args = safeParseArgs(call.function.arguments);
        if (needsApproval(tool.risk)) {
          const summary = `${tool.name} ${call.function.arguments ?? "{}"}`;
          const a = await requestApproval(tool.name, args, summary, approvalChatId);
          result = {
            status: "pending_approval",
            approvalId: a._id,
            message: "Queued for human approval. It has NOT run yet.",
          };
        } else {
          try {
            result = await tool.run(args, { source });
            log.info(`ran tool ${tool.name}`);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }
  return "Reached the step limit. Some actions may be pending your approval.";
}

// ── Chat sessions (in-memory rolling history, isolated by chat/session id) ───
const histories = new Map<string, Msg[]>();

function getHistory(sessionId: string): Msg[] {
  const existing = histories.get(sessionId);
  if (existing) return existing;
  const fresh: Msg[] = [{ role: "system", content: AGENT_SYSTEM }];
  histories.set(sessionId, fresh);
  return fresh;
}

export async function handleChat(text: string, sessionId = "default", approvalChatId?: string): Promise<string> {
  let history = getHistory(sessionId);
  history.push({ role: "user", content: text });
  const reply = await runAgent(history, "chat", approvalChatId);
  // Trim to keep the system message + the last ~24 turns.
  if (history.length > 26) {
    history = [history[0], ...history.slice(-24)];
    histories.set(sessionId, history);
  }
  return reply;
}

export function resetChat(sessionId = "default"): void {
  histories.set(sessionId, [{ role: "system", content: AGENT_SYSTEM }]);
}
