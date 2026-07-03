import { createLogger } from "../lib/logger.js";
import { AGENT_SYSTEM, runAgent } from "../agent/agent.js";
import { notify } from "../services/notifications.service.js";
import { PlaybookRepo } from "../repositories/index.js";
import type OpenAI from "openai";

const log = createLogger("autonomous-cycle");

const DIRECTIVE = `Run your daily operating cycle now:
1. Review the last 24h metrics and the 7-day breakdowns by industry and campaign.
2. KEEP THE MACHINE FED: check get_pipeline_inventory. If active campaigns have capacity and unenrolled leads exist, auto_enroll (prefer the best-performing campaign). If the lead tank is low (< ~14 days of runway), run discover_leads targeting the segments that perform best.
3. For each ACTIVE campaign: check the variant leaderboard, prune clear losers, and generate fresh variants for weak/under-tested steps.
4. Identify the best and worst segments. If something is clearly working, propose scaling it; if a new offer/segment is worth testing, PROPOSE it (high-risk actions will be queued for my approval — do not assume they ran).
5. Check get_meetings: how many held vs no-show this week? If clicks are healthy but bookings are weak, inspect the landing page (read_site_file) and consider a propose_site_change experiment.
6. Check get_send_pace and reply/bounce quality. If sends are clean and engagement is healthy, consider raising pace with set_send_pace; if quality is degrading, pull back. Always give a reason.
7. If you reached a durable conclusion worth remembering, call add_playbook_note. If a missing tool blocked you, file it with propose_tool.
8. Finish with a short summary: what you did automatically, and what is awaiting my approval.`;

/**
 * The agent-driven daily cycle. This is the "GLM runs the funnel" loop: the
 * strategist reviews performance and acts via tools (low-risk auto, high-risk
 * queued for approval). Runs ≤ once/day to control token spend.
 */
export async function runAutonomousCycle(): Promise<string> {
  const notes = await PlaybookRepo.list(20);
  const playbook = notes.length
    ? `Your playbook (past conclusions, newest first):\n${notes.map((n) => `- ${n.text}`).join("\n")}`
    : "Your playbook is empty — no past conclusions recorded yet.";

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: playbook },
    { role: "user", content: DIRECTIVE },
  ];
  const result = await runAgent(messages, "autonomous");
  log.info("autonomous cycle complete");
  await notify({ kind: "autonomous_cycle", level: "important", title: "🧠 Autonomous cycle", body: result });
  return result;
}
