import { schema, type Tool } from "./types.js";
import { ensureCampaign, generateVariants, variantLeaderboard, pruneVariants } from "../../services/variants.service.js";

export const genVariants: Tool = {
  name: "generate_variants",
  description: "Create new A/B test variants (subject line + CTA + tone) for a campaign step. The bandit will test them automatically.",
  risk: "low",
  parameters: schema(
    {
      campaign: { type: "string" },
      step: { type: "number", description: "Sequence step (default 1)" },
      count: { type: "number", description: "How many variants (default 3)" },
      hypotheses: { type: "array", items: { type: "string" }, description: "Ideas to encode into the variants" },
    },
    ["campaign"],
  ),
  async run(args: { campaign: string; step?: number; count?: number; hypotheses?: string[] }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    const created = await generateVariants({
      campaign: c,
      step: args.step ?? 1,
      count: args.count ?? 3,
      hypotheses: args.hypotheses,
    });
    return { created: created.map((v) => ({ name: v.name, subjectLine: v.subjectLine, tone: v.tone })) };
  },
};

export const listVariants: Tool = {
  name: "list_variants",
  description: "Get the variant leaderboard (per step: sent, reply rate, score, active) for a campaign.",
  risk: "low",
  parameters: schema({ campaign: { type: "string" } }, ["campaign"]),
  async run(args: { campaign: string }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    return variantLeaderboard(c._id);
  },
};

export const prune: Tool = {
  name: "prune_variants",
  description: "Retire underperforming variants for a campaign (keeps winners). Run after enough data accrues.",
  risk: "low",
  parameters: schema({ campaign: { type: "string" } }, ["campaign"]),
  async run(args: { campaign: string }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    return pruneVariants(c._id);
  },
};
