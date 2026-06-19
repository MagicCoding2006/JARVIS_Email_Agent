import { createLogger } from "../lib/logger.js";
import { strategist } from "../llm/roles.js";
import { monthlyTotals } from "../services/analytics.service.js";
import { notify } from "../services/notifications.service.js";

const log = createLogger("monthly-review");

interface MonthlyOutput {
  worked: string[];
  failed: string[];
  stop: string[];
  scale: string[];
}

const SYSTEM = `You are a senior outbound strategist doing a MONTHLY review.
Given the month's totals, summarize what worked, what failed, what to stop, and what to scale.
Return ONLY JSON: {"worked":["..."],"failed":["..."],"stop":["..."],"scale":["..."]}`;

export async function runMonthlyReview(): Promise<void> {
  const totals = await monthlyTotals(30);

  let out: MonthlyOutput | undefined;
  if (strategist.configured) {
    try {
      out = await strategist.completeJSON<MonthlyOutput>(
        `Monthly totals:\n${JSON.stringify(totals, null, 2)}\n\nRespond in the required JSON shape.`,
        { system: SYSTEM, temperature: 0.5, maxTokens: 1500 },
      );
    } catch (err) {
      log.error("monthly strategist failed", err);
    }
  }

  const digest = [
    "🗓️ Monthly review (30d)",
    `Emails: ${totals.sent}   Replies: ${totals.replies} (positive ${totals.positiveReplies})`,
    `Meetings: ${totals.meetings}   Won: ${totals.closedWon}   Lost: ${totals.closedLost}   Revenue: $${totals.revenue}`,
    out?.worked?.length ? `\n✅ Worked:\n- ${out.worked.join("\n- ")}` : "",
    out?.failed?.length ? `\n❌ Failed:\n- ${out.failed.join("\n- ")}` : "",
    out?.stop?.length ? `\n🛑 Stop:\n- ${out.stop.join("\n- ")}` : "",
    out?.scale?.length ? `\n🚀 Scale:\n- ${out.scale.join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await notify({ kind: "monthly_review", level: "important", title: "Monthly review", body: digest });
  log.info("monthly review complete");
}
