import { schema, type Tool } from "./types.js";
import { config } from "../../config/index.js";
import { EventsRepo, LeadsRepo } from "../../repositories/index.js";
import { sendDirectToLead } from "../../services/direct-send.service.js";

/**
 * Send a response to a prospect who replied (or booked). Sends immediately
 * (reply latency kills deals — this does NOT wait for the dispatcher), threads
 * into the existing conversation from the lead's sticky mailbox, and records a
 * sent Message so mailbox/domain cap accounting still sees it.
 *
 * HIGH RISK: under semi/propose autonomy this queues as a Telegram approval
 * with the full draft body — the human taps ✅ and it sends.
 */
export const sendReply: Tool = {
  name: "send_reply",
  description:
    "Send a response email to a lead who REPLIED to us or BOOKED a meeting. Threads into the existing conversation from the same mailbox. " +
    "Refuses leads with no conversation on record. HIGH RISK — the full body is shown for approval before sending.",
  risk: "high",
  parameters: schema(
    {
      leadEmail: { type: "string", description: "The lead's email address" },
      body: { type: "string", description: "Plain-text response body (no footer — it's added automatically)" },
      subject: { type: "string", description: "Optional; defaults to Re: <our last subject to them>" },
    },
    ["leadEmail", "body"],
  ),
  async run(args: { leadEmail: string; body: string; subject?: string }) {
    const lead = await LeadsRepo.getByEmail(args.leadEmail);
    if (!lead) return { error: `lead not found: ${args.leadEmail}` };
    if (lead.unsubscribed || lead.bounced || lead.status === "do_not_contact") {
      return { error: "lead is not contactable (unsubscribed/bounced/DNC)" };
    }

    // This tool answers conversations; it is not a side-channel for cold sends.
    const events = await EventsRepo.recentForLead(lead._id, 50);
    if (!events.some((e) => e.type === "reply" || e.type === "booked")) {
      return { error: "no inbound reply or booking on record for this lead — use a campaign for outreach" };
    }

    const r = await sendDirectToLead(lead, {
      body: args.body,
      subject: args.subject,
      eventMetadata: { kind: "reply_response" },
    });
    if (!r.sent) return { error: r.error };
    return { sent: true, to: lead.email, from: r.from, subject: r.subject, dryRun: config.sending.dryRun };
  },
};
