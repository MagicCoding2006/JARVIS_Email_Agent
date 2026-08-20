import WebSocket from "ws";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { resolveRealtimeAuth, logAuth, minutesUntil, requiredRunwayMinutes } from "./realtime-auth.js";
import type {
  RealtimeCallbacks,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeTool,
} from "./voice.interface.js";

const log = createLogger("voice:realtime");

/**
 * Speech-to-speech session over the OpenAI Realtime websocket.
 *
 * Two decisions worth knowing about:
 *
 * 1. **μ-law end to end.** The session is configured for G.711 μ-law at 8kHz —
 *    exactly what Twilio's media stream carries — so audio moves between the
 *    carrier and the model as opaque base64 with no resampling anywhere in this
 *    process. Transcoding is the usual source of both latency and robot voice.
 *
 * 2. **Both event schemas.** The realtime API's session shape changed between
 *    the beta (`realtime=v1`) and GA releases, and audio deltas arrive under
 *    different names in each. Outbound config follows `VOICE_REALTIME_SCHEMA`;
 *    inbound handling accepts either spelling, so a provider mid-migration
 *    doesn't produce a silent call.
 */

/** Audio deltas: GA spells it `output_audio`, the beta spelled it `audio`. */
const AUDIO_DELTA = new Set(["response.output_audio.delta", "response.audio.delta"]);
const AGENT_TRANSCRIPT_DONE = new Set([
  "response.output_audio_transcript.done",
  "response.audio_transcript.done",
]);

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: { message?: string; code?: string };
  [k: string]: unknown;
}

class OpenAIRealtimeSession implements RealtimeSession {
  private ws: WebSocket;
  private cb: RealtimeCallbacks;
  private toolsByName: Map<string, RealtimeTool>;
  private opts: RealtimeSessionOptions;
  private isClosed = false;
  /** Buffers audio captured before the socket finished opening. */
  private pending: string[] = [];
  private ready = false;

  constructor(ws: WebSocket, opts: RealtimeSessionOptions) {
    this.ws = ws;
    this.opts = opts;
    this.cb = opts.callbacks;
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));

    ws.on("open", () => this.onOpen());
    ws.on("message", (raw: WebSocket.RawData) => this.onMessage(raw));
    ws.on("error", (err: Error) => this.cb.onError(err));
    ws.on("close", (code: number, reason: Buffer) => {
      this.isClosed = true;
      log.info(`realtime socket closed (${code}) ${reason?.toString().slice(0, 120) ?? ""}`);
      this.cb.onClose();
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  private onOpen(): void {
    this.send({ type: "session.update", session: this.sessionConfig() });
    this.ready = true;
    for (const chunk of this.pending) this.send({ type: "input_audio_buffer.append", audio: chunk });
    this.pending = [];
    // On an outbound call the prospect just said "hello?" — we owe them the opener.
    if (this.opts.greetFirst !== false) this.send({ type: "response.create" });
  }

  /** The session shape differs between the GA and beta realtime APIs. */
  private sessionConfig(): Record<string, unknown> {
    const rt = config.voice.realtime;
    const schema = this.opts.schema ?? rt.schema;
    const tools = this.opts.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    // Semantic detection asks the model "are they done talking?" instead of
    // timing silence, so a prospect who pauses mid-thought isn't interrupted.
    const turnDetection =
      rt.turnDetection === "semantic"
        ? { type: "semantic_vad", eagerness: rt.semanticEagerness }
        : {
            type: "server_vad",
            threshold: rt.vadThreshold,
            prefix_padding_ms: rt.prefixPaddingMs,
            silence_duration_ms: rt.silenceMs,
          };
    const maxOutput = rt.maxOutputTokens > 0 ? rt.maxOutputTokens : "inf";
    // "none" means send no noise_reduction key at all — the API treats an
    // absent field as disabled, and a literal {"type":"none"} as invalid.
    const noiseReduction = rt.noiseReduction === "none" ? null : { type: rt.noiseReduction };

    if (schema === "beta") {
      return {
        modalities: ["audio", "text"],
        instructions: this.opts.instructions,
        voice: this.opts.voice ?? rt.voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: rt.transcriptionModel },
        ...(noiseReduction ? { input_audio_noise_reduction: noiseReduction } : {}),
        turn_detection: turnDetection,
        tools,
        tool_choice: "auto",
        max_response_output_tokens: maxOutput,
      };
    }

    return {
      type: "realtime",
      instructions: this.opts.instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          ...(noiseReduction ? { noise_reduction: noiseReduction } : {}),
          turn_detection: turnDetection,
          transcription: { model: rt.transcriptionModel },
        },
        output: { format: { type: "audio/pcmu" }, voice: this.opts.voice ?? rt.voice },
      },
      tools,
      tool_choice: "auto",
      max_output_tokens: maxOutput,
    };
  }

  private onMessage(raw: WebSocket.RawData): void {
    let ev: RealtimeEvent;
    try {
      ev = JSON.parse(raw.toString()) as RealtimeEvent;
    } catch {
      return;
    }

    if (AUDIO_DELTA.has(ev.type)) {
      if (ev.delta) this.cb.onAudio(ev.delta);
      return;
    }

    switch (ev.type) {
      // The prospect started talking. Report it and let the bridge decide
      // whether it counts as barging in.
      //
      // Deliberately NOT gated on `response.done` here: that event means the
      // model finished GENERATING, and generation runs faster than realtime, so
      // it arrives while the carrier is still playing the audio out. Gating on
      // it made the agent deaf to interruptions for the back half of every
      // sentence. Playback state lives in the bridge; ask it.
      case "input_audio_buffer.speech_started":
        this.cb.onInterrupt();
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript?.trim()) this.cb.onTranscript("prospect", ev.transcript.trim());
        return;

      case "session.updated":
      case "session.created":
        this.cb.onSessionUpdated?.((ev.session ?? {}) as Record<string, unknown>);
        return;

      case "response.function_call_arguments.done":
        void this.runTool(ev);
        return;

      case "error":
        this.cb.onError(new Error(ev.error?.message ?? "realtime error"));
        return;

      default:
        if (AGENT_TRANSCRIPT_DONE.has(ev.type) && ev.transcript?.trim()) {
          this.cb.onTranscript("agent", ev.transcript.trim());
        }
        return;
    }
  }

  /**
   * Run a tool the model called and hand the result back. Failures are reported
   * to the model as data rather than thrown: a booking API that 500s should make
   * the agent say "let me get that sorted by email", not kill the call.
   */
  private async runTool(ev: RealtimeEvent): Promise<void> {
    const tool = ev.name ? this.toolsByName.get(ev.name) : undefined;
    const callId = ev.call_id;
    if (!callId) return;

    let output: unknown;
    if (!tool) {
      output = { error: `unknown tool ${ev.name}` };
    } else {
      try {
        const args = ev.arguments ? (JSON.parse(ev.arguments) as Record<string, unknown>) : {};
        output = await tool.run(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`tool ${ev.name} failed`, err);
        output = { error: message };
      }
    }

    if (this.isClosed) return;
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    this.send({ type: "response.create" });
  }

  sendAudio(base64Mulaw: string): void {
    if (this.isClosed) return;
    if (!this.ready) {
      // Keep only a second or so of pre-connect audio; older frames are useless.
      if (this.pending.length < 50) this.pending.push(base64Mulaw);
      return;
    }
    this.send({ type: "input_audio_buffer.append", audio: base64Mulaw });
  }

  /** Stop the in-flight response. Safe to call when nothing is generating. */
  cancelResponse(): void {
    if (this.isClosed) return;
    this.send({ type: "response.cancel" });
  }

  nudge(instruction: string): void {
    if (this.isClosed) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: instruction }],
      },
    });
    this.send({ type: "response.create" });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}

export function realtimeConfigured(): boolean {
  return realtimeReadiness().ready;
}

/**
 * Live credential check — resolves an actual bearer, so it catches the failures
 * the static check cannot: a refused refresh, or a token with less life left
 * than a single call needs.
 */
export async function realtimeAuthCheck(): Promise<{
  ready: boolean;
  reason?: string;
  warning?: string;
  source?: string;
  minutesLeft?: number;
}> {
  const stat = realtimeReadiness();
  if (!stat.ready) return stat;
  try {
    const auth = await resolveRealtimeAuth();
    const minutesLeft = minutesUntil(auth.expiresAt);
    const runway = requiredRunwayMinutes();
    if (minutesLeft !== undefined && minutesLeft < runway) {
      return {
        ready: false,
        source: auth.source,
        minutesLeft,
        reason:
          `realtime credentials expire in ${minutesLeft} min, less than the ${runway} min a call may need — ` +
          `re-authenticate before dialing (a call must never outlive its own token)`,
      };
    }
    return {
      ready: true,
      source: auth.source,
      minutesLeft,
      warning: auth.warning ?? stat.warning,
    };
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Can we actually hold a conversation right now?
 *
 * Worth its own check because the failure it prevents is the worst one this
 * system can produce: dialing a real person, letting them say "hello?", and
 * answering with silence. The dialer calls this BEFORE placing a call, not
 * after someone picks up.
 *
 * The realtime API is a platform-API-key endpoint. A ChatGPT/Codex OAuth
 * harness cannot drive it, and neither can a GLM/z.ai key — so when the key is
 * being borrowed from `WORKER_API_KEY` and the worker is plainly not routed at
 * OpenAI, say so instead of failing mid-call with an auth error.
 */
export function realtimeReadiness(): { ready: boolean; reason?: string; warning?: string } {
  const rt = config.voice.realtime;
  // OAuth carries its own credentials file; the API-key checks below don't apply.
  if (rt.auth === "openai-oauth") return { ready: true };
  if (!rt.apiKey) {
    return {
      ready: false,
      reason:
        "no realtime credentials — set VOICE_REALTIME_API_KEY to an OpenAI platform API key " +
        "(the ChatGPT/Codex OAuth harness cannot drive the Realtime API)",
    };
  }

  const borrowed = !process.env.VOICE_REALTIME_API_KEY?.trim();
  const workerIsOpenAI =
    config.llm.worker.auth === "api-key" && /(^|\.)api\.openai\.com$/.test(hostOf(config.llm.worker.baseURL));
  if (borrowed && !workerIsOpenAI) {
    return {
      ready: true,
      warning:
        `realtime is falling back to WORKER_API_KEY, but the worker is routed at ` +
        `${hostOf(config.llm.worker.baseURL)} — that key will not authenticate against ` +
        `${hostOf(rt.baseURL)}. Set VOICE_REALTIME_API_KEY explicitly.`,
    };
  }
  return { ready: true };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Open a live voice session.
 *
 * Async because credentials are resolved per session — under `openai-oauth` that
 * means an actual refresh round trip, so a token renewed since process start is
 * picked up without a redeploy.
 */
export async function openRealtimeSession(opts: RealtimeSessionOptions): Promise<RealtimeSession> {
  const rt = config.voice.realtime;
  const auth = await resolveRealtimeAuth();
  logAuth(auth);

  const model = opts.model ?? rt.model;
  const schema = opts.schema ?? rt.schema;
  const url = `${rt.baseURL}?model=${encodeURIComponent(model)}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${auth.bearer}` };
  // The beta API gated realtime behind this header; GA ignores it.
  if (schema === "beta") headers["OpenAI-Beta"] = "realtime=v1";

  log.info(`opening realtime session (${model}, schema=${schema}, auth=${auth.source})`);
  return new OpenAIRealtimeSession(new WebSocket(url, { headers }), opts);
}
