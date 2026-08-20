import type WebSocket from "ws";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { CallsRepo, CampaignsRepo, LeadsRepo, PlaybookRepo } from "../../repositories/index.js";
import { buildCallInstructions } from "./script.js";
import { buildCallTools } from "./call-tools.js";
import { openRealtimeSession, realtimeConfigured } from "./openai-realtime.js";
import { getTelephony } from "./twilio.telephony.js";
import { analyzeCall } from "./call-analysis.service.js";
import { createHumanizer } from "./audio-filter.js";
import type { RealtimeSession } from "./voice.interface.js";

const log = createLogger("voice:bridge");

/**
 * The bridge: carrier audio ⇄ speech-to-speech model.
 *
 * Twilio opens a websocket to us and streams base64 G.711 μ-law frames; the
 * realtime session speaks the same encoding, so this class is mostly plumbing
 * plus the three things that plumbing can't be trusted to the model for:
 *
 *   • barge-in — when the prospect talks, already-queued agent audio is dropped
 *     at the carrier, not just cancelled at the model, or they'd talk over each
 *     other for however many seconds are sitting in Twilio's buffer;
 *   • the ask ceiling — counted in code, because a model asked to "ask at most
 *     three times" will cheerfully ask five;
 *   • the wall clock — a hard hangup so a wedged session can't hold an open
 *     line, and with it a metered realtime connection, indefinitely.
 */

/** Words that make an agent turn an actual ask for the meeting. */
const ASK_PATTERN =
  /\b(does|would|how(?:'s| is| about)?|can we|shall we|are you|is)\b[^?]*\b(tuesday|wednesday|thursday|friday|monday|morning|afternoon|tomorrow|next week|work for you|calendar|call|chat|meeting|minutes)\b[^?]*\?/i;

/** Grace period so the closing sentence actually plays before the line drops. */
const HANGUP_GRACE_MS = 3_000;

/**
 * G.711 μ-law at 8kHz is exactly 8000 bytes per second, so a frame's byte count
 * IS its duration. That arithmetic is how the bridge knows whether the agent is
 * still audibly speaking — the model's own "response finished" event fires while
 * the carrier is still playing, because generation outruns realtime.
 */
const MULAW_BYTES_PER_MS = 8;

interface TwilioFrame {
  event: string;
  streamSid?: string;
  media?: { payload?: string };
  start?: { streamSid?: string; customParameters?: Record<string, string> };
}

export async function handleMediaStream(ws: WebSocket, callId: string): Promise<void> {
  // Twilio starts streaming the moment the socket opens, while setup below is
  // still awaiting the database and a credential refresh. Attach the listener
  // FIRST and queue whatever arrives, or the `start` frame — which carries the
  // streamSid we need to send any audio back — can be gone before we look.
  const queued: WebSocket.RawData[] = [];
  let onFrame: (raw: WebSocket.RawData) => void = (raw) => queued.push(raw);
  ws.on("message", (raw: WebSocket.RawData) => onFrame(raw));

  const call = await CallsRepo.getById(callId);
  if (!call) {
    log.warn(`media stream for unknown call ${callId}`);
    ws.close();
    return;
  }
  const lead = await LeadsRepo.getById(call.leadId);
  if (!lead) {
    log.warn(`call ${callId} has no lead`);
    ws.close();
    return;
  }
  if (!realtimeConfigured()) {
    log.error("realtime voice is not configured — dropping the call");
    ws.close();
    return;
  }

  const campaign = call.campaignId ? (await CampaignsRepo.getById(call.campaignId)) ?? undefined : undefined;
  const notes = await PlaybookRepo.list(8).catch(() => []);
  const priorCalls = await CallsRepo.recentForLead(call.leadId, 3);
  const prior = priorCalls.find((c) => c._id !== callId && c.summary);

  const instructions = buildCallInstructions({
    lead,
    campaign,
    notes,
    attempt: call.attempt,
    priorCallSummary: prior?.summary,
  });

  let streamSid: string | undefined;
  let session: RealtimeSession | undefined;
  let ended = false;
  let askCount = 0;
  const startedAt = Date.now();
  /** When the audio already handed to Twilio will finish playing. */
  let playbackEndsAt = 0;

  // Optional timbre treatment on outbound audio (comfort noise + presence).
  // Null when disabled, so the hot path stays a straight passthrough.
  const humanizer = createHumanizer({
    enabled: config.voice.humanize.enabled,
    comfortNoiseDb: config.voice.humanize.comfortNoiseDb,
    driveDb: config.voice.humanize.driveDb,
    clarityDb: config.voice.humanize.clarityDb,
    compressPauses: config.voice.humanize.compressPauses,
    pauseKeepMs: config.voice.humanize.pauseKeepMs,
    pauseThresholdDb: config.voice.humanize.pauseThresholdDb,
    fastStart: config.voice.humanize.fastStart,
    fastStartMs: config.voice.humanize.fastStartMs,
    fastStartRate: config.voice.humanize.fastStartRate,
  });

  const sendToCarrier = (payload: Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  /** Tear everything down exactly once, then classify what happened. */
  const finish = async (reason: string, hangUpCarrier: boolean): Promise<void> => {
    if (ended) return;
    ended = true;
    clearTimeout(hardStop);
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    log.info(`call ${callId} ending after ${durationSec}s: ${reason}`);

    session?.close();
    if (hangUpCarrier && call.providerCallId) {
      await getTelephony()
        .hangup(call.providerCallId)
        .catch((err) => log.warn(`hangup failed for ${call.providerCallId}`, err));
    }
    try {
      ws.close();
    } catch {
      /* already closing */
    }

    await CallsRepo.setStatus(callId, "completed", {
      endedAt: new Date(),
      durationSec,
      failureReason: reason.startsWith("error") ? reason : undefined,
    });
    await analyzeCall(callId).catch((err) => log.error(`analysis failed for ${callId}`, err));
  };

  // Wall-clock ceiling. Warn the agent first so it can close cleanly, then cut.
  const hardStop = setTimeout(() => {
    session?.nudge(
      "You are out of time. Wrap up in one sentence — either confirm the meeting or thank them and say goodbye — then call end_call.",
    );
    setTimeout(() => void finish("max call duration reached", true), 12_000);
  }, config.voice.dialing.maxCallSeconds * 1000);

  const tools = buildCallTools({
    call,
    lead,
    campaign,
    hangup: async (reason) => {
      // Let the goodbye finish playing out of the carrier's buffer first.
      setTimeout(() => void finish(reason, true), HANGUP_GRACE_MS);
    },
    transfer: config.voice.transferNumber
      ? async (toNumber) => {
          if (!call.providerCallId) throw new Error("no provider call id to transfer");
          await getTelephony().transfer(call.providerCallId, toNumber);
          // The carrier now owns the leg; drop ours without hanging up on them.
          setTimeout(() => void finish("transferred to human", false), HANGUP_GRACE_MS);
        }
      : undefined,
  });

  session = await openRealtimeSession({
    instructions,
    tools,
    greetFirst: true,
    callbacks: {
      onAudio: (payload) => {
        if (!streamSid) return;
        const frame = Buffer.from(payload, "base64");
        const outFrame = humanizer ? humanizer.process(frame) : frame;
        if (outFrame.length === 0) return;
        const out = outFrame.toString("base64");
        // Extend the playback clock by this frame's duration, starting from now
        // if the previous audio already drained.
        playbackEndsAt = Math.max(playbackEndsAt, Date.now()) + outFrame.length / MULAW_BYTES_PER_MS;
        sendToCarrier({ event: "media", streamSid, media: { payload: out } });
      },
      onInterrupt: () => {
        // Only a barge-in if we are actually still talking. Otherwise this is
        // just the prospect starting their turn normally, and flushing the
        // carrier buffer would chop off audio nobody was talking over.
        if (!streamSid || Date.now() >= playbackEndsAt) return;
        sendToCarrier({ event: "clear", streamSid });
        session?.cancelResponse();
        // The buffer is gone, so nothing is playing any more.
        playbackEndsAt = 0;
        log.debug(`barge-in on call ${callId} — prospect spoke over the agent`);
      },
      onTranscript: (role, text) => {
        void CallsRepo.appendTurn(callId, { role, text, at: new Date() });
        if (role !== "agent") return;
        if (!ASK_PATTERN.test(text)) return;
        askCount++;
        void CallsRepo.incrementAsk(callId);
        if (askCount === config.voice.close.maxAsks) {
          session?.nudge(
            `That was ask number ${askCount} of ${config.voice.close.maxAsks}. If they say no again, accept it gracefully, ` +
              `offer send_followup_email, and end the call. Do not ask for the meeting again.`,
          );
        } else if (askCount > config.voice.close.maxAsks) {
          session?.nudge(
            "You have used all your asks. Stop asking for the meeting. Offer to send an email, thank them, and call end_call now.",
          );
        }
      },
      onError: (err) => log.error(`realtime error on call ${callId}`, err),
      onClose: () => {
        if (!ended) void finish("model session closed", true);
      },
    },
  });

  // Swap the queue for the real handler, then replay anything that arrived
  // during setup so the stream picks up exactly where it left off.
  onFrame = (raw: WebSocket.RawData) => {
    let frame: TwilioFrame;
    try {
      frame = JSON.parse(raw.toString()) as TwilioFrame;
    } catch {
      return;
    }
    switch (frame.event) {
      case "start":
        streamSid = frame.start?.streamSid ?? frame.streamSid;
        log.info(`media stream started for call ${callId} (${streamSid})`);
        void CallsRepo.setStatus(callId, "in_progress", { startedAt: new Date() });
        break;
      case "media":
        if (frame.media?.payload) session?.sendAudio(frame.media.payload);
        break;
      case "stop":
        void finish("carrier closed the stream", false);
        break;
      default:
        break;
    }
  };
  if (queued.length) log.debug(`replaying ${queued.length} frames buffered during setup`);
  for (const raw of queued.splice(0)) onFrame(raw);

  ws.on("close", () => {
    if (!ended) void finish("prospect hung up", false);
  });
  ws.on("error", (err: Error) => {
    log.error(`media socket error on call ${callId}`, err);
    if (!ended) void finish(`error: ${err.message}`, true);
  });
}
