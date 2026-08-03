import { createLogger } from "../lib/logger.js";
import { AGENT_SYSTEM, runAgent } from "../agent/agent.js";
import { notify } from "../services/notifications.service.js";
import { PlaybookRepo } from "../repositories/index.js";
import type OpenAI from "openai";

const log = createLogger("autonomous-cycle");

const DIRECTIVE = `Run the daily growth operating cycle. Use real evidence and take bounded action instead of only writing recommendations.

1. MEMORY + EVIDENCE: read the playbook, then review 24h metrics, 7-day campaign/industry breakdowns, hypotheses, variants, meetings, and pipeline inventory. Opens are directional; optimize for positive replies, held meetings, and closed-won events. Do not declare winners without a meaningful sample.
2. MARKET RESEARCH: when an offer or segment is weak or uncertain, use web_search for current pains, alternatives, competitor positioning, and prospect language. Save only sourced, relevant findings; never invent market facts.
3. OFFER LOOP: score each active offer on dream outcome, perceived likelihood, time-to-result, and customer effort. Pick the weakest lever. Propose exactly one measurable offer-component change at a time (deliverable, bonus, guarantee, honest urgency, name, or price structure), with a hypothesis, target segment, success metric, minimum sample, and stop condition. Use change_offer only when evidence justifies a live test; it may require approval. Never fabricate proof or scarcity.
4. EMAIL CONTENT LOOP: evaluate existing hypotheses first. For each active campaign, inspect the variant leaderboard, prune only statistically credible losers, and generate variants for weak or under-tested steps. Test one variable per experiment: subject, hook, value mechanism, CTA, length, personalization depth, or video-preview framing. Use draft_step_template and set_step_template only for a deliberate structural test; the writer model authors prospect-facing copy.
5. FUNNEL LOOP: compare send -> reply -> meeting -> show -> close. If clicks are healthy but bookings are weak, inspect the landing page and propose one focused page experiment. If meetings book but do not show, diagnose reminders/qualification before changing email copy.
6. SCALE LOOP: keep strong active campaigns supplied. Auto-enroll within the daily budget and use free discovery when runway is below about 14 days. Adjust send pace only inside hard caps: scale on clean delivery plus positive downstream signal; reduce pace on bounce, unsubscribe, or reply-quality deterioration.
7. LEARNING LOOP: record durable conclusions and rejected ideas in the playbook, including the evidence and date. If a missing tool blocks a measured experiment, file a precise tool request. When scheduled code access is enabled, you may inspect the code and prepare a small approval-gated PR, but never merge or deploy it.
8. Finish with: decisions made, actions completed, experiments now running, approvals pending, and the next evidence threshold that will trigger another change.`;

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
