import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { nowInWindow } from "../lib/time.js";
import { EnrollmentsRepo, EventsRepo, LeadsRepo, MessagesRepo } from "../repositories/index.js";
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
import { notify } from "../services/notifications.service.js";
import type { Lead, Message } from "../models/types.js";

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
  /** Due messages held back because their mailbox hit its warmup/daily cap. */
  deferred: number;
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
    if (totalRemaining <= 0) {
      log.info("all mailboxes at warmup/daily cap — nothing to send");
      return { sent, skipped, failed, deferred };
    }
  } else {
    totalRemaining = config.sending.maxPerRun;
  }

  const batchSize = Math.min(config.sending.maxPerRun, totalRemaining);
  // Over-fetch: some due messages may be deferred when their mailbox is full.
  const due = await MessagesRepo.getDue(Math.min(batchSize * 4, 200));
  if (!due.length) return { sent, skipped, failed, deferred };

  log.info(`dispatching up to ${batchSize} of ${due.length} due message(s)`);

  for (const msg of due) {
    if (sent >= batchSize) break;

    const key = msg.fromEmail.trim().toLowerCase();
    if (!dryRun) {
      if (!remaining.has(key)) remaining.set(key, (await capacityForEmail(key)).remaining);
      if ((remaining.get(key) ?? 0) <= 0) {
        deferred++; // leave it scheduled; a later run/day picks it up
        continue;
      }
    }

    const ok = await sendOne(msg);
    if (ok === "sent") {
      sent++;
      if (!dryRun) {
        remaining.set(key, (remaining.get(key) ?? 1) - 1);
        await sleep(config.sending.minSecondsBetweenSends * 1000);
      }
    } else if (ok === "skipped") {
      skipped++;
    } else {
      failed++;
    }
  }

  log.info(
    `dispatch complete: ${sent} sent, ${skipped} skipped, ${failed} failed, ${deferred} deferred (cap)`,
  );
  return { sent, skipped, failed, deferred };
}

async function sendOne(msg: Message): Promise<"sent" | "skipped" | "failed"> {
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
