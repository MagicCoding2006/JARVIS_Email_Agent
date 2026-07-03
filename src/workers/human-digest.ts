import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { startOfDay } from "../lib/time.js";
import { ApprovalsRepo, EnrollmentsRepo, EventsRepo, LeadsRepo } from "../repositories/index.js";
import { allCapacities } from "../services/sender/mailbox.js";
import { notify } from "../services/notifications.service.js";

const log = createLogger("human-digest");

const WEEK_MS = 7 * 86_400_000;

/**
 * The Monday "what needs a human" digest — the operator's whole job in one
 * Telegram message: approvals waiting, meetings booked, replies in play,
 * mailbox warmup status, and how much lead runway is left. Deterministic (no
 * LLM tokens); everything else the system handles itself.
 */
export async function runHumanDigest(): Promise<string> {
  const weekAgo = new Date(Date.now() - WEEK_MS);
  const [pending, weekEvents, newLeads, replied, meetings, caps, enrolledToday] = await Promise.all([
    ApprovalsRepo.listPending(),
    EventsRepo.countByTypeSince(weekAgo),
    LeadsRepo.count({ status: "new" }),
    LeadsRepo.count({ status: "replied" }),
    LeadsRepo.count({ status: "meeting" }),
    allCapacities(),
    EnrollmentsRepo.countEnrolledSince(startOfDay(new Date())),
  ]);

  let dailyCapacity = 0;
  const mailboxLines: string[] = [];
  for (const c of caps.values()) {
    dailyCapacity += c.cap;
    mailboxLines.push(`  ${c.email}: ${c.cap}/day${c.cap < config.mailboxes.warmup.maxPerDay ? ` (warming, day ${c.warmupDay})` : ""}`);
  }
  const runwayDays = dailyCapacity > 0 ? Math.round(newLeads / dailyCapacity) : 0;

  const lines = [
    `▶ Needs you now: ${pending.length} pending approval(s)${pending.length ? ` — tap through them in this chat (or: npm run cli approvals)` : ""}`,
    `▶ Conversations: ${replied} lead(s) sitting in "replied" — check none are stuck waiting on you`,
    `▶ Meetings: ${meetings} lead(s) at meeting stage; ${weekEvents["booked"] ?? 0} booked this week`,
    "",
    `Last 7 days: ${weekEvents["sent"] ?? 0} sent, ${weekEvents["open"] ?? 0} opens, ${weekEvents["reply"] ?? 0} replies, ${weekEvents["positive_reply"] ?? 0} positive, ${weekEvents["bounce"] ?? 0} bounces`,
    "",
    `Mailboxes (${caps.size}) — combined ${dailyCapacity}/day:`,
    ...mailboxLines,
    "",
    `Lead tank: ${newLeads} unenrolled (~${runwayDays} days of runway at full capacity); ${enrolledToday} enrolled today`,
    config.sending.dryRun ? "\n⚠️ DRY_RUN is ON — nothing is actually sending." : "",
  ].filter((l) => l !== "");

  const body = lines.join("\n");
  await notify({ kind: "human_digest", level: "important", title: "🗓️ Monday operator digest — your week in 2 minutes", body });
  log.info("human digest sent");
  return body;
}
