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

interface EventStats {
  _id: string;
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  meetings: number;
  lastActivity: Date;
}

/**
 * Aggregate per-lead event counts in one round-trip. If `leadIds` is given, the
 * rollup is restricted to those leads (so a single page of the CRM doesn't scan
 * the entire events collection); omit it to roll up every lead.
 */
async function rollupEvents(
  c: Awaited<ReturnType<typeof getCollections>>,
  leadIds?: string[],
): Promise<Map<string, EventStats>> {
  const pipeline: Record<string, unknown>[] = [];
  if (leadIds) pipeline.push({ $match: { leadId: { $in: leadIds } } });
  pipeline.push({
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
  });
  const rollup = await c.events.aggregate<EventStats>(pipeline).toArray();
  return new Map(rollup.map((r) => [r._id, r]));
}

function toCrmRow(lead: Lead, stats?: EventStats): CrmRow {
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
}

/**
 * Build a CRM snapshot: every lead joined with their lifetime event stats.
 * Used for full exports (CSV / CLI). For the dashboard table use
 * {@link buildCrmPage}, which paginates instead of loading every lead.
 */
export async function buildCrmSnapshot(): Promise<CrmRow[]> {
  const c = await getCollections();
  const leads = await c.leads.find({}).sort({ score: -1 }).toArray();
  const statsMap = await rollupEvents(c);
  return leads.map((lead: Lead) => toCrmRow(lead, statsMap.get(lead._id)));
}

export interface CrmPageQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
}

export interface CrmPageResult {
  rows: CrmRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build one page of the CRM, sorted by score. Filtering (status + free-text
 * search across email/company/name/status) and pagination happen in MongoDB, so
 * only `pageSize` leads — and only the events for those leads — are ever loaded.
 */
export async function buildCrmPage(q: CrmPageQuery = {}): Promise<CrmPageResult> {
  const c = await getCollections();

  const page = Math.max(1, Math.floor(q.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(q.pageSize ?? 50)));

  const filter: Record<string, unknown> = {};
  if (q.status && q.status.trim()) filter.status = q.status.trim();
  if (q.search && q.search.trim()) {
    const rx = new RegExp(escapeRegex(q.search.trim()), "i");
    filter.$or = [{ email: rx }, { company: rx }, { name: rx }, { status: rx }];
  }

  const total = await c.leads.countDocuments(filter);
  const leads = await c.leads
    .find(filter)
    .sort({ score: -1, _id: 1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .toArray();

  const statsMap = await rollupEvents(
    c,
    leads.map((l: Lead) => l._id),
  );

  return {
    rows: leads.map((lead: Lead) => toCrmRow(lead, statsMap.get(lead._id))),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
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
