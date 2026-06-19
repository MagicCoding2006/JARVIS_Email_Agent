import { EventsRepo, LeadsRepo } from "../repositories/index.js";

export interface DailyMetrics {
  windowHours: number;
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  replies: number;
  positiveReplies: number;
  negativeReplies: number;
  meetings: number;
  unsubscribes: number;
  bounces: number;
  openRate: number;
  clickRate: number;
  replyRate: number;
  positiveReplyRate: number;
  hotLeads: number;
}

function rate(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

export async function buildDailyMetrics(windowHours = 24): Promise<DailyMetrics> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000);
  const counts = await EventsRepo.countByTypeSince(since);
  const g = (t: string) => counts[t] ?? 0;

  const sent = g("sent");
  const opens = g("open");
  const clicks = g("click");
  const replies = g("reply");
  const positiveReplies = g("positive_reply");

  const hotLeads = await LeadsRepo.count({ score: { $gte: 70 } });

  return {
    windowHours,
    sent,
    delivered: g("delivered"),
    opens,
    clicks,
    replies,
    positiveReplies,
    negativeReplies: g("negative_reply"),
    meetings: g("booked"),
    unsubscribes: g("unsubscribe"),
    bounces: g("bounce"),
    openRate: rate(opens, sent),
    clickRate: rate(clicks, sent),
    replyRate: rate(replies, sent),
    positiveReplyRate: rate(positiveReplies, sent),
    hotLeads,
  };
}

export function renderMetricsText(m: DailyMetrics): string {
  return [
    `📊 Last ${m.windowHours}h performance`,
    `Sent: ${m.sent}   Opens: ${m.opens} (${m.openRate}%)   Clicks: ${m.clicks} (${m.clickRate}%)`,
    `Replies: ${m.replies} (${m.replyRate}%)   Positive: ${m.positiveReplies} (${m.positiveReplyRate}%)   Negative: ${m.negativeReplies}`,
    `Meetings: ${m.meetings}   Unsubs: ${m.unsubscribes}   Bounces: ${m.bounces}`,
    `Hot leads in pipeline (score ≥ 70): ${m.hotLeads}`,
  ].join("\n");
}
