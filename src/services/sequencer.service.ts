import { config } from "../config/index.js";
import { uuid } from "../lib/ids.js";
import { scheduleFromAnchor } from "../lib/time.js";
import { createLogger } from "../lib/logger.js";
import {
  CampaignsRepo,
  EnrollmentsRepo,
  LeadsRepo,
  MessagesRepo,
} from "../repositories/index.js";
import { draftEmail } from "./personalization.service.js";
import { buildTrackedContent } from "./tracking.service.js";
import { selectVariant } from "./variants.service.js";
import type { Enrollment, Message } from "../models/types.js";

const log = createLogger("sequencer");

/**
 * Enroll a lead into a campaign and schedule the first touch.
 * Returns the enrollment (idempotent — re-enrolling is a no-op).
 */
export async function enrollLead(
  leadId: string,
  campaignId: string,
): Promise<{ enrollmentId: string; created: boolean; firstMessage?: Message | null }> {
  const { enrollment, created } = await EnrollmentsRepo.enroll(leadId, campaignId);
  let firstMessage: Message | null | undefined;
  if (created) {
    firstMessage = await scheduleNextStep(enrollment);
  }
  return { enrollmentId: enrollment._id, created, firstMessage };
}

/**
 * Schedule the next un-sent step for an enrollment. Called once at enrollment
 * (schedules step 1) and again after each successful send (schedules step N+1).
 * Stops the sequence when the lead is unreachable or the sequence is exhausted.
 */
export async function scheduleNextStep(enrollment: Enrollment): Promise<Message | null> {
  const [campaign, lead] = await Promise.all([
    CampaignsRepo.getById(enrollment.campaignId),
    LeadsRepo.getById(enrollment.leadId),
  ]);
  if (!campaign || !lead) {
    log.warn(`missing campaign/lead for enrollment ${enrollment._id}`);
    return null;
  }

  // Never contact an opted-out / bounced / DNC lead.
  if (lead.unsubscribed || lead.bounced || lead.status === "do_not_contact") {
    await EnrollmentsRepo.setStatus(enrollment._id, "stopped", "lead not contactable");
    return null;
  }

  const nextStepNum = enrollment.currentStep + 1;
  const step = campaign.sequence.find((s) => s.step === nextStepNum);
  if (!step) {
    await EnrollmentsRepo.setStatus(enrollment._id, "completed");
    log.info(`enrollment ${enrollment._id} completed all ${campaign.sequence.length} steps`);
    return null;
  }

  // Thread follow-ups onto the last sent message.
  const prior = step.followUp
    ? await MessagesRepo.lastSentForEnrollment(enrollment._id)
    : null;

  // Experimentation: pick a test arm for this step (epsilon-greedy). null → base copy.
  const variant = await selectVariant(campaign._id, step.step);

  const draft = await draftEmail({
    lead,
    campaign,
    step,
    priorSubject: prior?.subject,
    priorBody: prior?.body,
    variant: variant
      ? { subjectLine: variant.subjectLine, cta: variant.cta, tone: variant.tone }
      : undefined,
  });

  let subject = draft.subject;
  if (step.followUp && prior) {
    subject = prior.subject.toLowerCase().startsWith("re:")
      ? prior.subject
      : `Re: ${prior.subject}`;
  }

  const messageId = uuid();
  const { html, text, links } = buildTrackedContent({ messageId, body: draft.body, lead });
  const scheduledAt = scheduleFromAnchor(enrollment.enrolledAt, step.businessDayOffset);

  const message = await MessagesRepo.create({
    _id: messageId,
    leadId: lead._id,
    campaignId: campaign._id,
    enrollmentId: enrollment._id,
    step: step.step,
    variantId: variant?._id,
    subject,
    body: draft.body,
    bodyHtml: html,
    bodyText: text,
    fromEmail: campaign.fromEmail || config.mail.fromEmail,
    toEmail: lead.email,
    status: "scheduled",
    scheduledAt,
    trackingPixelId: messageId,
    inReplyTo: step.followUp && prior?.messageIdHeader ? prior.messageIdHeader : undefined,
    links,
  });

  log.info(
    `scheduled step ${step.step} (${step.purpose}) for ${lead.email} at ${scheduledAt.toISOString()}`,
  );
  return message;
}
