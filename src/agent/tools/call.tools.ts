import { schema, type Tool } from "./types.js";
import { config } from "../../config/index.js";
import { CallsRepo, LeadsRepo } from "../../repositories/index.js";
import { queueCall } from "../../workers/dialer.js";
import { addToDnc, canCall, normalizePhone } from "../../services/voice/compliance.service.js";
import { OBJECTIONS } from "../../services/voice/objections.js";

const DAY_MS = 86_400_000;

/**
 * The phone channel, exposed to the strategist.
 *
 * `queue_calls` is high-risk and therefore approval-gated: it spends carrier and
 * realtime money, and it puts an AI voice in front of a human being who did not
 * ask for it — the least reversible thing this system does. Everything else here
 * is read-only, except `add_to_dnc`, which is low-risk precisely because it only
 * ever REMOVES someone from contact.
 */

export const queueCalls: Tool = {
  name: "queue_calls",
  description:
    "Queue outbound AI cold calls to specific leads (by email). The dialer places them inside the calling window, " +
    "respecting do-not-call, per-lead attempt limits, concurrency and the daily cap. Use for hot leads that have " +
    "engaged by email but not replied — calling a cold, unengaged list burns the number and the brand.",
  risk: "high",
  parameters: schema(
    {
      emails: { type: "array", items: { type: "string" }, description: "Lead emails to call" },
      campaignId: { type: "string", description: "Attribute the calls to this campaign" },
      reason: { type: "string", description: "Why these leads are worth a call right now" },
    },
    ["emails", "reason"],
  ),
  async run(args: { emails: string[]; campaignId?: string; reason: string }) {
    if (!config.voice.enabled) {
      return { error: "voice channel is off — ask the operator to set VOICE_ENABLED=true" };
    }
    const emails = (args.emails ?? []).slice(0, 25);
    const queued: string[] = [];
    const rejected: Array<{ email: string; reason: string }> = [];

    for (const email of emails) {
      const lead = await LeadsRepo.getByEmail(email);
      if (!lead) {
        rejected.push({ email, reason: "no such lead" });
        continue;
      }
      const res = await queueCall({ leadId: lead._id, campaignId: args.campaignId });
      if (res.queued) queued.push(email);
      else rejected.push({ email, reason: res.reason ?? "rejected" });
    }

    return {
      queued: queued.length,
      queuedEmails: queued,
      rejected,
      note: `Calls dial inside ${config.voice.dialing.windowStartHour}:00–${config.voice.dialing.windowEndHour}:00 in each lead's local time.`,
    };
  },
};

export const getCallMetrics: Tool = {
  name: "get_call_metrics",
  description:
    "Outcomes of the AI calling channel: connect rate, booking rate, and which objections keep coming up. " +
    "The objection histogram is the highest-signal input for rewriting the pitch.",
  risk: "low",
  parameters: schema({ days: { type: "number", description: "Lookback window (default 7)" } }),
  async run(args: { days?: number }) {
    const since = new Date(Date.now() - (args.days ?? 7) * DAY_MS);
    const [statuses, outcomes, objections] = await Promise.all([
      CallsRepo.statusCounts(since),
      CallsRepo.outcomeCounts(since),
      CallsRepo.objectionCounts(since),
    ]);

    const dialed = Object.entries(statuses)
      .filter(([k]) => k !== "queued" && k !== "skipped" && k !== "canceled")
      .reduce((n, [, v]) => n + v, 0);
    const conversations = (outcomes.interested ?? 0) + (outcomes.not_interested ?? 0) +
      (outcomes.meeting_booked ?? 0) + (outcomes.callback_requested ?? 0) + (outcomes.not_a_fit ?? 0);
    const booked = outcomes.meeting_booked ?? 0;
    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);

    return {
      windowDays: args.days ?? 7,
      dialed,
      statuses,
      outcomes,
      objections,
      rates: {
        connectPct: pct(conversations, dialed),
        bookedPerDialedPct: pct(booked, dialed),
        bookedPerConversationPct: pct(booked, conversations),
        dncCount: outcomes.do_not_call ?? 0,
      },
      topObjection: Object.keys(objections)[0] ?? null,
      note:
        "bookedPerConversationPct is the pitch quality number; connectPct is a list/timing number. " +
        "A high do_not_call count means the targeting or the opener is wrong — fix it before dialing more.",
    };
  },
};

export const listCalls: Tool = {
  name: "list_calls",
  description: "Recent calls with their outcome, objections and summary — read transcripts of what actually happened.",
  risk: "low",
  parameters: schema({
    status: { type: "string", description: "Filter: queued|dialing|in_progress|completed|no_answer|failed|skipped" },
    campaignId: { type: "string" },
    limit: { type: "number", description: "Default 20" },
  }),
  async run(args: { status?: string; campaignId?: string; limit?: number }) {
    const calls = await CallsRepo.list(
      { status: args.status as never, campaignId: args.campaignId },
      Math.min(args.limit ?? 20, 50),
    );
    const rows = [];
    for (const c of calls) {
      const lead = await LeadsRepo.getById(c.leadId);
      rows.push({
        callId: c._id,
        lead: lead?.email ?? c.leadId,
        company: lead?.company,
        status: c.status,
        outcome: c.outcome,
        attempt: c.attempt,
        durationSec: c.durationSec,
        asks: c.askCount,
        objections: c.objections,
        summary: c.summary,
        nextAction: c.nextAction,
        failureReason: c.failureReason,
        at: c.createdAt,
      });
    }
    return { calls: rows };
  },
};

export const getCallTranscript: Tool = {
  name: "get_call_transcript",
  description:
    "Full turn-by-turn transcript of one call. Use it to diagnose WHY a pitch failed before proposing a new script.",
  risk: "low",
  parameters: schema({ callId: { type: "string" } }, ["callId"]),
  async run(args: { callId: string }) {
    const call = await CallsRepo.getById(args.callId);
    if (!call) return { error: "call not found" };
    const lead = await LeadsRepo.getById(call.leadId);
    return {
      lead: lead?.email,
      outcome: call.outcome,
      objections: call.objections,
      askCount: call.askCount,
      durationSec: call.durationSec,
      summary: call.summary,
      transcript: call.transcript.map((t) => `${t.role.toUpperCase()}: ${t.text}`),
    };
  },
};

export const checkCallEligibility: Tool = {
  name: "check_call_eligibility",
  description:
    "Dry-run the compliance gate for one lead: is there a usable number, are they on the DNC list, is it a legal hour " +
    "in their timezone, have we already called too many times? Use before proposing a calling push.",
  risk: "low",
  parameters: schema({ email: { type: "string" } }, ["email"]),
  async run(args: { email: string }) {
    const lead = await LeadsRepo.getByEmail(args.email);
    if (!lead) return { error: "lead not found" };
    const gate = await canCall(lead);
    const history = await CallsRepo.recentForLead(lead._id, 5);
    return {
      email: lead.email,
      phone: lead.phone ?? null,
      timezone: lead.timezone ?? "(server default)",
      allowed: gate.allowed,
      blockedBy: gate.reason ?? null,
      detail: gate.detail ?? null,
      priorCalls: history.map((c) => ({ at: c.createdAt, status: c.status, outcome: c.outcome })),
    };
  },
};

export const addToDncTool: Tool = {
  name: "add_to_dnc",
  description:
    "Put a phone number permanently beyond reach of the dialer and cancel any queued calls for that lead. " +
    "Low-risk by design: it can only ever stop contact, never start it.",
  risk: "low",
  parameters: schema(
    { phone: { type: "string" }, reason: { type: "string" } },
    ["phone", "reason"],
  ),
  async run(args: { phone: string; reason: string }) {
    const normalized = normalizePhone(args.phone);
    if (!normalized) return { ok: false, error: "could not parse that into a phone number" };
    // Match the lead so their queued calls get cancelled too, not just the number blocked.
    const lead = await LeadsRepo.getByPhone(normalized);
    await addToDnc(normalized, args.reason, "agent", lead?._id);
    return { ok: true, number: normalized, lead: lead?.email ?? null };
  },
};

export const getObjectionPlaybook: Tool = {
  name: "get_objection_playbook",
  description:
    "The objection codes the call agent is trained on and how it's told to handle each. Read this before proposing " +
    "pitch changes, so a new instruction doesn't contradict what the agent already does.",
  risk: "low",
  parameters: schema({}),
  async run() {
    return {
      objections: OBJECTIONS.map((o) => ({ code: o.code, cue: o.cue, response: o.response })),
      closeLadder: {
        maxAsks: config.voice.close.maxAsks,
        meetingMinutes: config.voice.close.meetingMinutes,
        note: "The ask counter is enforced in code, not by the model — the bridge cuts it off at the ceiling.",
      },
    };
  },
};
