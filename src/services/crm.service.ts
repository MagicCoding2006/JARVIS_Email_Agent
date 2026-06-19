import { getCollections } from "../repositories/collections.js";
import { createLogger } from "../lib/logger.js";
import type { Lead } from "../models/types.js";

const log = createLogger("crm");

export interface CrmRow {
  email: string;
  name: string;
  company: string;
  title: string;
  industry: string;
  website: string;
  status: string;
  score: number;
  emailsSent: number;
  opens: number;
  clicks: number;
  replies: number;
  meetings: number;
  lastActivity: string;
  source: string;
  addedAt: string;
}

/**
 * Build a CRM snapshot: every lead joined with their lifetime event stats.
 * Runs two aggregations (leads + event rollup) and merges them in memory.
 */
export async function buildCrmSnapshot(): Promise<CrmRow[]> {
  const c = await getCollections();

  const leads = await c.leads.find({}).sort({ score: -1 }).toArray();

  // Aggregate event counts per lead in one round-trip.
  const eventRollup = await c.events
    .aggregate<{
      _id: string;
      sent: number;
      opens: number;
      clicks: number;
      replies: number;
      meetings: number;
      lastActivity: Date;
    }>([
      {
        $group: {
          _id: "$leadId",
          sent: { $sum: { $cond: [{ $eq: ["$type", "sent"] }, 1, 0] } },
          opens: { $sum: { $cond: [{ $eq: ["$type", "open"] }, 1, 0] } },
          clicks: { $sum: { $cond: [{ $eq: ["$type", "click"] }, 1, 0] } },
          replies: {
            $sum: {
              $cond: [
                {
                  $in: [
                    "$type",
                    ["reply", "positive_reply", "negative_reply", "neutral_reply", "request_info"],
                  ],
                },
                1,
                0,
              ],
            },
          },
          meetings: { $sum: { $cond: [{ $eq: ["$type", "booked"] }, 1, 0] } },
          lastActivity: { $max: "$timestamp" },
        },
      },
    ])
    .toArray();

  const statsMap = new Map(eventRollup.map((r) => [r._id, r]));

  return leads.map((lead: Lead): CrmRow => {
    const stats = statsMap.get(lead._id);
    return {
      email: lead.email,
      name: lead.name ?? "",
      company: lead.company ?? "",
      title: lead.title ?? "",
      industry: lead.industry ?? "",
      website: lead.website ?? "",
      status: lead.status,
      score: lead.score,
      emailsSent: stats?.sent ?? 0,
      opens: stats?.opens ?? 0,
      clicks: stats?.clicks ?? 0,
      replies: stats?.replies ?? 0,
      meetings: stats?.meetings ?? 0,
      lastActivity: stats?.lastActivity ? stats.lastActivity.toISOString() : "",
      source: lead.source ?? "",
      addedAt: lead.createdAt.toISOString(),
    };
  });
}

/** Format a CRM snapshot as a CSV string. */
export function toCsv(rows: CrmRow[]): string {
  const headers: (keyof CrmRow)[] = [
    "email",
    "name",
    "company",
    "title",
    "industry",
    "website",
    "status",
    "score",
    "emailsSent",
    "opens",
    "clicks",
    "replies",
    "meetings",
    "lastActivity",
    "source",
    "addedAt",
  ];
  const escape = (v: string | number) => {
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ];
  return lines.join("\n");
}

/** Print a compact ASCII table of the CRM snapshot to stdout. */
export function printCrmTable(rows: CrmRow[]): void {
  if (!rows.length) {
    log.info("no leads in CRM yet");
    return;
  }

  const cols = [
    { label: "Email", key: "email" as const, width: 30 },
    { label: "Company", key: "company" as const, width: 22 },
    { label: "Status", key: "status" as const, width: 13 },
    { label: "Score", key: "score" as const, width: 5 },
    { label: "Sent", key: "emailsSent" as const, width: 4 },
    { label: "Open", key: "opens" as const, width: 4 },
    { label: "Click", key: "clicks" as const, width: 5 },
    { label: "Reply", key: "replies" as const, width: 5 },
    { label: "Mtg", key: "meetings" as const, width: 3 },
  ];

  const pad = (s: string | number, w: number) => String(s).slice(0, w).padEnd(w);
  const sep = cols.map((c) => "-".repeat(c.width)).join("  ");

  const header = cols.map((c) => pad(c.label, c.width)).join("  ");
  // eslint-disable-next-line no-console
  console.log(`\n${header}`);
  // eslint-disable-next-line no-console
  console.log(sep);
  for (const row of rows) {
    const line = cols.map((c) => pad(row[c.key], c.width)).join("  ");
    // eslint-disable-next-line no-console
    console.log(line);
  }
  // eslint-disable-next-line no-console
  console.log(sep);
  // eslint-disable-next-line no-console
  console.log(`${rows.length} leads\n`);
}
