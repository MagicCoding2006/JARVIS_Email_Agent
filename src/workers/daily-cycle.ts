import { createLogger } from "../lib/logger.js";
import { strategist } from "../llm/roles.js";
import { CampaignsRepo, HypothesesRepo } from "../repositories/index.js";
import { buildDailyMetrics, renderMetricsText, type DailyMetrics } from "../services/reporting.service.js";
import { notify } from "../services/notifications.service.js";
import { generateVariants } from "../services/variants.service.js";
import { summarizePriorExperiments } from "../services/experiments.service.js";

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
      const priorResults = await summarizePriorExperiments();
      review = await strategist.completeJSON<StrategistReview>(
        `Here is today's performance data:\n${JSON.stringify(metrics, null, 2)}\n\n` +
          (priorResults ? `${priorResults}\n\n` : "") +
          `Analyze it and respond in the required JSON shape.`,
        { system: STRATEGIST_SYSTEM, temperature: 0.5, maxTokens: 1500 },
      );
      log.info(`strategist proposed ${review.hypotheses?.length ?? 0} hypotheses`);

      // Close the loop: persist each hypothesis, spawn variants LINKED to it, and
      // flip it to "testing". The bandit tests the arms; evaluateHypotheses()
      // (weekly) later measures the outcome and marks it keep/reject.
      await applyHypothesesAndVariants(review);
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

/**
 * Persist hypotheses and, for the top ones, spawn opening-step variants LINKED
 * to each hypothesis on every active campaign, then mark it "testing". Linking
 * is what lets evaluateHypotheses() later attribute results back to the idea.
 */
async function applyHypothesesAndVariants(review: StrategistReview): Promise<void> {
  const campaigns = await CampaignsRepo.listActive();
  const all = review.hypotheses ?? [];
  // Cap how many we actively test per day (cost + volume control); the rest are
  // still recorded as "proposed" so nothing is lost.
  const toTest = all.slice(0, 2);

  for (const h of toTest) {
    const hyp = await HypothesesRepo.create(h.idea, h.reason);
    let tested = false;
    for (const campaign of campaigns) {
      const created = await generateVariants({
        campaign,
        step: 1,
        count: 1,
        hypotheses: [h.idea],
        hypothesisId: hyp._id,
      });
      if (created.length) tested = true;
    }
    if (tested) await HypothesesRepo.setStatus(hyp._id, "testing");
  }

  for (const h of all.slice(2)) {
    await HypothesesRepo.create(h.idea, h.reason);
  }
}
