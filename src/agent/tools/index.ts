import type { Tool } from "./types.js";
import { getMetrics, getPipelineStatus, getBreakdowns } from "./metrics.tools.js";
import { listCampaigns, createCampaign, setCampaignStatus, changeOffer, enrollLeads } from "./campaign.tools.js";
import { genVariants, listVariants, prune } from "./variant.tools.js";
import {
  getLead,
  listHotLeads,
  search,
  research,
  discover,
  discoverBusinessContactLeads,
  verifyEmail,
  sourceLeads,
  sourceLeadsApify,
} from "./lead.tools.js";

const TOOLS: Tool[] = [
  // read-only intelligence
  getMetrics,
  getPipelineStatus,
  getBreakdowns,
  listCampaigns,
  listVariants,
  getLead,
  listHotLeads,
  search,
  verifyEmail,
  // low-risk actions (auto under semi)
  genVariants,
  prune,
  research,
  // high-risk actions (need approval under semi)
  createCampaign,
  setCampaignStatus,
  changeOffer,
  enrollLeads,
  discover,
  discoverBusinessContactLeads,
  sourceLeads,
  sourceLeadsApify,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function allTools(): Tool[] {
  return TOOLS;
}

export function getTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}
