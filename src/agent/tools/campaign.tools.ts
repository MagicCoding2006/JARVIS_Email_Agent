import { schema, type Tool } from "./types.js";
import { CampaignsRepo, LeadsRepo } from "../../repositories/index.js";
import { DEFAULT_SEQUENCE } from "../../services/sequences/default-sequence.js";
import { enrollLead } from "../../services/sequencer.service.js";
import { ensureCampaign } from "../../services/variants.service.js";
import type { LeadStatus } from "../../models/types.js";

export const listCampaigns: Tool = {
  name: "list_campaigns",
  description: "List all campaigns with their status and step count.",
  risk: "low",
  parameters: schema({}),
  async run() {
    const list = await CampaignsRepo.list();
    return list.map((c) => ({ id: c._id, name: c.name, status: c.status, offer: c.offer, steps: c.sequence.length }));
  },
};

export const createCampaign: Tool = {
  name: "create_campaign",
  description: "Create a new campaign using the default 7-touch sequence. Starts in DRAFT until activated. HIGH RISK.",
  risk: "high",
  parameters: schema(
    {
      name: { type: "string" },
      offer: { type: "string", description: "The value proposition / what you're selling" },
      persona: { type: "string", description: "Target persona, e.g. 'VP Ops at mid-market healthcare'" },
      fromEmail: { type: "string", description: "Optional sending address" },
    },
    ["name", "offer", "persona"],
  ),
  async run(args: { name: string; offer: string; persona: string; fromEmail?: string }) {
    const existing = await CampaignsRepo.getByName(args.name);
    if (existing) return { error: `campaign "${args.name}" already exists`, id: existing._id };
    const c = await CampaignsRepo.create({
      name: args.name,
      offer: args.offer,
      targetPersona: args.persona,
      fromEmail: args.fromEmail,
      sequence: DEFAULT_SEQUENCE,
      status: "draft",
    });
    return { id: c._id, name: c.name, status: c.status };
  },
};

export const setCampaignStatus: Tool = {
  name: "set_campaign_status",
  description: "Activate, pause, or archive a campaign. Activating starts sending. HIGH RISK.",
  risk: "high",
  parameters: schema(
    {
      campaign: { type: "string", description: "Campaign name or id" },
      status: { type: "string", enum: ["draft", "active", "paused", "archived"] },
    },
    ["campaign", "status"],
  ),
  async run(args: { campaign: string; status: "draft" | "active" | "paused" | "archived" }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    await CampaignsRepo.setStatus(c._id, args.status);
    return { id: c._id, name: c.name, status: args.status };
  },
};

export const changeOffer: Tool = {
  name: "change_offer",
  description: "Update a campaign's offer/value-prop or target persona to test a new angle. HIGH RISK.",
  risk: "high",
  parameters: schema(
    {
      campaign: { type: "string" },
      offer: { type: "string", description: "New offer text (optional)" },
      persona: { type: "string", description: "New target persona (optional)" },
    },
    ["campaign"],
  ),
  async run(args: { campaign: string; offer?: string; persona?: string }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    await CampaignsRepo.update(c._id, {
      ...(args.offer ? { offer: args.offer } : {}),
      ...(args.persona ? { targetPersona: args.persona } : {}),
    });
    return { id: c._id, updated: true };
  },
};

export const enrollLeads: Tool = {
  name: "enroll_leads",
  description: "Enroll leads (by status) into a campaign, scheduling their first touch. HIGH RISK.",
  risk: "high",
  parameters: schema(
    {
      campaign: { type: "string" },
      status: { type: "string", description: "Lead status to enroll (default 'new')" },
      limit: { type: "number", description: "Max leads to enroll (default 25)" },
    },
    ["campaign"],
  ),
  async run(args: { campaign: string; status?: string; limit?: number }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    const leads = await LeadsRepo.list({ status: (args.status ?? "new") as LeadStatus }, args.limit ?? 25);
    let created = 0;
    for (const l of leads) {
      const r = await enrollLead(l._id, c._id);
      if (r.created) created++;
    }
    return { campaign: c.name, enrolled: created, considered: leads.length };
  },
};
