import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { nowInWindow, startOfDay } from "../lib/time.js";
import {
  CampaignsRepo,
  EnrollmentsRepo,
  EventsRepo,
  LeadsRepo,
  MessagesRepo,
} from "../repositories/index.js";
import { dispositionForCampaignStatus } from "../services/campaign-control.service.js";
import { getSender } from "../services/sender/index.js";
import {
  allCapacities,
  capacityForEmail,
  getMailboxByEmail,
  senderForMailbox,
} from "../services/sender/mailbox.js";
import { scheduleNextStep } from "../services/sequencer.service.js";
import { trackingUrls } from "../services/tracking.service.js";
import { checkSendingHealth, type SendingHealth } from "../services/sending-health.service.js";
import { getSendPace } from "../services/send-pace.service.js";
import { notify } from "../services/notifications.service.js";
import type { Campaign, Lead, Message } from "../models/types.js";

const log = createLogger("dispatcher");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Throttle the "sending paused" alert so a sustained pause doesn't spam every run.
let lastPauseAlertAt = 0;
async function alertSendingPaused(health: SendingHealth): Promise<void> {
  if (Date.now() - lastPauseAlertAt < 6 * 3600 * 1000) return;
  lastPauseAlertAt = Date.now();
  await notify({
    kind: "sending_paused",
    level: "important",
    title: "⚠️ Sending paused — high bounce rate",
    body: `${health.reason}. Auto-paused to protect domain reputation. Check recent imports / email verification, then it resumes automatically once the rate drops.`,
  });
}

function messageIdHeader(messageId: string, fromEmail: string): string {
  const domain = fromEmail.split("@")[1] || "localhost";
  return `<${messageId}@${domain}>`;
}

/**
 * RFC 8058 one-click unsubscribe headers. Gmail/Yahoo require these for bulk
 * senders; they also keep complaints out of the spam-report path.
 */
function listUnsubscribeHeaders(lead: Lead, fromEmail: string): Record<string, string> {
  const url = trackingUrls.unsubscribe(lead.unsubscribeToken);
  return {
    "List-Unsubscribe": `<${url}>, <mailto:${fromEmail}?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export interface DispatchOptions {
  /** Ignore the sending window (used for manual/testing runs). */
  ignoreWindow?: boolean;
}

export interface DispatchResult {
  sent: number;
  skipped: number;
  failed: number;
  /** Due messages left scheduled — mailbox/domain at cap, or campaign paused. */
  deferred: number;
}

/**
 * Per-run campaign cache. A dispatch batch is mostly one or two campaigns, so
 * this keeps the safety guard to a single lookup each instead of one per message.
 */
type CampaignCache = Map<string, Campaign | null>;

async function loadCampaign(cache: CampaignCache, id: string): Promise<Campaign | null> {
  if (!cache.has(id)) cache.set(id, await CampaignsRepo.getById(id));
  return cache.get(id) ?? null;
}

/**
 * Send all due messages, respecting the sending window and each mailbox's
 * warmup-adjusted daily cap. Sends rotate across the mailbox pool (every
 * prospect has a sticky mailbox), and a message whose mailbox is at cap is left
 * scheduled for a later run. Run on a short cron (e.g. /5min).
 */
export async function dispatchDue(opts: DispatchOptions = {}): Promise<DispatchResult> {
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let deferred = 0;

  if (!opts.ignoreWindow && !nowInWindow()) {
    log.debug("outside sending window — skipping dispatch");
    return { sent, skipped, failed, deferred };
  }

  const dryRun = config.sending.dryRun;
  const pace = await getSendPace();

  // Reputation guard: stop sending if the recent bounce rate has spiked.
  if (!dryRun) {
    const health = await checkSendingHealth();
    if (!health.healthy) {
      log.warn(`dispatch paused — ${health.reason}`);
      await alertSendingPaused(health);
      return { sent, skipped, failed, deferred };
    }
  }

  // Remaining capacity per mailbox today (warmup-adjusted), tracked mutably as
  // we send. Unknown (campaign-pinned) from-addresses are filled in lazily.
  const remaining = new Map<string, number>();
  let totalRemaining = 0;
  if (!dryRun) {
    for (const [email, cap] of await allCapacities()) {
      remaining.set(email, cap.remaining);
      totalRemaining += cap.remaining;
    }
    // The agent-tunable daily ceiling can only ever narrow this, never widen it
    // past what mailboxes physically allow.
    totalRemaining = Math.min(totalRemaining, pace.dailyCeiling);
    if (totalRemaining <= 0) {
      log.info("all mailboxes at warmup/daily cap — nothing to send");
      return { sent, skipped, failed, deferred };
    }
  } else {
    totalRemaining = pace.maxPerRun;
  }

  const batchSize = Math.min(pace.maxPerRun, totalRemaining);
  // Over-fetch: some due messages may be deferred when their mailbox/domain is full.
  const due = await MessagesRepo.getDue(Math.min(batchSize * 4, 200));
  if (!due.length) return { sent, skipped, failed, deferred };

  log.info(`dispatching up to ${batchSize} of ${due.length} due message(s)`);

  // Remaining capacity per recipient domain today — a hard cap the agent
  // cannot change, protecting one target company's mail server/reputation
  // from being hammered regardless of how aggressive the agent's pace is.
  const domainCap = config.sending.maxPerRecipientDomainPerDay;
  const domainRemaining = new Map<string, number>();
  async function remainingForDomain(domain: string): Promise<number> {
    if (domainCap <= 0) return Infinity;
    if (!domainRemaining.has(domain)) {
      const sentToday = await MessagesRepo.countSentSinceToDomain(startOfDay(new Date()), domain);
      domainRemaining.set(domain, Math.max(0, domainCap - sentToday));
    }
    return domainRemaining.get(domain)!;
  }

  const campaignCache: CampaignCache = new Map();

  for (const msg of due) {
    if (sent >= batchSize) break;

    const key = msg.fromEmail.trim().toLowerCase();
    if (!dryRun) {
      if (!remaining.has(key)) remaining.set(key, (await capacityForEmail(key)).remaining);
      if ((remaining.get(key) ?? 0) <= 0) {
        deferred++; // leave it scheduled; a later run/day picks it up
        continue;
      }

      const domain = msg.toDomain || msg.toEmail.split("@")[1]?.trim().toLowerCase() || "";
      if (domain && (await remainingForDomain(domain)) <= 0) {
        deferred++; // this recipient domain is at its daily cap
        continue;
      }
    }

    const ok = await sendOne(msg, campaignCache);
    if (ok === "deferred") {
      deferred++; // campaign paused — leave it queued for when it resumes
      continue;
    }
    if (ok === "sent") {
      sent++;
      if (!dryRun) {
        remaining.set(key, (remaining.get(key) ?? 1) - 1);
        const domain = msg.toDomain || msg.toEmail.split("@")[1]?.trim().toLowerCase() || "";
        if (domain && domainRemaining.has(domain)) {
          domainRemaining.set(domain, domainRemaining.get(domain)! - 1);
        }
        await sleep(config.sending.minSecondsBetweenSends * 1000);
      }
    } else if (ok === "skipped") {
      skipped++;
    } else {
      failed++;
    }
  }

  log.info(
    `dispatch complete: ${sent} sent, ${skipped} skipped, ${failed} failed, ${deferred} deferred (cap/paused)`,
  );
  return { sent, skipped, failed, deferred };
}

async function sendOne(
  msg: Message,
  campaignCache: CampaignCache,
): Promise<"sent" | "skipped" | "failed" | "deferred"> {
  // Safety guard: a campaign that isn't active must never put mail on the wire,
  // however many touches are still queued against it. Archived/draft campaigns
  // (and deleted ones) drop their queue; paused ones keep it for the resume.
  const campaign = await loadCampaign(campaignCache, msg.campaignId);
  const disposition = dispositionForCampaignStatus(campaign?.status);
  if (disposition === "hold") {
    log.debug(`holding step ${msg.step} to ${msg.toEmail} — campaign "${campaign?.name}" is paused`);
    return "deferred";
  }
  if (disposition === "drop") {
    const state = campaign ? campaign.status : "deleted";
    await MessagesRepo.setStatus(msg._id, "skipped", { failedReason: `campaign ${state}` });
    log.warn(`skipped step ${msg.step} to ${msg.toEmail} — campaign ${state}`);
    return "skipped";
  }

  // Re-validate the enrollment + lead are still active/contactable.
  const enrollment = await EnrollmentsRepo.getById(msg.enrollmentId);
  if (!enrollment || enrollment.status !== "active") {
    await MessagesRepo.setStatus(msg._id, "skipped", { failedReason: "enrollment not active" });
    return "skipped";
  }
  const lead = await LeadsRepo.getById(msg.leadId);
  if (!lead || lead.unsubscribed || lead.bounced || lead.status === "do_not_contact") {
    await MessagesRepo.setStatus(msg._id, "skipped", { failedReason: "lead not contactable" });
    return "skipped";
  }

  await MessagesRepo.setStatus(msg._id, "sending");
  const header = messageIdHeader(msg._id, msg.fromEmail);

  try {
    // Route through the assigned mailbox's own transport + identity. In dry-run
    // mode, or for a from-address outside the roster, fall back to the default.
    const mailbox = getMailboxByEmail(msg.fromEmail);
    const sender = config.sending.dryRun || !mailbox ? getSender() : senderForMailbox(mailbox);
    const result = await sender.send({
      to: msg.toEmail,
      fromName: mailbox?.fromName ?? config.mail.fromName,
      fromEmail: msg.fromEmail,
      replyTo: mailbox?.replyTo ?? config.mail.replyTo,
      subject: msg.subject,
      html: msg.bodyHtml,
      text: msg.bodyText,
      messageId: header,
      inReplyTo: msg.inReplyTo,
      references: msg.inReplyTo,
      headers: listUnsubscribeHeaders(lead, msg.fromEmail),
    });

    if (!result.accepted) throw new Error(result.detail || "send not accepted");

    await MessagesRepo.setStatus(msg._id, "sent", {
      sentAt: new Date(),
      messageIdHeader: result.messageId || header,
    });
    await EventsRepo.record({
      leadId: msg.leadId,
      campaignId: msg.campaignId,
      enrollmentId: msg.enrollmentId,
      messageId: msg._id,
      type: "sent",
      metadata: { step: msg.step, subject: msg.subject },
    });

    // Advance the enrollment and queue the next step.
    await EnrollmentsRepo.advanceStep(enrollment._id, msg.step);
    if (lead.status === "new") await LeadsRepo.setStatus(lead._id, "active");
    const fresh = await EnrollmentsRepo.getById(enrollment._id);
    if (fresh) await scheduleNextStep(fresh);

    log.info(`sent step ${msg.step} to ${msg.toEmail}`);
    return "sent";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await MessagesRepo.setStatus(msg._id, "failed", { failedReason: reason });
    log.error(`send failed to ${msg.toEmail}: ${reason}`);
    return "failed";
  }
}
