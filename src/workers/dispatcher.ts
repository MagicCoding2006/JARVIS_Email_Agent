import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { nowInWindow } from "../lib/time.js";
import { EnrollmentsRepo, EventsRepo, LeadsRepo, MessagesRepo } from "../repositories/index.js";
import { getSender } from "../services/sender/index.js";
import { scheduleNextStep } from "../services/sequencer.service.js";
import type { Message } from "../models/types.js";

const log = createLogger("dispatcher");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function messageIdHeader(messageId: string, fromEmail: string): string {
  const domain = fromEmail.split("@")[1] || "localhost";
  return `<${messageId}@${domain}>`;
}

export interface DispatchOptions {
  /** Ignore the sending window (used for manual/testing runs). */
  ignoreWindow?: boolean;
}

/**
 * Send all due messages, respecting the sending window and daily/per-run
 * throttles. Each successful send advances the enrollment and schedules the
 * next step. This is the batch send loop — run it on a short cron (e.g. /5min).
 */
export async function dispatchDue(opts: DispatchOptions = {}): Promise<{
  sent: number;
  skipped: number;
  failed: number;
}> {
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  if (!opts.ignoreWindow && !nowInWindow()) {
    log.debug("outside sending window — skipping dispatch");
    return { sent, skipped, failed };
  }

  const sentToday = await MessagesRepo.countSentSince(startOfToday());
  const remainingDaily = config.sending.dailyLimit - sentToday;
  if (remainingDaily <= 0) {
    log.info(`daily send limit reached (${config.sending.dailyLimit})`);
    return { sent, skipped, failed };
  }

  const batchSize = Math.min(config.sending.maxPerRun, remainingDaily);
  const due = await MessagesRepo.getDue(batchSize);
  if (!due.length) return { sent, skipped, failed };

  const sender = getSender();
  log.info(`dispatching ${due.length} due message(s) via ${sender.name}`);

  for (const msg of due) {
    const ok = await sendOne(msg);
    if (ok === "sent") sent++;
    else if (ok === "skipped") skipped++;
    else failed++;

    if (ok === "sent" && !config.sending.dryRun) {
      await sleep(config.sending.minSecondsBetweenSends * 1000);
    }
  }

  log.info(`dispatch complete: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  return { sent, skipped, failed };
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
    const sender = getSender();
    const result = await sender.send({
      to: msg.toEmail,
      fromName: config.mail.fromName,
      fromEmail: msg.fromEmail,
      replyTo: config.mail.replyTo,
      subject: msg.subject,
      html: msg.bodyHtml,
      text: msg.bodyText,
      messageId: header,
      inReplyTo: msg.inReplyTo,
      references: msg.inReplyTo,
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
