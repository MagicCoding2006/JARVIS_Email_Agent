import { schema, type Tool } from "./types.js";
import { getCollections } from "../../repositories/collections.js";
import { CampaignsRepo, LeadsRepo } from "../../repositories/index.js";
import { buildDailyMetrics } from "../../services/reporting.service.js";
import { breakdownByLeadField, breakdownByCampaign } from "../../services/analytics.service.js";
import type { EnrollmentStatus, LeadStatus } from "../../models/types.js";

export const getMetrics: Tool = {
  name: "get_metrics",
  description: "Get aggregate email performance (sent, opens, clicks, replies, meetings, rates) for a recent window.",
  risk: "low",
  parameters: schema({ windowHours: { type: "number", description: "Lookback window in hours (default 24)" } }),
  async run(args: { windowHours?: number }) {
    return buildDailyMetrics(args.windowHours ?? 24);
  },
};

export const getPipelineStatus: Tool = {
  name: "get_pipeline_status",
  description: "Get pipeline counts: total leads, active, replied, meetings, hot leads (score >= 70).",
  risk: "low",
  parameters: schema({}),
  async run() {
    const [total, active, replied, meeting, hot] = await Promise.all([
      LeadsRepo.count(),
      LeadsRepo.count({ status: "active" }),
      LeadsRepo.count({ status: "replied" }),
      LeadsRepo.count({ status: "meeting" }),
      LeadsRepo.count({ score: { $gte: 70 } }),
    ]);
    return { total, active, replied, meeting, hot };
  },
};

export const getBreakdowns: Tool = {
  name: "get_breakdowns",
  description: "Performance broken down by industry and by campaign over a window (days). Use to spot best/worst segments.",
  risk: "low",
  parameters: schema({ windowDays: { type: "number", description: "Lookback in days (default 7)" } }),
  async run(args: { windowDays?: number }) {
    const days = args.windowDays ?? 7;
    const [industry, campaigns] = await Promise.all([
      breakdownByLeadField("industry", days),
      breakdownByCampaign(days),
    ]);
    return { industry, campaigns };
  },
};

function normalizeIndustry(raw?: string): string {
  const s = (raw ?? "unknown").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.includes("roof")) return "roofing";
  if (s.includes("floor")) return "flooring";
  if (s.includes("plumb")) return "plumbing";
  if (s.includes("electric")) return "electrical";
  if (s.includes("concrete")) return "concrete";
  if (s.includes("hvac") || s.includes("heating") || s.includes("air conditioning")) return "hvac";
  if (s.includes("paint")) return "painting";
  if (s.includes("drywall")) return "drywall";
  if (s.includes("remodel") || s.includes("home improvement")) return "home improvement";
  if (s.includes("construction") || s.includes("contractor") || s.includes("builder")) return "construction / gc";
  return s;
}

export const getCampaignLeadIndustrySplit: Tool = {
  name: "get_campaign_lead_industry_split",
  description:
    "Return counts of leads/enrollments in a campaign grouped by normalized industry/niche, optionally including only active enrollments or all enrolled leads.",
  risk: "low",
  parameters: schema({
    campaign: { type: "string", description: "Campaign name or id" },
    statusFilter: {
      type: "string",
      enum: ["active", "all", "new", "completed", "replied"],
      description: "Enrollment/lead status filter. Defaults to active.",
    },
    normalizeAliases: { type: "boolean", description: "Normalize aliases like roofing contractors -> roofing. Default true." },
  }, ["campaign"]),
  async run(args: { campaign: string; statusFilter?: "active" | "all" | "new" | "completed" | "replied"; normalizeAliases?: boolean }) {
    const campaign = (await CampaignsRepo.getById(args.campaign)) ?? (await CampaignsRepo.getByName(args.campaign));
    if (!campaign) return { error: `campaign not found: ${args.campaign}` };

    const c = await getCollections();
    const statusFilter = args.statusFilter ?? "active";
    const enrollmentFilter: Record<string, unknown> = { campaignId: campaign._id };
    if (statusFilter === "active") enrollmentFilter.status = "active" satisfies EnrollmentStatus;
    if (["completed", "replied"].includes(statusFilter)) enrollmentFilter.status = statusFilter as EnrollmentStatus;

    const enrollments = await c.enrollments.find(enrollmentFilter).toArray();
    const leadIds = enrollments.map((e) => e.leadId);
    const leadFilter: Record<string, unknown> = { _id: { $in: leadIds } };
    if (statusFilter === "new") leadFilter.status = "new" satisfies LeadStatus;
    const leads = leadIds.length ? await c.leads.find(leadFilter).toArray() : [];
    const byLead = new Map(leads.map((l) => [l._id, l]));

    const messages = leadIds.length
      ? await c.messages.find({ campaignId: campaign._id, leadId: { $in: leadIds }, status: "sent" }).toArray()
      : [];
    const events = leadIds.length
      ? await c.events.find({ leadId: { $in: leadIds }, type: { $in: ["reply", "positive_reply", "booked"] } }).toArray()
      : [];

    const sentByLead = new Map<string, number>();
    for (const m of messages) sentByLead.set(m.leadId, (sentByLead.get(m.leadId) ?? 0) + 1);
    const repliesByLead = new Map<string, number>();
    const meetingsByLead = new Map<string, number>();
    for (const e of events) {
      if (e.type === "reply" || e.type === "positive_reply") repliesByLead.set(e.leadId, (repliesByLead.get(e.leadId) ?? 0) + 1);
      if (e.type === "booked") meetingsByLead.set(e.leadId, (meetingsByLead.get(e.leadId) ?? 0) + 1);
    }

    const rows = new Map<string, { industry: string; count: number; activeEnrollments: number; sent: number; replies: number; meetings: number }>();
    for (const enrollment of enrollments) {
      const lead = byLead.get(enrollment.leadId);
      if (!lead) continue;
      const key = args.normalizeAliases === false ? (lead.industry || "unknown") : normalizeIndustry(lead.industry);
      const row = rows.get(key) ?? { industry: key, count: 0, activeEnrollments: 0, sent: 0, replies: 0, meetings: 0 };
      row.count += 1;
      if (enrollment.status === "active") row.activeEnrollments += 1;
      row.sent += sentByLead.get(enrollment.leadId) ?? 0;
      row.replies += repliesByLead.get(enrollment.leadId) ?? 0;
      row.meetings += meetingsByLead.get(enrollment.leadId) ?? 0;
      rows.set(key, row);
    }

    const industries = [...rows.values()].sort((a, b) => b.count - a.count || a.industry.localeCompare(b.industry));
    return { campaign: campaign.name, totalLeads: industries.reduce((sum, r) => sum + r.count, 0), statusFilter, industries };
  },
};

