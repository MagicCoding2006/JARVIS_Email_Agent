import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { buildCallInstructions } from "./script.js";
import { createHumanizer } from "./audio-filter.js";
import { openRealtimeSession, realtimeReadiness } from "./openai-realtime.js";
import type { RealtimeTool } from "./voice.interface.js";
import type { Campaign, Lead } from "../../models/types.js";

const log = createLogger("voice:preflight");

/**
 * Prove the voice channel works before it is pointed at a human being.
 *
 * Opens a real realtime session with the real call instructions and the real
 * tool schema, lets the agent deliver its opener, and writes the returned audio
 * to a WAV you can play. That single round trip exercises everything a live call
 * depends on except the carrier: credentials, model availability, session schema,
 * tool-definition validity, audio format, and what the agent actually says first.
 *
 * Cheap — a few seconds of audio — and it costs nobody a phone call.
 */

export interface PreflightResult {
  ok: boolean;
  model: string;
  schema: "ga" | "beta";
  voice: string;
  transcript: string;
  audioBytes: number;
  durationSec: number;
  wavPath?: string;
  error?: string;
  /** What the server said it applied — proof the audio settings weren't dropped. */
  applied?: AppliedSession;
  /** Local post-processing applied before writing the WAV. */
  humanizer?: AppliedHumanizer;
}

export interface AppliedHumanizer {
  enabled: boolean;
  comfortNoiseDb: number;
  driveDb: number;
  clarityDb: number;
  compressPauses: boolean;
  pauseKeepMs: number;
  pauseThresholdDb: number;
  fastStart: boolean;
  fastStartMs: number;
  fastStartRate: number;
}

export interface AppliedSession {
  voice?: string;
  inputFormat?: string;
  outputFormat?: string;
  transcriptionModel?: string;
  noiseReduction?: string;
  vadType?: string;
  /** semantic_vad only — how readily the model takes the turn. */
  eagerness?: string;
  vadThreshold?: number;
  prefixPaddingMs?: number;
  silenceMs?: number;
}

/** Pull the settings we care about out of either session shape. */
function readApplied(session: Record<string, unknown>): AppliedSession {
  const pick = (o: unknown, k: string): unknown =>
    o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  const fmt = (f: unknown): string | undefined =>
    typeof f === "string" ? f : (pick(f, "type") as string | undefined);

  // GA nests under audio.input/audio.output; the beta shape is flat.
  const audio = pick(session, "audio");
  const input = pick(audio, "input") ?? session;
  const output = pick(audio, "output") ?? session;
  const vad = pick(input, "turn_detection") ?? pick(session, "turn_detection");
  const nr = pick(input, "noise_reduction") ?? pick(session, "input_audio_noise_reduction");
  const transcription = pick(input, "transcription") ?? pick(session, "input_audio_transcription");

  return {
    voice: (pick(output, "voice") ?? pick(session, "voice")) as string | undefined,
    inputFormat: fmt(pick(input, "format") ?? pick(session, "input_audio_format")),
    outputFormat: fmt(pick(output, "format") ?? pick(session, "output_audio_format")),
    transcriptionModel: pick(transcription, "model") as string | undefined,
    noiseReduction: (pick(nr, "type") as string | undefined) ?? "none",
    vadType: pick(vad, "type") as string | undefined,
    eagerness: pick(vad, "eagerness") as string | undefined,
    vadThreshold: pick(vad, "threshold") as number | undefined,
    prefixPaddingMs: pick(vad, "prefix_padding_ms") as number | undefined,
    silenceMs: pick(vad, "silence_duration_ms") as number | undefined,
  };
}

/** G.711 μ-law byte → signed 16-bit PCM. Standard decode, no lookup table. */
function muLawToPcm16(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** Wrap 8kHz mono μ-law in a 16-bit PCM WAV so any player can open it. */
function mulawToWav(mulaw: Buffer, sampleRate = 8000): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) pcm.writeInt16LE(muLawToPcm16(mulaw[i]), i * 2);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** A stand-in prospect, so preflight needs nothing in the database. */
function sampleLead(): Lead {
  return {
    _id: "preflight",
    email: "prospect@example.com",
    phone: "+15550000000",
    firstName: "Sam",
    name: "Sam Rivera",
    title: "Owner",
    company: "Rivera Contracting",
    industry: "Contracting",
    status: "new",
    score: 0,
    customFields: {},
    unsubscribeToken: "preflight",
    unsubscribed: false,
    bounced: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Tool definitions are sent verbatim — a malformed schema fails session.update. */
function probeTools(): RealtimeTool[] {
  return [
    {
      name: "check_availability",
      description: "Get real open meeting times to offer.",
      parameters: { type: "object", properties: { count: { type: "number" } }, required: [] },
      async run() {
        return { slots: [] };
      },
    },
  ];
}

export async function voicePreflight(opts: {
  lead?: Lead;
  campaign?: Campaign;
  offer?: string;
  model?: string;
  voice?: string;
  schema?: "ga" | "beta";
  timeoutMs?: number;
  outDir?: string;
} = {}): Promise<PreflightResult> {
  const readiness = realtimeReadiness();
  const model = opts.model ?? config.voice.realtime.model;
  const schema = opts.schema ?? config.voice.realtime.schema;
  const base: PreflightResult = {
    ok: false,
    model,
    schema,
    voice: opts.voice ?? config.voice.realtime.voice,
    transcript: "",
    audioBytes: 0,
    durationSec: 0,
  };
  if (!readiness.ready) return { ...base, error: readiness.reason };
  if (readiness.warning) log.warn(readiness.warning);

  const lead = opts.lead ?? sampleLead();
  const instructions = buildCallInstructions({ lead, campaign: opts.campaign, offer: opts.offer });
  const humanizerConfig: AppliedHumanizer = {
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
  };
  const humanizer = createHumanizer(humanizerConfig);

  const chunks: Buffer[] = [];
  let transcript = "";
  let applied: AppliedSession | undefined;
  let failure: string | undefined;
  const startedAt = Date.now();

  let resolveOutcome: (how: "audio" | "error" | "timeout") => void = () => undefined;
  const outcome = new Promise<"audio" | "error" | "timeout">((r) => {
    resolveOutcome = r;
  });

  const finished = await (async (): Promise<"audio" | "error" | "timeout"> => {
    let settled = false;
    const done = (how: "audio" | "error" | "timeout") => {
      if (settled) return;
      settled = true;
      resolveOutcome(how);
    };

    // The opener's transcript lands on a `…transcript.done` event that arrives
    // after the audio it describes, so hitting the audio threshold isn't the
    // end — hold briefly for the words, then stop whether or not they showed up.
    let enoughAudio = false;
    let deadline: NodeJS.Timeout | undefined;
    const stopWhenSettled = () => {
      if (deadline) return;
      deadline = setTimeout(() => done("audio"), transcript ? 300 : 4_000);
    };

    let session: Awaited<ReturnType<typeof openRealtimeSession>>;
    try {
      session = await openRealtimeSession({
      instructions,
      tools: probeTools(),
      greetFirst: true,
      model,
      voice: opts.voice,
      schema,
      callbacks: {
        onAudio: (payload) => {
          const frame = Buffer.from(payload, "base64");
          chunks.push(humanizer ? humanizer.process(frame) : frame);
          // 8000 bytes = one second of μ-law. Three seconds is plenty to judge.
          if (!enoughAudio && chunks.reduce((n, c) => n + c.length, 0) > 24_000) {
            enoughAudio = true;
            stopWhenSettled();
          }
        },
        onInterrupt: () => undefined,
        onSessionUpdated: (session) => {
          applied = readApplied(session);
        },
        onTranscript: (role, text) => {
          if (role !== "agent") return;
          transcript += `${transcript ? " " : ""}${text}`;
          if (enoughAudio) {
            clearTimeout(deadline);
            deadline = undefined;
            done("audio");
          }
        },
        onError: (err) => {
          failure = err instanceof Error ? err.message : String(err);
          done("error");
        },
        onClose: () => done(failure ? "error" : "audio"),
        },
      });
    } catch (err) {
      // Credential resolution failed (expired OAuth, refused refresh, no key).
      failure = err instanceof Error ? err.message : String(err);
      return "error";
    }

    const timer = setTimeout(() => done("timeout"), opts.timeoutMs ?? 25_000);
    const settle = setInterval(() => {
      if (!settled) return;
      clearInterval(settle);
      clearTimeout(timer);
      clearTimeout(deadline);
      session.close();
    }, 100);
    return outcome;
  })();

  const audio = Buffer.concat(chunks);
  const result: PreflightResult = {
    ...base,
    ok: finished === "audio" && audio.length > 0,
    transcript: transcript.trim(),
    applied,
    humanizer: humanizerConfig,
    audioBytes: audio.length,
    durationSec: Number((audio.length / 8000).toFixed(1)),
    error:
      failure ??
      (finished === "timeout"
        ? "timed out waiting for audio — the session opened but the model never spoke"
        : audio.length === 0
          ? "session closed without producing audio"
          : undefined),
  };

  if (audio.length > 0) {
    const dir = opts.outDir ?? path.resolve("data/voice");
    mkdirSync(dir, { recursive: true });
    const wavPath = path.join(dir, `preflight-${model}-${result.voice}.wav`);
    writeFileSync(wavPath, mulawToWav(audio));
    writeFileSync(
      wavPath.replace(/\.wav$/i, ".json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          model: result.model,
          schema: result.schema,
          voice: result.voice,
          durationSec: result.durationSec,
          audioBytes: result.audioBytes,
          transcript: result.transcript,
          applied: result.applied,
          humanizer: result.humanizer,
        },
        null,
        2,
      )}\n`,
    );
    result.wavPath = wavPath;
  }
  return result;
}

/**
 * Try the configured schema, then the other one.
 *
 * The realtime session shape changed between the beta and GA releases, and a
 * mismatch presents as a session that connects and then says nothing — the
 * hardest failure to diagnose from a phone call. Probing both here turns it
 * into one line of output.
 */
export async function voicePreflightAutodetect(
  opts: Parameters<typeof voicePreflight>[0] = {},
): Promise<PreflightResult> {
  const configured = opts.schema ?? config.voice.realtime.schema;
  const first = await voicePreflight({ ...opts, schema: configured });
  if (first.ok) return first;

  const alternate = configured === "ga" ? "beta" : "ga";
  log.warn(`schema "${configured}" failed (${first.error}) — retrying as "${alternate}"`);
  const second = await voicePreflight({ ...opts, schema: alternate });
  return second.ok ? second : first;
}
