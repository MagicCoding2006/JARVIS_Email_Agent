import { config } from "../config/index.js";
import { uuid } from "../lib/ids.js";
import { EventsRepo, MessagesRepo, VideosRepo } from "../repositories/index.js";
import { buildTrackedContent } from "./tracking.service.js";
import { getSender } from "./sender/index.js";
import { getMailboxByEmail, senderForMailbox } from "./sender/mailbox.js";
import type { Lead } from "../models/types.js";

/**
 * Send one email to a lead RIGHT NOW (no dispatcher queue) — used for reply
 * responses and meeting reminders, where latency matters. Threads onto our last
 * sent message (same sticky mailbox, Re: subject, References header), renders
 * tracked HTML/text, and records a sent Message + event so mailbox/domain cap
 * accounting and the CRM still see it. Respects DRY_RUN via getSender().
 *
 * Callers are responsible for the contactability check and for deciding
 * WHETHER this send is appropriate (approval-gated or transactional).
 */
export async function sendDirectToLead(
  lead: Lead,
  args: { body: string; subject?: string; eventMetadata?: Record<string, unknown> },
): Promise<{ sent: boolean; error?: string; subject: string; from: string; messageId: string }> {
  const history = await MessagesRepo.listForLead(lead._id);
  const lastSent = [...history].reverse().find((m) => m.status === "sent");
  const fromEmail = lastSent?.fromEmail ?? config.mail.fromEmail;
  const subject =
    args.subject ??
    (lastSent
      ? lastSent.subject.toLowerCase().startsWith("re:")
        ? lastSent.subject
        : `Re: ${lastSent.subject}`
      : "Re: our conversation");

  const messageId = uuid();
  const video = await VideosRepo.latestForLead(lead._id, lastSent?.campaignId);
  const { html, text, links } = buildTrackedContent({ messageId, body: args.body, lead, video });
  const headerDomain = fromEmail.split("@")[1] || "localhost";
  const messageIdHeader = `<${messageId}@${headerDomain}>`;

  const mailbox = getMailboxByEmail(fromEmail);
  const sender = config.sending.dryRun || !mailbox ? getSender() : senderForMailbox(mailbox);
  const result = await sender.send({
    to: lead.email,
    fromName: mailbox?.fromName ?? config.mail.fromName,
    fromEmail,
    replyTo: mailbox?.replyTo ?? config.mail.replyTo,
    subject,
    html,
    text,
    messageId: messageIdHeader,
    inReplyTo: lastSent?.messageIdHeader,
    references: lastSent?.messageIdHeader,
  });
  if (!result.accepted) {
    return { sent: false, error: result.detail || "send not accepted", subject, from: fromEmail, messageId };
  }

  await MessagesRepo.create({
    _id: messageId,
    leadId: lead._id,
    campaignId: lastSent?.campaignId ?? "manual",
    enrollmentId: lastSent?.enrollmentId ?? "manual",
    step: 0,
    subject,
    body: args.body,
    bodyHtml: html,
    bodyText: text,
    fromEmail,
    toEmail: lead.email,
    status: "sent",
    scheduledAt: new Date(),
    sentAt: new Date(),
    trackingPixelId: messageId,
    messageIdHeader: result.messageId || messageIdHeader,
    inReplyTo: lastSent?.messageIdHeader,
    links,
  });
  await EventsRepo.record({
    leadId: lead._id,
    campaignId: lastSent?.campaignId,
    messageId,
    type: "sent",
    metadata: { subject, ...(args.eventMetadata ?? {}) },
  });

  return { sent: true, subject, from: fromEmail, messageId };
}
