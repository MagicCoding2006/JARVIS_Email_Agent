import { createLogger } from "../lib/logger.js";
import { HypothesesRepo, VariantsRepo } from "../repositories/index.js";
import { variantScore, replyRate } from "./variants.service.js";
import type { Hypothesis, Variant, VariantStats } from "../models/types.js";

const log = createLogger("experiments");

// A hypothesis needs this much data across its variants before we judge it, and
// must beat/lose to the baseline by this margin to be kept/rejected.
const MIN_SENT_TO_DECIDE = 40;
const KEEP_RATIO = 1.1; // >10% better blended score than baseline → KEEP
const REJECT_RATIO = 0.9; // >10% worse → REJECT; in between → keep testing

const ZERO: VariantStats = {
  sent: 0, opens: 0, clicks: 0, replies: 0, positiveReplies: 0, meetings: 0, closes: 0, revenue: 0,
};

function sumStats(variants: Variant[]): VariantStats {
  return variants.reduce<VariantStats>((acc, v) => {
    const s = v.stats;
    return {
      sent: acc.sent + s.sent,
      opens: acc.opens + s.opens,
      clicks: acc.clicks + s.clicks,
      replies: acc.replies + s.replies,
      positiveReplies: acc.positiveReplies + s.positiveReplies,
      meetings: acc.meetings + s.meetings,
      closes: acc.closes + s.closes,
      revenue: acc.revenue + s.revenue,
    };
  }, { ...ZERO });
}

const pct = (n: number) => Math.round(n * 1000) / 10;

export type ExperimentDecision = "keep" | "reject" | "inconclusive";

export interface HypothesisVerdict {
  id: string;
  idea: string;
  decision: ExperimentDecision;
  sent: number;
  replyRate: number;
  baselineReplyRate: number;
  /** % change in reply rate vs baseline (0 if no baseline). */
  lift: number;
  result: string;
}

/**
 * Measure every hypothesis currently in "testing" against its sibling variants
 * and decide KEEP / REJECT (or leave it testing if data is thin / inconclusive).
 * This is what turns recorded hypotheses into a learning signal — without it the
 * loop never closes. Safe to run on a schedule (weekly) or on demand.
 */
export async function evaluateHypotheses(): Promise<HypothesisVerdict[]> {
  const testing = await HypothesesRepo.listByStatus("testing");
  const verdicts: HypothesisVerdict[] = [];

  for (const h of testing) {
    const linked = await VariantsRepo.listForHypothesis(h._id);
    if (!linked.length) continue;

    const hypStats = sumStats(linked);
    if (hypStats.sent < MIN_SENT_TO_DECIDE) continue; // not enough data yet — keep testing

    // Baseline = sibling variants sharing the same (campaign, step) but NOT from
    // this hypothesis (i.e. base copy + other arms).
    const pairs = uniquePairs(linked);
    const siblings: Variant[] = [];
    for (const { campaignId, step } of pairs) {
      const all = await VariantsRepo.listForCampaignStep(campaignId, step, false);
      for (const v of all) if (v.hypothesisId !== h._id) siblings.push(v);
    }
    const baseStats = sumStats(siblings);

    const hypScore = variantScore(hypStats);
    const baseScore = variantScore(baseStats);
    const hRR = replyRate(hypStats);
    const bRR = replyRate(baseStats);
    const lift = bRR > 0 ? Math.round((hRR / bRR - 1) * 100) : 0;

    let decision: ExperimentDecision;
    if (siblings.length === 0 || baseStats.sent === 0) {
      decision = "inconclusive"; // nothing to compare against yet
    } else {
      const ratio = baseScore > 0 ? hypScore / baseScore : hypScore > 0 ? Infinity : 1;
      decision = ratio >= KEEP_RATIO ? "keep" : ratio <= REJECT_RATIO ? "reject" : "inconclusive";
    }

    const result =
      siblings.length === 0
        ? `${pct(hRR)}% reply over ${hypStats.sent} sends (no baseline to compare)`
        : `${pct(hRR)}% reply vs ${pct(bRR)}% baseline over ${hypStats.sent} sends (${lift >= 0 ? "+" : ""}${lift}%)`;

    if (decision !== "inconclusive") {
      await HypothesesRepo.setStatus(h._id, decision, result, "replyRate");
      log.info(`hypothesis "${h.idea}" → ${decision.toUpperCase()} (${result})`);
    }

    verdicts.push({
      id: h._id,
      idea: h.idea,
      decision,
      sent: hypStats.sent,
      replyRate: pct(hRR),
      baselineReplyRate: pct(bRR),
      lift,
      result,
    });
  }

  return verdicts;
}

function uniquePairs(variants: Variant[]): { campaignId: string; step: number }[] {
  const seen = new Set<string>();
  const out: { campaignId: string; step: number }[] = [];
  for (const v of variants) {
    const key = `${v.campaignId}:${v.step}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ campaignId: v.campaignId, step: v.step });
    }
  }
  return out;
}

/**
 * A compact summary of decided experiments to feed back into the strategist's
 * prompt — so it stops re-proposing losers and builds on winners. This is the
 * compounding asset (master plan §12). Empty string when there's nothing yet.
 */
export async function summarizePriorExperiments(limit = 8): Promise<string> {
  const decided = await HypothesesRepo.recentDecided(limit);
  if (!decided.length) return "";
  const lines = decided.map(
    (h: Hypothesis) => `- [${h.status.toUpperCase()}] ${h.idea}${h.result ? ` (${h.result})` : ""}`,
  );
  return `Prior experiment results — do NOT re-propose rejected ideas; build on kept ones:\n${lines.join("\n")}`;
}
