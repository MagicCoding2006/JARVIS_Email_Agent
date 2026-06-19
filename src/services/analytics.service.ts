import { getCollections } from "../repositories/collections.js";
import { buildDailyMetrics, type DailyMetrics } from "./reporting.service.js";

export interface BucketMetrics {
  bucket: string;
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  positiveReplies: number;
  meetings: number;
  openRate: number;
  replyRate: number;
  positiveRate: number;
}

function rate(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function toMetrics(rows: { _id: { bucket: string; type: string }; n: number }[]): BucketMetrics[] {
  const buckets = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = r._id.bucket || "(unknown)";
    const m = buckets.get(key) ?? {};
    m[r._id.type] = r.n;
    buckets.set(key, m);
  }
  const out: BucketMetrics[] = [];
  for (const [bucket, m] of buckets) {
    const sent = m.sent ?? 0;
    const replies = m.reply ?? 0;
    const positiveReplies = m.positive_reply ?? 0;
    out.push({
      bucket,
      sent,
      opens: m.open ?? 0,
      clicks: m.click ?? 0,
      replies,
      positiveReplies,
      meetings: m.booked ?? 0,
      openRate: rate(m.open ?? 0, sent),
      replyRate: rate(replies, sent),
      positiveRate: rate(positiveReplies, sent),
    });
  }
  return out.sort((a, b) => b.replyRate - a.replyRate);
}

/** Performance grouped by a lead field (e.g. "industry"). */
export async function breakdownByLeadField(field: "industry", windowDays: number): Promise<BucketMetrics[]> {
  const since = new Date(Date.now() - windowDays * 86400 * 1000);
  const c = await getCollections();
  const rows = await c.events
    .aggregate<{ _id: { bucket: string; type: string }; n: number }>([
      { $match: { timestamp: { $gte: since } } },
      { $lookup: { from: "leads", localField: "leadId", foreignField: "_id", as: "lead" } },
      { $unwind: "$lead" },
      { $group: { _id: { bucket: `$lead.${field}`, type: "$type" }, n: { $sum: 1 } } },
    ])
    .toArray();
  return toMetrics(rows);
}

/** Performance grouped by campaign (persona proxy). */
export async function breakdownByCampaign(windowDays: number): Promise<BucketMetrics[]> {
  const since = new Date(Date.now() - windowDays * 86400 * 1000);
  const c = await getCollections();
  const rows = await c.events
    .aggregate<{ _id: { bucket: string; type: string }; n: number }>([
      { $match: { timestamp: { $gte: since }, campaignId: { $ne: null } } },
      { $lookup: { from: "campaigns", localField: "campaignId", foreignField: "_id", as: "c" } },
      { $unwind: "$c" },
      { $group: { _id: { bucket: "$c.name", type: "$type" }, n: { $sum: 1 } } },
    ])
    .toArray();
  return toMetrics(rows);
}

export interface MonthlyTotals {
  windowDays: number;
  sent: number;
  replies: number;
  positiveReplies: number;
  meetings: number;
  closedWon: number;
  closedLost: number;
  revenue: number;
}

export async function monthlyTotals(windowDays = 30): Promise<MonthlyTotals> {
  const since = new Date(Date.now() - windowDays * 86400 * 1000);
  const c = await getCollections();
  const rows = await c.events
    .aggregate<{ _id: string; n: number; revenue: number }>([
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: "$type",
          n: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$metadata.amount", 0] } },
        },
      },
    ])
    .toArray();
  const get = (t: string) => rows.find((r) => r._id === t)?.n ?? 0;
  const revenue = rows.find((r) => r._id === "closed_won")?.revenue ?? 0;
  return {
    windowDays,
    sent: get("sent"),
    replies: get("reply"),
    positiveReplies: get("positive_reply"),
    meetings: get("booked"),
    closedWon: get("closed_won"),
    closedLost: get("closed_lost"),
    revenue,
  };
}

export function renderBreakdown(title: string, rows: BucketMetrics[], top = 5): string {
  const lines = rows
    .slice(0, top)
    .map((r) => `  ${r.bucket}: ${r.sent} sent, ${r.replyRate}% reply, ${r.positiveRate}% positive, ${r.meetings} mtg`);
  return `${title}\n${lines.join("\n") || "  (no data)"}`;
}

// ── Dashboard analytics ───────────────────────────────────────────────────────
// One bundle powering the dashboard's "Overview" tab. Every series is computed
// with a MongoDB aggregation (no large client-side scans), so this stays cheap
// even with tens of thousands of leads.

const REPLY_TYPES = ["reply", "positive_reply", "negative_reply", "neutral_reply", "request_info"];

export interface DaySeriesPoint {
  day: string;
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
}

export interface NameCount {
  name: string;
  n: number;
}

export interface Funnel {
  leads: number;
  contacted: number;
  opened: number;
  clicked: number;
  replied: number;
  meetings: number;
  won: number;
}

export interface DashboardAnalytics {
  windowDays: number;
  kpis: DailyMetrics;
  funnel: Funnel;
  timeseries: DaySeriesPoint[];
  leadsAdded: { day: string; n: number }[];
  statusBreakdown: NameCount[];
  sourceBreakdown: NameCount[];
  scoreBuckets: NameCount[];
  industry: BucketMetrics[];
  campaigns: BucketMetrics[];
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD strings for the last `days` days, oldest first. */
function dayRange(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

/** Per-day sent/open/click/reply counts over the window, zero-filled. */
async function eventTimeseries(windowDays: number): Promise<DaySeriesPoint[]> {
  const since = new Date(Date.now() - windowDays * 86400 * 1000);
  const c = await getCollections();
  const rows = await c.events
    .aggregate<{ _id: { day: string; type: string }; n: number }>([
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, type: "$type" },
          n: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const byDay = new Map<string, DaySeriesPoint>();
  for (const day of dayRange(windowDays)) byDay.set(day, { day, sent: 0, opens: 0, clicks: 0, replies: 0 });
  for (const r of rows) {
    const p = byDay.get(r._id.day);
    if (!p) continue;
    if (r._id.type === "sent") p.sent += r.n;
    else if (r._id.type === "open") p.opens += r.n;
    else if (r._id.type === "click") p.clicks += r.n;
    else if (REPLY_TYPES.includes(r._id.type)) p.replies += r.n;
  }
  return [...byDay.values()];
}

/** Distinct-lead conversion funnel (lifetime). */
async function buildFunnel(statusBreakdown: NameCount[], totalLeads: number): Promise<Funnel> {
  const c = await getCollections();
  const [agg] = await c.events
    .aggregate<{ contacted: number; opened: number; clicked: number; replied: number; meetings: number }>([
      { $group: { _id: "$leadId", types: { $addToSet: "$type" } } },
      {
        $group: {
          _id: null,
          contacted: { $sum: { $cond: [{ $in: ["sent", "$types"] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $in: ["open", "$types"] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $in: ["click", "$types"] }, 1, 0] } },
          replied: {
            $sum: { $cond: [{ $gt: [{ $size: { $setIntersection: ["$types", REPLY_TYPES] } }, 0] }, 1, 0] },
          },
          meetings: { $sum: { $cond: [{ $in: ["booked", "$types"] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  const won = statusBreakdown.find((s) => s.name === "won")?.n ?? 0;
  return {
    leads: totalLeads,
    contacted: agg?.contacted ?? 0,
    opened: agg?.opened ?? 0,
    clicked: agg?.clicked ?? 0,
    replied: agg?.replied ?? 0,
    meetings: agg?.meetings ?? 0,
    won,
  };
}

async function groupLeadsBy(field: "status" | "source", limit = 0): Promise<NameCount[]> {
  const c = await getCollections();
  const rows = await c.leads
    .aggregate<{ _id: string | null; n: number }>([
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      ...(limit ? [{ $limit: limit }] : []),
    ])
    .toArray();
  return rows.map((r) => ({ name: r._id || "(none)", n: r.n }));
}

async function scoreDistribution(): Promise<NameCount[]> {
  const c = await getCollections();
  const rows = await c.leads
    .aggregate<{ _id: string; n: number }>([
      {
        $group: {
          _id: {
            $switch: {
              branches: [
                { case: { $lte: ["$score", 0] }, then: "0" },
                { case: { $lte: ["$score", 20] }, then: "1–20" },
                { case: { $lte: ["$score", 40] }, then: "21–40" },
                { case: { $lte: ["$score", 70] }, then: "41–70" },
              ],
              default: "70+ 🔥",
            },
          },
          n: { $sum: 1 },
        },
      },
    ])
    .toArray();
  const order = ["0", "1–20", "21–40", "41–70", "70+ 🔥"];
  const map = new Map(rows.map((r) => [r._id, r.n]));
  return order.map((name) => ({ name, n: map.get(name) ?? 0 }));
}

async function leadsAddedSeries(windowDays: number): Promise<{ day: string; n: number }[]> {
  const since = new Date(Date.now() - windowDays * 86400 * 1000);
  const c = await getCollections();
  const rows = await c.leads
    .aggregate<{ _id: string; n: number }>([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, n: { $sum: 1 } } },
    ])
    .toArray();
  const map = new Map(rows.map((r) => [r._id, r.n]));
  return dayRange(windowDays).map((day) => ({ day, n: map.get(day) ?? 0 }));
}

/** Assemble the full analytics bundle for the dashboard Overview tab. */
export async function buildDashboardAnalytics(windowDays = 30): Promise<DashboardAnalytics> {
  const c = await getCollections();
  const [kpis, timeseries, leadsAdded, statusBreakdown, sourceBreakdown, scoreBuckets, industry, campaigns, totalLeads] =
    await Promise.all([
      buildDailyMetrics(windowDays * 24),
      eventTimeseries(windowDays),
      leadsAddedSeries(windowDays),
      groupLeadsBy("status"),
      groupLeadsBy("source", 12),
      scoreDistribution(),
      breakdownByLeadField("industry", windowDays),
      breakdownByCampaign(windowDays),
      c.leads.countDocuments({}),
    ]);

  const funnel = await buildFunnel(statusBreakdown, totalLeads);

  return {
    windowDays,
    kpis,
    funnel,
    timeseries,
    leadsAdded,
    statusBreakdown,
    sourceBreakdown,
    scoreBuckets,
    industry,
    campaigns,
  };
}
