import { schema, type Tool } from "./types.js";
import { LeadsRepo } from "../../repositories/index.js";
import { buildDailyMetrics } from "../../services/reporting.service.js";
import { breakdownByLeadField, breakdownByCampaign } from "../../services/analytics.service.js";

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
