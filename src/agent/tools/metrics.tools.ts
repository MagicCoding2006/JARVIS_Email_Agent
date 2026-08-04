import { schema, type Tool } from "./types.js";
import { CampaignsRepo, LeadsRepo } from "../../repositories/index.js";
import { getCollections } from "../../repositories/collections.js";
import { buildDailyMetrics } from "../../services/reporting.service.js";
import { breakdownByLeadField, breakdownByCampaign } from "../../services/analytics.service.js";
import type { EnrollmentStatus } from "../../models/types.js";

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
  const s = (raw || "unknown").trim().toLowerCase();
  if (!s || s === "unknown") return "unknown";
  if (/roof/.test(s)) return "roofing";
  if (/plumb/.test(s)) return "plumbing";
  if (/electric/.test(s)) return "electrical";
  if (/floor/.test(s)) return "flooring";
  if (/concrete|masonry|cement/.test(s)) return "concrete/masonry";
  if (/drywall/.test(s)) return "drywall";
  if (/paint/.test(s)) return "painting";
  if (/hvac|heating|cooling|air conditioning/.test(s)) return "hvac";
  if (/remodel|renovat|home improvement/.test(s)) return "remodeling/home improvement";
  if (/landscap|lawn|tree/.test(s)) return "landscaping/tree";
  if (/fenc/.test(s)) return "fencing";
  if (/construction|contractor|builder|general/.test(s)) return "general construction";
  return raw || "unknown";
}

export const getCampaignLeadIndustrySplit: Tool = {
  name: "get_campaign_lead_industry_split",
  description:
    "Counts leads/enrollments in a campaign grouped by normalized industry/niche, optionally including only active enrollments or all enrolled leads.",
  risk: "low",
  parameters: schema(
    {
      campaign: { type: "string", description: "Campaign name or id" },
      statusFilter: {
        type: "string",
        enum: ["active", "all", "paused", "completed", "replied", "stopped", "converted"],
        description: "Enrollment status to include (default active). Use 'all' for every enrollment status.",
      },
      normalizeAliases: {
        type: "boolean",
        description: "Normalize similar industries into niches like roofing/plumbing/electrical (default true).",
      },
    },
    ["campaign"],
  ),
  async run(args: {
    campaign: string;
    statusFilter?: EnrollmentStatus | "all";
    normalizeAliases?: boolean;
  }) {
    const campaign =
      (await CampaignsRepo.getById(args.campaign)) ?? (await CampaignsRepo.getByName(args.campaign));
    if (!campaign) return { error: `campaign not found: ${args.campaign}` };

    const c = await getCollections();
    const statusFilter = args.statusFilter ?? "active";
    const enrollmentFilter: Record<string, unknown> = { campaignId: campaign._id };
    if (statusFilter !== "all") enrollmentFilter.status = statusFilter;

    const enrollments = await c.enrollments.find(enrollmentFilter).toArray();
    const leadIds = [...new Set(enrollments.map((e) => e.leadId))];
    const leads = await LeadsRepo.getMany(leadIds);
    const leadsById = new Map(leads.map((l) => [l._id, l]));

    const [sentRows, eventRows] = await Promise.all([
      c.messages
        .aggregate<{ _id: string; sent: number }>([
          { $match: { campaignId: campaign._id, status: "sent", leadId: { $in: leadIds } } },
          { $group: { _id: "$leadId", sent: { $sum: 1 } } },
        ])
        .toArray(),
      c.events
        .aggregate<{ _id: { leadId: string; type: string }; n: number }>([
          {
            $match: {
              campaignId: campaign._id,
              leadId: { $in: leadIds },
              type: { $in: ["reply", "positive_reply", "booked"] },
            },
          },
          { $group: { _id: { leadId: "$leadId", type: "$type" }, n: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const sentByLead = new Map(sentRows.map((r) => [r._id, r.sent]));
    const eventsByLead = new Map<string, Record<string, number>>();
    for (const r of eventRows) {
      const current = eventsByLead.get(r._id.leadId) ?? {};
      current[r._id.type] = r.n;
      eventsByLead.set(r._id.leadId, current);
    }

    const buckets = new Map<
      string,
      { industry: string; count: number; activeEnrollments: number; sent: number; replies: number; positiveReplies: number; meetings: number }
    >();

    for (const e of enrollments) {
      const lead = leadsById.get(e.leadId);
      const industry = args.normalizeAliases === false ? lead?.industry || "unknown" : normalizeIndustry(lead?.industry);
      const bucket = buckets.get(industry) ?? {
        industry,
        count: 0,
        activeEnrollments: 0,
        sent: 0,
        replies: 0,
        positiveReplies: 0,
        meetings: 0,
      };
      const ev = eventsByLead.get(e.leadId) ?? {};
      bucket.count += 1;
      if (e.status === "active") bucket.activeEnrollments += 1;
      bucket.sent += sentByLead.get(e.leadId) ?? 0;
      bucket.replies += ev.reply ?? 0;
      bucket.positiveReplies += ev.positive_reply ?? 0;
      bucket.meetings += ev.booked ?? 0;
      buckets.set(industry, bucket);
    }

    return {
      campaign: campaign.name,
      campaignId: campaign._id,
      statusFilter,
      totalLeads: enrollments.length,
      industries: [...buckets.values()].sort((a, b) => b.count - a.count),
    };
  },
};
