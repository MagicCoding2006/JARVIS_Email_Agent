import { createLogger } from "../lib/logger.js";
import { worker } from "../llm/roles.js";
import { buildReplyDraftPrompt } from "../llm/prompts.js";
import { CampaignsRepo, EventsRepo, LeadsRepo, MessagesRepo } from "../repositories/index.js";
import { requestApproval } from "../agent/approvals.js";
import type { Event } from "../models/types.js";

const log = createLogger("reply-drafts");

const LOOKBACK_DAYS = 7;

/**
 * Turn fresh positive/info-request replies into ready-to-send response drafts,
 * each queued as a Telegram approval (✅ sends via the send_reply tool). Runs
 * on a short cron so a hot reply gets a draft within minutes, while staying a
 * batch job (one worker-LLM call per reply, zero when there are none).
 */
export async function processReplyDrafts(): Promise<{ drafted: number; skipped: number }> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const events = await EventsRepo.findRepliesNeedingDraft(since);
  let drafted = 0;
  let skipped = 0;

  for (const event of events) {
    let approvalId: string | null = null;
    try {
      approvalId = await draftOne(event);
    } catch (err) {
      log.error(`draft failed for event ${event._id}`, err);
    }
    if (approvalId) drafted++;
    else skipped++;
    // Mark even skipped events so we don't re-attempt them every run.
    await EventsRepo.setMetadataField(event._id, "draftApprovalId", approvalId ?? "skipped");
  }

  if (drafted || skipped) log.info(`reply drafts: ${drafted} queued, ${skipped} skipped`);
  return { drafted, skipped };
}

async function draftOne(event: Event): Promise<string | null> {
  const lead = await LeadsRepo.getById(event.leadId);
  if (!lead || lead.unsubscribed || lead.bounced || lead.status === "do_not_contact") return null;

  const replyText = String(event.metadata.text ?? event.metadata.summary ?? "");
  if (!replyText) return null;

  // Thread context: the message they replied to, else our last sent to them.
  const prior = event.messageId
    ? await MessagesRepo.getById(event.messageId)
    : [...(await MessagesRepo.listForLead(lead._id))].reverse().find((m) => m.status === "sent") ?? null;
  const campaign = prior?.campaignId ? await CampaignsRepo.getById(prior.campaignId) : null;

  let body = "";
  if (worker.configured) {
    const { system, user } = buildReplyDraftPrompt({
      lead,
      replyText,
      classification: event.type,
      priorSubject: prior?.subject,
      priorBody: prior?.body,
      offer: campaign?.offer,
    });
    try {
      const out = await worker.completeJSON<{ body: string }>(user, { system, temperature: 0.5 });
      body = (out.body ?? "").trim();
    } catch (err) {
      log.error("reply draft LLM failed — falling back to classifier suggestion", err);
    }
  }
  // Fallback: the suggestion the classifier produced at ingest time.
  if (!body) body = String(event.metadata.suggestedReply ?? "").trim();
  if (!body) return null;

  const subject = prior
    ? prior.subject.toLowerCase().startsWith("re:")
      ? prior.subject
      : `Re: ${prior.subject}`
    : "Re: our conversation";

  const summary =
    `✉️ Reply draft — ${lead.name || lead.email}${lead.company ? ` (${lead.company})` : ""}\n` +
    `They said (${event.type}): ${String(event.metadata.summary ?? replyText).slice(0, 200)}\n\n` +
    `Draft:\n${body}\n\n` +
    `Approve to send from their thread's mailbox.`;

  const approval = await requestApproval("send_reply", { leadEmail: lead.email, body, subject }, summary);
  log.info(`queued reply draft for ${lead.email} (approval ${approval._id})`);
  return approval._id;
}
