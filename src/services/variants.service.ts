import { worker } from "../llm/roles.js";
import { createLogger } from "../lib/logger.js";
import { CampaignsRepo, VariantsRepo } from "../repositories/index.js";
import type { Campaign, EventType, Variant, VariantStats } from "../models/types.js";

const log = createLogger("variants");

// Multi-armed-bandit tuning.
const EXPLORE_EPSILON = 0.25; // 25% of the time, try a non-best variant
const MIN_SAMPLES_TO_EXPLOIT = 20; // until a variant has this many sends, keep exploring it
const PRUNE_MIN_SAMPLES = 40; // need this much data before retiring a variant

/** Blended reward: positive replies and meetings matter most, opens least. */
export function variantScore(s: VariantStats): number {
  const sent = Math.max(s.sent, 1);
  return (s.positiveReplies * 3 + s.replies * 1 + s.meetings * 6 + s.opens * 0.1) / sent;
}

export function replyRate(s: VariantStats): number {
  return s.sent > 0 ? s.replies / s.sent : 0;
}

/**
 * Epsilon-greedy variant selection for a campaign step. Returns null when there
 * are no variants (the sequencer then falls back to the base sequence copy).
 */
export async function selectVariant(campaignId: string, step: number): Promise<Variant | null> {
  const variants = await VariantsRepo.listForCampaignStep(campaignId, step, true);
  if (variants.length === 0) return null;
  if (variants.length === 1) return variants[0];

  // Always explore any under-sampled variant first (gather data).
  const undersampled = variants.filter((v) => v.stats.sent < MIN_SAMPLES_TO_EXPLOIT);
  if (undersampled.length > 0) {
    return leastSent(undersampled);
  }

  // Otherwise epsilon-greedy: explore a random arm, else exploit the best.
  if (Math.random() < EXPLORE_EPSILON) {
    return variants[Math.floor(Math.random() * variants.length)];
  }
  return variants.reduce((best, v) => (variantScore(v.stats) > variantScore(best.stats) ? v : best));
}

function leastSent(vs: Variant[]): Variant {
  return vs.reduce((min, v) => (v.stats.sent < min.stats.sent ? v : min));
}

/** Map an event type to the variant stat it increments (if any). */
const STAT_FOR_EVENT: Partial<Record<EventType, keyof VariantStats>> = {
  sent: "sent",
  open: "opens",
  click: "clicks",
  reply: "replies",
  positive_reply: "positiveReplies",
  booked: "meetings",
  closed_won: "closes",
};

/** Roll a single event into its message's variant stats (called in batch). */
export async function rollupEventToVariant(
  variantId: string | undefined,
  eventType: EventType,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!variantId) return;
  const field = STAT_FOR_EVENT[eventType];
  if (field) await VariantsRepo.incStat(variantId, field);
  if (eventType === "closed_won" && typeof metadata?.amount === "number") {
    await VariantsRepo.incStat(variantId, "revenue", metadata.amount as number);
  }
}

/**
 * Use the worker model to generate NEW variants (subject line + CTA + tone) for
 * a campaign step, optionally seeded by strategist hypotheses. This is how the
 * system "changes email styles": new arms are created, then the bandit tests them.
 */
export async function generateVariants(args: {
  campaign: Campaign;
  step: number;
  count: number;
  hypotheses?: string[];
}): Promise<Variant[]> {
  const { campaign, step, count, hypotheses = [] } = args;
  if (!worker.configured) {
    log.warn("worker not configured — skipping variant generation");
    return [];
  }

  const stepDef = campaign.sequence.find((s) => s.step === step);
  const system = `You design A/B test variants for cold sales emails. Be diverse and specific.
Return ONLY JSON: {"variants":[{"name":"short label","subjectLine":"...","cta":"...","tone":"e.g. direct/curious/warm/contrarian"}]}.`;
  const user = `Create ${count} distinct test variants for step ${step} (${stepDef?.purpose ?? ""}).
Offer: ${campaign.offer}
Persona: ${campaign.targetPersona}
Step angle: ${stepDef?.angle ?? ""}
${hypotheses.length ? `Incorporate these hypotheses to test:\n- ${hypotheses.join("\n- ")}` : ""}
Make subject lines under 50 chars, CTAs low-friction. Vary tone meaningfully across variants.`;

  let parsed: { variants?: { name: string; subjectLine: string; cta: string; tone: string }[] };
  try {
    parsed = await worker.completeJSON(user, { system, temperature: 0.9 });
  } catch (err) {
    log.error("variant generation failed", err);
    return [];
  }

  const created: Variant[] = [];
  for (const v of parsed.variants ?? []) {
    const variant = await VariantsRepo.create({
      campaignId: campaign._id,
      step,
      name: v.name || "variant",
      subjectLine: v.subjectLine,
      cta: v.cta,
      tone: v.tone,
      industry: undefined,
      hypothesisId: undefined,
    });
    created.push(variant);
  }
  log.info(`generated ${created.length} variants for "${campaign.name}" step ${step}`);
  return created;
}

/**
 * Retire underperforming variants. For each step with enough data, deactivate
 * arms whose blended score is well below the best (keeps at least the winner).
 */
export async function pruneVariants(campaignId: string): Promise<{ pruned: number; kept: number }> {
  const all = await VariantsRepo.listForCampaign(campaignId);
  const bySteps = new Map<number, Variant[]>();
  for (const v of all) {
    if (!v.active) continue;
    bySteps.set(v.step, [...(bySteps.get(v.step) ?? []), v]);
  }

  let pruned = 0;
  let kept = 0;
  for (const [, variants] of bySteps) {
    const eligible = variants.filter((v) => v.stats.sent >= PRUNE_MIN_SAMPLES);
    if (eligible.length < 2) {
      kept += variants.length;
      continue;
    }
    const best = eligible.reduce((b, v) => (variantScore(v.stats) > variantScore(b.stats) ? v : b));
    const bestScore = variantScore(best.stats);
    for (const v of eligible) {
      if (v._id === best._id) {
        kept++;
        continue;
      }
      // Retire if meaningfully worse than the best (>40% lower blended score).
      if (variantScore(v.stats) < bestScore * 0.6) {
        await VariantsRepo.setActive(v._id, false);
        pruned++;
        log.info(`pruned variant "${v.name}" (step ${v.step}) of ${campaignId}`);
      } else kept++;
    }
  }
  return { pruned, kept };
}

/** Convenience for reviews/CLI: campaigns with their per-variant performance. */
export async function variantLeaderboard(campaignId: string): Promise<
  { step: number; name: string; sent: number; replyRate: number; score: number; active: boolean }[]
> {
  const all = await VariantsRepo.listForCampaign(campaignId);
  return all
    .map((v) => ({
      step: v.step,
      name: v.name,
      sent: v.stats.sent,
      replyRate: Math.round(replyRate(v.stats) * 1000) / 10,
      score: Math.round(variantScore(v.stats) * 1000) / 1000,
      active: v.active,
    }))
    .sort((a, b) => a.step - b.step || b.score - a.score);
}

export async function ensureCampaign(idOrName: string): Promise<Campaign | null> {
  return (await CampaignsRepo.getById(idOrName)) ?? (await CampaignsRepo.getByName(idOrName));
}
