import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { CallsRepo, EventsRepo, LeadsRepo } from "../../repositories/index.js";
import { sendDirectToLead } from "../direct-send.service.js";
import { calendlyEnabled, listMeetings } from "../calendly.service.js";
import { notify } from "../notifications.service.js";
import { addToDnc } from "./compliance.service.js";
import { getObjection } from "./objections.js";
import type { RealtimeTool } from "./voice.interface.js";
import type { Call, Campaign, Lead } from "../../models/types.js";

const log = createLogger("voice:tools");
const MIN = 60_000;

/**
 * The toolset the agent can reach FOR while the prospect is on the line.
 *
 * Note what is deliberately absent: nothing here spends money, changes a
 * campaign, sends a bulk anything, or touches another lead. That is the whole
 * reason these tools bypass the approval queue — a live call cannot wait for a
 * human to tap ✅ in Telegram, so instead of gating them at run time, the
 * toolset itself is kept to actions that are safe to take unattended. The
 * approval gate lives one level up, on the decision to *place* calls at all
 * (`queue_calls` is high-risk in the agent registry).
 */

export interface CallToolContext {
  call: Call;
  lead: Lead;
  campaign?: Campaign;
  /** Ends the phone leg. Provided by whoever owns the carrier connection. */
  hangup: (reason: string) => Promise<void>;
  /** Warm-transfer the leg to a human, when the provider supports it. */
  transfer?: (toNumber: string) => Promise<void>;
}

/** Next N business-day slots inside the calling window, skipping conflicts. */
async function proposeSlots(count = 3): Promise<Array<{ iso: string; spoken: string }>> {
  const { windowStartHour, windowEndHour } = config.voice.dialing;
  const busy = new Set<number>();

  if (calendlyEnabled()) {
    try {
      const meetings = await listMeetings(new Date(), new Date(Date.now() + 10 * 86_400_000));
      for (const m of meetings) {
        if (m.status === "active") busy.add(Math.floor(m.startTime.getTime() / (30 * MIN)));
      }
    } catch (err) {
      // A calendar outage must not stop the close — fall back to open slots.
      log.warn("calendly availability lookup failed; proposing default slots", err);
    }
  }

  const slots: Array<{ iso: string; spoken: string }> = [];
  const cursor = new Date();
  cursor.setMinutes(0, 0, 0);
  // Never propose the next 90 minutes — nobody books a meeting they can't prepare for.
  cursor.setHours(cursor.getHours() + 2);

  for (let guard = 0; guard < 240 && slots.length < count; guard++) {
    const hour = cursor.getHours();
    const day = cursor.getDay();
    const usable =
      hour >= windowStartHour && hour < windowEndHour && (config.voice.dialing.callOnWeekends || (day !== 0 && day !== 6));
    if (usable && !busy.has(Math.floor(cursor.getTime() / (30 * MIN)))) {
      slots.push({
        iso: cursor.toISOString(),
        spoken: cursor.toLocaleString("en-US", {
          weekday: "long",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }),
      });
      // Space proposals apart so the two options don't sit back to back.
      cursor.setHours(cursor.getHours() + 4);
    } else {
      cursor.setHours(cursor.getHours() + 1);
    }
  }
  return slots;
}

function bookingLine(): string {
  return config.booking.url ? `\n\nYou can also grab a different time here: ${config.booking.url}` : "";
}

export function buildCallTools(ctx: CallToolContext): RealtimeTool[] {
  const { call, lead } = ctx;

  const checkAvailability: RealtimeTool = {
    name: "check_availability",
    description:
      "Get real open meeting times to offer. Call this BEFORE proposing any time. Returns slots you may offer verbatim.",
    parameters: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many slots to return (default 3)" },
      },
      required: [],
    },
    async run(args) {
      const slots = await proposeSlots(Number(args.count) || 3);
      return {
        slots,
        meetingMinutes: config.voice.close.meetingMinutes,
        instruction: "Offer exactly two of these as an either/or question. Do not invent other times.",
      };
    },
  };

  const bookMeeting: RealtimeTool = {
    name: "book_meeting",
    description:
      "Lock in the meeting the moment the prospect agrees to a specific time. Confirm their email out loud first. " +
      "Sends the confirmation email and alerts the human rep.",
    parameters: {
      type: "object",
      properties: {
        slotIso: { type: "string", description: "ISO 8601 start time they agreed to" },
        spokenTime: { type: "string", description: "How you said it out loud, e.g. 'Tuesday at 10am'" },
        email: { type: "string", description: "Email they confirmed for the invite" },
        notes: { type: "string", description: "One line on what they want to cover" },
      },
      required: ["slotIso", "email"],
    },
    async run(args) {
      const email = String(args.email ?? lead.email).trim();
      const slotIso = String(args.slotIso ?? "");
      const spoken = String(args.spokenTime ?? slotIso);

      // Keep the email on file current — they just said it out loud.
      if (email && email.toLowerCase() !== lead.email.toLowerCase()) {
        await LeadsRepo.upsertByEmail({ email, name: lead.name, phone: lead.phone });
      }

      await CallsRepo.setAnalysis(call._id, { meetingTime: slotIso, outcome: "meeting_booked" });
      await EventsRepo.record({
        leadId: lead._id,
        campaignId: call.campaignId,
        enrollmentId: call.enrollmentId,
        type: "booked",
        metadata: {
          source: "voice",
          callId: call._id,
          meeting_time: slotIso,
          meeting_type: `${config.voice.close.meetingMinutes}-min intro call`,
          // The prospect agreed on the phone; the calendar invite follows by
          // email. Recorded plainly so the CRM isn't claiming a calendar write
          // that never happened.
          verbal_commitment: true,
          notes: String(args.notes ?? ""),
        },
      });

      const body =
        `Hi ${lead.firstName || lead.name || "there"},\n\n` +
        `Great speaking with you just now — confirming ${spoken} for a ${config.voice.close.meetingMinutes}-minute call ` +
        `with ${config.voice.repName}.` +
        `${args.notes ? `\n\nYou mentioned you wanted to cover: ${args.notes}` : ""}` +
        `${bookingLine()}\n\nTalk soon,\n${config.voice.repName}`;

      const sent = await sendDirectToLead({ ...lead, email }, {
        subject: `Confirmed: ${spoken}`,
        body,
        eventMetadata: { source: "voice_booking", callId: call._id },
      }).catch((err) => {
        log.error("confirmation email failed", err);
        return { sent: false, error: err instanceof Error ? err.message : String(err) };
      });

      log.info(`meeting booked on call ${call._id} for ${spoken}`);
      return {
        ok: true,
        confirmationEmailSent: sent.sent,
        say: `Confirm the time and that the invite is landing at ${email} right now, then wrap up warmly.`,
      };
    },
  };

  const sendFollowupEmail: RealtimeTool = {
    name: "send_followup_email",
    description:
      "Send the information they asked for, or a graceful parting note after a final no. Sends immediately.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "What they asked for, in their words" },
        subject: { type: "string" },
      },
      required: ["note"],
    },
    async run(args) {
      const body =
        `Hi ${lead.firstName || lead.name || "there"},\n\n` +
        `As promised on the phone — ${String(args.note ?? "here's the detail we discussed")}.` +
        `${bookingLine()}\n\nBest,\n${config.voice.repName}`;
      const sent = await sendDirectToLead(lead, {
        subject: String(args.subject ?? "Following up on our call"),
        body,
        eventMetadata: { source: "voice_followup", callId: call._id },
      });
      return { ok: sent.sent, say: "Tell them it's on its way and confirm the address is right." };
    },
  };

  const logObjection: RealtimeTool = {
    name: "log_objection",
    description: "Record an objection the prospect raised, so the pitch can be improved. Does not affect the call.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Objection code from the playbook" },
        quote: { type: "string", description: "Roughly what they said" },
      },
      required: ["code"],
    },
    async run(args) {
      const code = String(args.code ?? "").trim();
      if (!code) return { ok: false };
      await CallsRepo.addObjection(call._id, code);
      const known = getObjection(code);
      return {
        ok: true,
        // Feed the handling back so a mid-call reminder is one hop away.
        reminder: known?.response ?? "Acknowledge, reframe with new information, then ask again.",
      };
    },
  };

  const markNotInterested: RealtimeTool = {
    name: "mark_not_interested",
    description: "A clear, final no — but they did NOT ask to be removed. Ends the call politely.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: [],
    },
    async run(args) {
      await CallsRepo.setAnalysis(call._id, { outcome: "not_interested", nextAction: String(args.reason ?? "") });
      await EventsRepo.record({
        leadId: lead._id,
        campaignId: call.campaignId,
        type: "call_negative",
        metadata: { callId: call._id, reason: String(args.reason ?? "") },
      });
      return { ok: true, say: "Thank them for their time and say goodbye, then call end_call." };
    },
  };

  const markDoNotCall: RealtimeTool = {
    name: "mark_do_not_call",
    description:
      "They asked not to be contacted again. Call this IMMEDIATELY, before anything else, then apologize once and end the call.",
    parameters: { type: "object", properties: { quote: { type: "string" } }, required: [] },
    async run(args) {
      await addToDnc(call.toNumber, `requested on call ${call._id}`, "prospect", lead._id);
      await LeadsRepo.setStatus(lead._id, "do_not_contact");
      await CallsRepo.setAnalysis(call._id, { outcome: "do_not_call" });
      await EventsRepo.record({
        leadId: lead._id,
        campaignId: call.campaignId,
        type: "call_dnc",
        metadata: { callId: call._id, quote: String(args.quote ?? "") },
      });
      log.warn(`DNC requested by ${lead.email} on call ${call._id}`);
      return {
        ok: true,
        say: "Apologize once, confirm they won't be contacted again, say goodbye, then call end_call. Do not sell.",
      };
    },
  };

  const transferToHuman: RealtimeTool = {
    name: "transfer_to_human",
    description: "Hand the live call to a human rep. Only when they want a person right now and it's a real opportunity.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] },
    async run(args) {
      const target = config.voice.transferNumber;
      if (!target || !ctx.transfer) {
        return {
          ok: false,
          say: "Transfer isn't available. Offer to have someone call them back at a time they choose instead.",
        };
      }
      await notify({
        kind: "call_transfer",
        level: "hot",
        leadId: lead._id,
        title: `📞 Live transfer — ${lead.name || lead.email}`,
        body: `${lead.company ?? ""} asked for a human. Reason: ${String(args.reason ?? "n/a")}`,
      });
      await ctx.transfer(target);
      return { ok: true, say: "Tell them you're connecting them now." };
    },
  };

  const endCall: RealtimeTool = {
    name: "end_call",
    description: "Hang up. Call this once goodbyes are said — always end the call yourself rather than trailing off.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Why the call ended" } },
      required: [],
    },
    async run(args) {
      const reason = String(args.reason ?? "agent ended call");
      log.info(`agent ended call ${call._id}: ${reason}`);
      await ctx.hangup(reason);
      return { ok: true };
    },
  };

  return [
    checkAvailability,
    bookMeeting,
    sendFollowupEmail,
    logObjection,
    markNotInterested,
    markDoNotCall,
    transferToHuman,
    endCall,
  ];
}
