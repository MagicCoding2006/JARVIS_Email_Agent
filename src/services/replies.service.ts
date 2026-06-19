import { worker } from "../llm/roles.js";
import { buildReplyClassifyPrompt } from "../llm/prompts.js";
import { createLogger } from "../lib/logger.js";
import { EnrollmentsRepo, EventsRepo, LeadsRepo, MessagesRepo } from "../repositories/index.js";
import { notifyReply } from "./notifications.service.js";
import type { EventType, Lead, ReplyClassification } from "../models/types.js";

const log = createLogger("replies");

interface ClassifyResult {
  label: ReplyClassification;
  wantsMeeting: boolean;
  summary: string;
  suggestedReply: string;
}

/** Map a reply classification to the granular event type we store + score. */
const CLASSIFICATION_EVENT: Record<ReplyClassification, EventType> = {
  positive: "positive_reply",
  negative: "negative_reply",
  neutral: "neutral_reply",
  out_of_office: "out_of_office",
  not_interested: "negative_reply",
  request_info: "request_info",
};

export async function classifyReply(text: string): Promise<ClassifyResult> {
  if (!worker.configured) {
    return { label: "neutral", wantsMeeting: false, summary: text.slice(0, 120), suggestedReply: "" };
  }
  try {
    const { system, user } = buildReplyClassifyPrompt(text);
    const res = await worker.completeJSON<ClassifyResult>(user, { system, temperature: 0.1 });
    return res;
  } catch (err) {
    log.error("classify failed", err);
    return { label: "neutral", wantsMeeting: false, summary: text.slice(0, 120), suggestedReply: "" };
  }
}

/**
 * Ingest an inbound reply: classify it, record events, stop the sequence as
 * appropriate, and notify a human. Entry point for the reply webhook, an IMAP
 * poller, or a manual CLI ingest.
 */
export async function handleInboundReply(args: {
  fromEmail: string;
  text: string;
  messageId?: string;
}): Promise<{ classification: ReplyClassification; leadId?: string }> {
  const lead = await LeadsRepo.getByEmail(args.fromEmail);
  if (!lead) {
    log.warn(`reply from unknown lead ${args.fromEmail}`);
    return { classification: "neutral" };
  }

  // Resolve the campaign/enrollment via the message it replies to, if known.
  let campaignId: string | undefined;
  let enrollmentId: string | undefined;
  if (args.messageId) {
    const msg = await MessagesRepo.getById(args.messageId);
    if (msg) {
      campaignId = msg.campaignId;
      enrollmentId = msg.enrollmentId;
    }
  }

  const result = await classifyReply(args.text);

  // Always record a base "reply" event (strong signal) + the granular one.
  await EventsRepo.record({
    leadId: lead._id,
    type: "reply",
    campaignId,
    enrollmentId,
    messageId: args.messageId,
    metadata: { text: args.text, ...result },
  });
  await EventsRepo.record({
    leadId: lead._id,
    type: CLASSIFICATION_EVENT[result.label],
    campaignId,
    enrollmentId,
    messageId: args.messageId,
    metadata: { summary: result.summary, suggestedReply: result.suggestedReply },
  });

  await applyReplyOutcome(lead, result);
  await notifyReply(lead, result.label, result.summary);
  log.info(`reply from ${lead.email} classified ${result.label}`);
  return { classification: result.label, leadId: lead._id };
}

async function applyReplyOutcome(lead: Lead, result: ClassifyResult): Promise<void> {
  switch (result.label) {
    case "out_of_office":
      // Auto-reply — keep the sequence running.
      return;
    case "not_interested":
    case "negative":
      await EnrollmentsRepo.stopAllForLead(lead._id, "stopped", "not interested");
      await LeadsRepo.setStatus(lead._id, "do_not_contact");
      return;
    case "positive":
    case "request_info":
    case "neutral":
    default:
      // A human takes over — pause the automated sequence.
      await EnrollmentsRepo.stopAllForLead(lead._id, "replied", `reply: ${result.label}`);
      await LeadsRepo.setStatus(lead._id, "replied");
      return;
  }
}
