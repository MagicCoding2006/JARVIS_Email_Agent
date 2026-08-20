import { createLogger } from "../../lib/logger.js";
import { worker } from "../../llm/roles.js";
import { CallsRepo, EventsRepo, LeadsRepo } from "../../repositories/index.js";
import { notify } from "../notifications.service.js";
import { objectionCodes } from "./objections.js";
import { nextAttemptAt } from "./compliance.service.js";
import { config } from "../../config/index.js";
import type { Call, CallOutcome, EventType } from "../../models/types.js";

const log = createLogger("voice:analysis");

/**
 * What happened on the call, decided AFTER it ends.
 *
 * Nothing here runs per-utterance — the cost rule that governs the email side
 * governs this too. One cheap worker-LLM call per completed conversation turns
 * a transcript into the structured record the CRM, the scoring engine, and the
 * strategist all read. The in-call tools already wrote the decisive outcomes
 * (booked, DNC), so this pass exists to catch what the model didn't tag and to
 * grade the call rather than to drive it.
 */

const VALID_OUTCOMES: CallOutcome[] = [
  "meeting_booked",
  "callback_requested",
  "interested",
  "not_interested",
  "not_a_fit",
  "wrong_person",
  "gatekeeper",
  "voicemail",
  "no_answer",
  "do_not_call",
  "hung_up",
  "unknown",
];

interface AnalysisResult {
  outcome: CallOutcome;
  objections: string[];
  askCount: number;
  summary: string;
  nextAction: string;
  /** 1–5: how well the agent actually ran the call. Feeds script iteration. */
  agentGrade?: number;
  gradeReason?: string;
}

/** Outcome → the event the scoring engine and CRM react to. */
function eventForOutcome(outcome: CallOutcome): EventType | undefined {
  switch (outcome) {
    case "meeting_booked":
      return undefined; // book_meeting already recorded the shared `booked` event
    case "do_not_call":
      return "call_dnc";
    case "interested":
    case "callback_requested":
      return "call_positive";
    case "not_interested":
    case "not_a_fit":
      return "call_negative";
    case "voicemail":
      return "call_voicemail";
    case "no_answer":
      return "call_no_answer";
    default:
      return undefined;
  }
}

function transcriptText(call: Call): string {
  return call.transcript
    .map((t) => `${t.role === "agent" ? "AGENT" : "PROSPECT"}: ${t.text}`)
    .join("\n")
    .slice(0, 12_000);
}

/** Heuristic fallback so a missing/broken LLM never leaves a call unclassified. */
function fallbackAnalysis(call: Call): AnalysisResult {
  const said = transcriptText(call).toLowerCase();
  const prospectTurns = call.transcript.filter((t) => t.role === "prospect").length;
  let outcome: CallOutcome = "unknown";
  if (call.outcome) outcome = call.outcome;
  else if (prospectTurns === 0) outcome = call.status === "no_answer" ? "no_answer" : "voicemail";
  else if (/take me off|don'?t call|stop calling|remove me/.test(said)) outcome = "do_not_call";
  else if (/not interested|no thanks|we'?re good/.test(said)) outcome = "not_interested";
  else if (prospectTurns >= 3) outcome = "interested";

  return {
    outcome,
    objections: call.objections,
    askCount: call.askCount,
    summary: `Auto-classified without the model: ${prospectTurns} prospect turns, ${call.durationSec}s.`,
    nextAction: outcome === "interested" ? "Human follow-up recommended." : "No action.",
  };
}

export async function analyzeCall(callId: string): Promise<AnalysisResult | null> {
  const call = await CallsRepo.getById(callId);
  if (!call) return null;
  const lead = await LeadsRepo.getById(call.leadId);
  if (!lead) return null;

  let analysis: AnalysisResult;
  if (!worker.configured || call.transcript.length === 0) {
    analysis = fallbackAnalysis(call);
  } else {
    try {
      const raw = await worker.completeJSON<Partial<AnalysisResult>>(
        `Grade this outbound cold call and extract what happened.\n\n` +
          `The agent's goal was to book a ${config.voice.close.meetingMinutes}-minute meeting.\n\n` +
          `TRANSCRIPT\n${transcriptText(call)}\n\n` +
          `Tools the agent already fired during the call: ` +
          `${call.outcome ? `outcome=${call.outcome}; ` : ""}objections=[${call.objections.join(", ") || "none"}]\n\n` +
          `Return JSON with exactly these keys:\n` +
          `  outcome: one of ${VALID_OUTCOMES.join(" | ")}\n` +
          `  objections: array of codes from ${objectionCodes().join(" | ")} (only ones actually raised)\n` +
          `  askCount: integer — how many times the agent asked for the meeting\n` +
          `  summary: 1-2 sentences, what the prospect actually said and why it ended that way\n` +
          `  nextAction: one concrete next step for the human rep\n` +
          `  agentGrade: 1-5, how well the agent ran the call (5 = a strong rep)\n` +
          `  gradeReason: one sentence on what to fix in the script`,
        {
          system:
            "You are a sales manager reviewing call recordings. You are blunt, specific, and never inflate a grade. " +
            "Return only JSON.",
          temperature: 0.2,
          maxTokens: 700,
        },
      );

      const outcome = VALID_OUTCOMES.includes(raw.outcome as CallOutcome)
        ? (raw.outcome as CallOutcome)
        : fallbackAnalysis(call).outcome;
      const valid = new Set(objectionCodes());
      analysis = {
        outcome,
        objections: (raw.objections ?? []).filter((c) => valid.has(c)),
        askCount: Number.isFinite(raw.askCount) ? Number(raw.askCount) : call.askCount,
        summary: String(raw.summary ?? "").slice(0, 600),
        nextAction: String(raw.nextAction ?? "").slice(0, 300),
        agentGrade: Number.isFinite(raw.agentGrade) ? Number(raw.agentGrade) : undefined,
        gradeReason: raw.gradeReason ? String(raw.gradeReason).slice(0, 300) : undefined,
      };
    } catch (err) {
      log.error(`analysis failed for call ${callId}; using heuristics`, err);
      analysis = fallbackAnalysis(call);
    }
  }

  // A tool-set outcome is ground truth — the model watched a transcript, the
  // tool watched the actual booking — so it wins over anything inferred here.
  const decisive: CallOutcome[] = ["meeting_booked", "do_not_call"];
  if (call.outcome && decisive.includes(call.outcome)) analysis.outcome = call.outcome;

  // Union of what the agent tagged live and what the reviewer spotted.
  const objections = Array.from(new Set([...call.objections, ...analysis.objections]));

  await CallsRepo.setAnalysis(callId, {
    outcome: analysis.outcome,
    objections,
    askCount: analysis.askCount,
    summary: analysis.summary,
    nextAction: analysis.nextAction,
  });

  const evType = eventForOutcome(analysis.outcome);
  if (evType) {
    await EventsRepo.record({
      leadId: call.leadId,
      campaignId: call.campaignId,
      enrollmentId: call.enrollmentId,
      type: evType,
      metadata: {
        callId,
        outcome: analysis.outcome,
        objections,
        askCount: analysis.askCount,
        durationSec: call.durationSec,
        summary: analysis.summary,
        agentGrade: analysis.agentGrade ?? null,
        gradeReason: analysis.gradeReason ?? "",
      },
    });
  }

  // A human should hear about a live person who leaned in, today — not in the
  // Monday digest. Bookings already notify through the shared `booked` path.
  if (analysis.outcome === "interested" || analysis.outcome === "callback_requested") {
    await notify({
      kind: "call_outcome",
      level: "hot",
      leadId: call.leadId,
      title: `📞 Warm call — ${lead.name || lead.email}`,
      body:
        `${lead.company ?? ""} (${call.toNumber})\n${analysis.summary}\n` +
        `Next: ${analysis.nextAction}\nObjections: ${objections.join(", ") || "none"}`,
    });
  }

  // Retry ladder: a phone that never got answered earns another attempt at a
  // different hour, up to the configured cap.
  if (analysis.outcome === "no_answer" || analysis.outcome === "voicemail") {
    const attempts = await CallsRepo.countAttemptsForLead(call.leadId);
    if (attempts < config.voice.dialing.maxAttempts) {
      await CallsRepo.create({
        leadId: call.leadId,
        campaignId: call.campaignId,
        enrollmentId: call.enrollmentId,
        toNumber: call.toNumber,
        fromNumber: call.fromNumber,
        provider: call.provider,
        attempt: call.attempt + 1,
        scriptId: call.scriptId,
        scheduledAt: nextAttemptAt(call.attempt),
      });
      log.info(`queued attempt ${call.attempt + 1} for lead ${call.leadId}`);
    }
  }

  log.info(`call ${callId} → ${analysis.outcome} (grade ${analysis.agentGrade ?? "n/a"})`);
  return analysis;
}
