import { createLogger } from "../lib/logger.js";
import { strategist } from "../llm/roles.js";
import { CampaignsRepo, HypothesesRepo } from "../repositories/index.js";
import { buildDailyMetrics, renderMetricsText, type DailyMetrics } from "../services/reporting.service.js";
import { notify } from "../services/notifications.service.js";
import { generateVariants } from "../services/variants.service.js";

const log = createLogger("daily-cycle");

interface StrategistReview {
  observations: string[];
  hypotheses: { idea: string; reason: string }[];
  recommendations: string[];
  experiments: string[];
}

const STRATEGIST_SYSTEM = `You are a senior outbound strategist reviewing one day of cold-email performance.
Be concise, specific, and quantitative. Propose only experiments that are cheap to run and measurable.
Return ONLY JSON:
{"observations": ["..."], "hypotheses": [{"idea":"...","reason":"..."}], "recommendations": ["..."], "experiments": ["..."]}`;

/**
 * The daily optimization cycle (cost-controlled: the expensive strategist model
 * is called at most once per day). Generates a report, asks the strategist for
 * observations/hypotheses/experiments, persists hypotheses, and sends a digest.
 */
export async function runDailyCycle(): Promise<{ metrics: DailyMetrics; review?: StrategistReview }> {
  const metrics = await buildDailyMetrics(24);
  const reportText = renderMetricsText(metrics);
  log.info("daily report\n" + reportText);

  let review: StrategistReview | undefined;
  if (strategist.configured) {
    try {
      review = await strategist.completeJSON<StrategistReview>(
        `Here is today's performance data:\n${JSON.stringify(metrics, null, 2)}\n\n` +
          `Analyze it and respond in the required JSON shape.`,
        { system: STRATEGIST_SYSTEM, temperature: 0.5, maxTokens: 1500 },
      );
      for (const h of review.hypotheses ?? []) {
        await HypothesesRepo.create(h.idea, h.reason);
      }
      log.info(`strategist proposed ${review.hypotheses?.length ?? 0} hypotheses`);

      // Close the loop: the worker turns hypotheses into NEW testable variants
      // on each active campaign's opening step. The bandit takes it from there.
      await generateVariantsFromReview(review);
    } catch (err) {
      log.error("strategist review failed", err);
    }
  } else {
    log.warn("strategist LLM not configured — sending metrics-only digest");
  }

  const digest = [
    reportText,
    review?.observations?.length ? `\n🔎 Observations:\n- ${review.observations.join("\n- ")}` : "",
    review?.recommendations?.length ? `\n✅ Recommendations:\n- ${review.recommendations.join("\n- ")}` : "",
    review?.experiments?.length ? `\n🧪 Experiments to run:\n- ${review.experiments.join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await notify({
    kind: "daily_digest",
    level: "important",
    title: "Daily SDR digest",
    body: digest,
  });

  return { metrics, review };
}

/** For each active campaign, generate 2 new opening-step variants seeded by today's hypotheses. */
async function generateVariantsFromReview(review: StrategistReview): Promise<void> {
  const campaigns = await CampaignsRepo.listActive();
  const ideas = (review.hypotheses ?? []).map((h) => h.idea).slice(0, 3);
  for (const campaign of campaigns) {
    await generateVariants({ campaign, step: 1, count: 2, hypotheses: ideas });
  }
}
