import { getCollections } from "../repositories/collections.js";

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
