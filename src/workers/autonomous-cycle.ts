import { createLogger } from "../lib/logger.js";
import { AGENT_SYSTEM, runAgent } from "../agent/agent.js";
import { notify } from "../services/notifications.service.js";
import type OpenAI from "openai";

const log = createLogger("autonomous-cycle");

const DIRECTIVE = `Run your daily operating cycle now:
1. Review the last 24h metrics and the 7-day breakdowns by industry and campaign.
2. For each ACTIVE campaign: check the variant leaderboard, prune clear losers, and generate fresh variants for weak/under-tested steps.
3. Identify the best and worst segments. If something is clearly working, propose scaling it; if a new offer/segment is worth testing, PROPOSE it (high-risk actions will be queued for my approval — do not assume they ran).
4. Finish with a short summary: what you did automatically, and what is awaiting my approval.`;

/**
 * The agent-driven daily cycle. This is the "GLM runs the funnel" loop: the
 * strategist reviews performance and acts via tools (low-risk auto, high-risk
 * queued for approval). Runs ≤ once/day to control token spend.
 */
export async function runAutonomousCycle(): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: DIRECTIVE },
  ];
  const result = await runAgent(messages, "autonomous");
  log.info("autonomous cycle complete");
  await notify({ kind: "autonomous_cycle", level: "important", title: "🧠 Autonomous cycle", body: result });
  return result;
}
