import { createLogger } from "../lib/logger.js";
import { strategist } from "../llm/roles.js";
import { CampaignsRepo } from "../repositories/index.js";
import {
  breakdownByLeadField,
  breakdownByCampaign,
  renderBreakdown,
} from "../services/analytics.service.js";
import { pruneVariants, variantLeaderboard } from "../services/variants.service.js";
import { evaluateHypotheses, summarizePriorExperiments } from "../services/experiments.service.js";
import { notify } from "../services/notifications.service.js";

const log = createLogger("weekly-review");

interface WeeklyOutput {
  bestIndustries: string[];
  worstIndustries: string[];
  bestOffer: string;
  worstOffer: string;
  bestCTA: string;
  worstCTA: string;
  recommendedTests: string[];
}

const SYSTEM = `You are a senior outbound strategist doing a WEEKLY review.
Given industry, campaign, and variant performance, identify what's working and what to cut.
Return ONLY JSON:
{"bestIndustries":["..."],"worstIndustries":["..."],"bestOffer":"...","worstOffer":"...","bestCTA":"...","worstCTA":"...","recommendedTests":["..."]}`;

export async function runWeeklyReview(): Promise<void> {
  const [industry, campaigns] = await Promise.all([
    breakdownByLeadField("industry", 7),
    breakdownByCampaign(7),
  ]);

  // Variant leaderboards across active campaigns + prune losers.
  const active = await CampaignsRepo.listActive();
  const leaderboards: Record<string, unknown> = {};
  let totalPruned = 0;
  for (const c of active) {
    leaderboards[c.name] = await variantLeaderboard(c._id);
    const { pruned } = await pruneVariants(c._id);
    totalPruned += pruned;
  }

  // Close the learning loop: judge this cycle's experiments (keep/reject).
  const verdicts = await evaluateHypotheses();
  const kept = verdicts.filter((v) => v.decision === "keep");
  const rejected = verdicts.filter((v) => v.decision === "reject");

  const data = { industry, campaigns, variantLeaderboards: leaderboards, experimentResults: verdicts };

  let out: WeeklyOutput | undefined;
  if (strategist.configured) {
    try {
      const priorResults = await summarizePriorExperiments();
      out = await strategist.completeJSON<WeeklyOutput>(
        `Weekly performance data:\n${JSON.stringify(data, null, 2)}\n\n` +
          (priorResults ? `${priorResults}\n\n` : "") +
          `Analyze and respond in the required JSON shape.`,
        { system: SYSTEM, temperature: 0.5, maxTokens: 1800 },
      );
    } catch (err) {
      log.error("weekly strategist failed", err);
    }
  }

  const experimentLines = [
    ...kept.map((v) => `  ✅ KEEP: ${v.idea} (${v.result})`),
    ...rejected.map((v) => `  ❌ REJECT: ${v.idea} (${v.result})`),
  ];

  const digest = [
    "📈 Weekly strategic review",
    renderBreakdown("By industry (7d):", industry),
    renderBreakdown("By campaign (7d):", campaigns),
    `Variants pruned this week: ${totalPruned}`,
    `Experiments decided: ${kept.length} kept, ${rejected.length} rejected`,
    experimentLines.length ? experimentLines.join("\n") : "",
    out ? `\nBest industries: ${out.bestIndustries?.join(", ")}` : "",
    out ? `Worst industries: ${out.worstIndustries?.join(", ")}` : "",
    out ? `Best offer: ${out.bestOffer}  |  Worst: ${out.worstOffer}` : "",
    out ? `Best CTA: ${out.bestCTA}  |  Worst: ${out.worstCTA}` : "",
    out?.recommendedTests?.length ? `\n🧪 Recommended tests:\n- ${out.recommendedTests.join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await notify({ kind: "weekly_review", level: "important", title: "Weekly review", body: digest });
  log.info("weekly review complete");
}
