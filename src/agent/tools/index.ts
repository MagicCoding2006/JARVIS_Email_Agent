import type { Tool } from "./types.js";
import { getMetrics, getPipelineStatus, getBreakdowns, getCampaignLeadIndustrySplit } from "./metrics.tools.js";
import {
  listCampaigns,
  createCampaign,
  setCampaignStatus,
  changeOffer,
  enrollLeads,
  cancelCampaignEnrollmentsTool,
} from "./campaign.tools.js";
import { genVariants, listVariants, prune } from "./variant.tools.js";
import { evaluateExperiments, listHypotheses } from "./experiment.tools.js";
import { draftStepTemplate, setStepTemplate } from "./template.tools.js";
import { createVideoScript, renderVideoAsset } from "./video.tools.js";
import { getSendPaceTool, setSendPaceTool } from "./pace.tools.js";
import { getPlaybook, addPlaybookNote, proposeTool } from "./playbook.tools.js";
import { getPipelineInventory, autoEnroll } from "./pipeline.tools.js";
import { sendReply } from "./reply.tools.js";
import { getMeetings } from "./meeting.tools.js";
import { listSiteFiles, readSiteFile, proposeSiteChange } from "./site.tools.js";
import { listCodeFiles, readCodeFile, proposeCodeChange } from "./code.tools.js";
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
  getCampaignLeadIndustrySplit,
  listCampaigns,
  listVariants,
  listHypotheses,
  getLead,
  listHotLeads,
  search,
  verifyEmail,
  getSendPaceTool,
  getPlaybook,
  getPipelineInventory,
  getMeetings,
  listSiteFiles,
  readSiteFile,
  listCodeFiles,
  readCodeFile,
  // low-risk actions (auto under semi)
  genVariants,
  prune,
  evaluateExperiments,
  draftStepTemplate,
  research,
  createVideoScript,
  setSendPaceTool,
  addPlaybookNote,
  proposeTool,
  autoEnroll,
  discover,
  proposeSiteChange,
  // high-risk actions (need approval under semi)
  proposeCodeChange,
  createCampaign,
  setCampaignStatus,
  cancelCampaignEnrollmentsTool,
  changeOffer,
  setStepTemplate,
  enrollLeads,
  sendReply,
  discoverBusinessContactLeads,
  sourceLeads,
  sourceLeadsApify,
  renderVideoAsset,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function allTools(): Tool[] {
  return TOOLS;
}

export function getTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}
