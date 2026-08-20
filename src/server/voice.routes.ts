import { Router, type Request, type Response } from "express";
import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { CallsRepo, CampaignsRepo, EventsRepo, LeadsRepo } from "../repositories/index.js";
import { validateTwilioSignature, signatureValidationReady, escapeXml } from "../services/voice/twilio.telephony.js";
import { buildVoicemailScript } from "../services/voice/script.js";
import { analyzeCall } from "../services/voice/call-analysis.service.js";
import type { CallStatus } from "../models/types.js";

const log = createLogger("voice:routes");

/** Public wss:// URL the carrier should stream this call's audio to. */
export function mediaStreamUrl(callId: string): string {
  const base = config.tracking.baseURL.replace(/^http/, "ws");
  return `${base}/voice/media/${callId}`;
}

export function answerUrl(callId: string): string {
  return `${config.tracking.baseURL}/voice/answer/${callId}`;
}

export function statusUrl(callId: string): string {
  return `${config.tracking.baseURL}/voice/status/${callId}`;
}

/** Twilio call status → our CallStatus. */
function mapStatus(twilio: string): CallStatus | undefined {
  switch (twilio) {
    case "queued":
    case "initiated":
    case "ringing":
      return "dialing";
    case "in-progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "busy":
      return "busy";
    case "no-answer":
      return "no_answer";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Reject anything that isn't a genuine Twilio webhook.
 *
 * These URLs are public and start or steer live phone calls, so an unsigned
 * request is refused rather than merely logged. Validation can be turned off
 * (`TWILIO_VALIDATE_SIGNATURE=false`) for local tunnels where the public URL
 * Twilio signs doesn't match the one Express sees.
 */
function verified(req: Request, res: Response): boolean {
  if (!config.voice.twilio.validateSignature) return true;

  // Distinguish "we cannot check" from "the check failed" — otherwise a missing
  // auth token looks identical to an attack, and every call dies unexplained.
  const ready = signatureValidationReady();
  if (!ready.ready) {
    log.error(`cannot verify Twilio webhooks — every call will be rejected. ${ready.reason}`);
    res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
    return false;
  }

  const url = `${config.tracking.baseURL}${req.originalUrl}`;
  if (validateTwilioSignature(req.get("x-twilio-signature"), url, req.body ?? {})) return true;
  log.warn(`rejected unsigned voice webhook: ${req.originalUrl}`);
  res.status(403).type("text/xml").send("<Response><Hangup/></Response>");
  return false;
}

export function createVoiceRouter(): Router {
  const router = Router();

  /**
   * Is the voice channel live *on the host Twilio will call*?
   *
   * `/health` only proves something is listening. This proves the running build
   * actually has the voice routes and media socket mounted — the difference
   * between a working call and a prospect hearing silence because the deployed
   * code predates this channel.
   */
  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      voiceEnabled: config.voice.enabled,
      model: config.voice.realtime.model,
      voice: config.voice.realtime.voice,
      mediaStream: mediaStreamUrl(":callId"),
      dryRun: config.sending.dryRun,
    });
  });

  /**
   * Answer webhook. Twilio fetches this the instant the call connects and does
   * whatever the returned TwiML says.
   *
   * Answering machines get the voicemail script instead of a conversation:
   * a speech-to-speech agent talking to a beep wastes a metered session and
   * leaves nothing useful behind.
   */
  router.post("/answer/:callId", async (req: Request, res: Response) => {
    if (!verified(req, res)) return;
    const { callId } = req.params;
    res.type("text/xml");

    try {
      const call = await CallsRepo.getById(callId);
      if (!call) return res.send("<Response><Hangup/></Response>");

      const answeredBy = String(req.body?.AnsweredBy ?? "");
      if (answeredBy.startsWith("machine")) {
        const lead = await LeadsRepo.getById(call.leadId);
        const campaign = call.campaignId ? await CampaignsRepo.getById(call.campaignId) : null;
        const script = lead
          ? buildVoicemailScript({ lead, campaign: campaign ?? undefined })
          : "Sorry to have missed you — I'll follow up by email.";
        await CallsRepo.setAnalysis(callId, { outcome: "voicemail", summary: "Answering machine — voicemail left." });
        await CallsRepo.setStatus(callId, "completed", { endedAt: new Date() });
        await EventsRepo.record({
          leadId: call.leadId,
          campaignId: call.campaignId,
          type: "call_voicemail",
          metadata: { callId },
        });
        log.info(`voicemail left for call ${callId}`);
        return res.send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say voice="Polly.Matthew">` +
            `${escapeXml(script)}</Say><Hangup/></Response>`,
        );
      }

      // A human picked up: hand the audio to the bridge.
      return res.send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>` +
          `<Stream url="${escapeXml(mediaStreamUrl(callId))}"/></Connect></Response>`,
      );
    } catch (err) {
      log.error("answer webhook failed", err);
      return res.send("<Response><Hangup/></Response>");
    }
  });

  /** Call lifecycle callbacks — the source of truth for calls that never connected. */
  router.post("/status/:callId", async (req: Request, res: Response) => {
    if (!verified(req, res)) return;
    const { callId } = req.params;
    try {
      const call = await CallsRepo.getById(callId);
      if (!call) return res.status(404).json({ error: "unknown call" });

      const status = mapStatus(String(req.body?.CallStatus ?? ""));
      const durationSec = Number(req.body?.CallDuration ?? 0) || call.durationSec;
      const recordingUrl = req.body?.RecordingUrl ? String(req.body.RecordingUrl) : undefined;

      if (status) {
        // The bridge owns the completed transition for calls it actually ran —
        // it has the transcript. Only take it here for legs that never got there.
        const bridgeOwns = status === "completed" && call.transcript.length > 0;
        if (!bridgeOwns) {
          await CallsRepo.setStatus(callId, status, {
            durationSec,
            recordingUrl,
            endedAt: ["completed", "busy", "no_answer", "failed"].includes(status) ? new Date() : undefined,
          });
        }

        if (status === "no_answer" || status === "busy") {
          await EventsRepo.record({
            leadId: call.leadId,
            campaignId: call.campaignId,
            type: "call_no_answer",
            metadata: { callId, twilioStatus: req.body?.CallStatus },
          });
          // Drives the retry ladder even though there's no transcript to grade.
          await analyzeCall(callId).catch((err) => log.error("no-answer analysis failed", err));
        }
      }
      return res.json({ ok: true });
    } catch (err) {
      log.error("status webhook failed", err);
      return res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}
