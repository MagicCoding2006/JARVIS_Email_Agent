import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("gemini-tts");

/**
 * Generate a voiceover WAV from text using the Gemini TTS API. Gemini returns
 * raw 24kHz mono 16-bit PCM (base64), which we wrap into a .wav file.
 * Gated behind GEMINI_API_KEY. Returns the output file path + duration estimate.
 */
export async function synthesizeVoiceover(args: {
  text: string;
  outPath: string;
  voice?: string;
}): Promise<{ path: string; durationSec: number }> {
  if (!config.gemini.apiKey) throw new Error("GEMINI_API_KEY not set — TTS disabled");

  const model = config.gemini.ttsModel;
  const voice = args.voice ?? config.gemini.ttsVoice;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.gemini.apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: args.text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });

  // Retry on rate-limit (429) / transient overload (500/503). On 429, Gemini
  // tells us how long to wait (RetryInfo) — honor it. This clears the free
  // tier's 3-req/min limit. A wait longer than the cap (i.e. the 15-req/DAY
  // limit, which resets at midnight PT) fails fast instead of hanging.
  const data = await postWithRetry(url, body);
  const b64: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error("gemini tts returned no audio");

  const pcm = Buffer.from(b64, "base64");
  const wav = pcmToWav(pcm, 24000, 1, 16);

  await mkdir(path.dirname(args.outPath), { recursive: true });
  await writeFile(args.outPath, wav);

  const durationSec = pcm.length / (24000 * 2); // 24kHz * 2 bytes/sample (mono)
  log.info(`voiceover written: ${args.outPath} (~${durationSec.toFixed(1)}s)`);
  return { path: args.outPath, durationSec };
}

/** Single wait longer than this (ms) means a daily-quota wall, not a per-minute
 *  blip — don't block a render on it; fail so the reason gets surfaced/logged. */
const MAX_WAIT_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST with bounded retry on 429/500/503, honoring Gemini's suggested delay. */
async function postWithRetry(url: string, body: string): Promise<any> {
  const maxRetries = Math.max(0, config.gemini.ttsMaxRetries);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.ok) return res.json();

    const text = await res.text();
    const retryable = res.status === 429 || res.status === 500 || res.status === 503;
    if (!retryable || attempt >= maxRetries) {
      throw new Error(`gemini tts ${res.status}: ${text}`);
    }
    // Prefer the server's RetryInfo; else exponential backoff (10s, 20s, 40s…).
    const waitMs = parseRetryDelayMs(text) ?? Math.min(MAX_WAIT_MS, 10_000 * 2 ** attempt);
    if (waitMs > MAX_WAIT_MS) {
      throw new Error(
        `gemini tts ${res.status}: suggested wait ${Math.round(waitMs / 1000)}s exceeds cap — likely the daily quota (free tier = 15/day, resets midnight PT). Enable billing to raise it. ${text.slice(0, 160)}`,
      );
    }
    log.warn(`gemini tts ${res.status} — waiting ${Math.round(waitMs / 1000)}s, retry ${attempt + 1}/${maxRetries}`);
    await sleep(waitMs);
  }
}

/** Pull RetryInfo.retryDelay (e.g. "28s", "1.5s") from a Gemini error body → ms. */
function parseRetryDelayMs(body: string): number | undefined {
  try {
    const details = JSON.parse(body)?.error?.details;
    if (!Array.isArray(details)) return undefined;
    for (const d of details) {
      const m = /^([\d.]+)s$/.exec(String(d?.retryDelay ?? ""));
      if (m) return Math.ceil(parseFloat(m[1]) * 1000);
    }
  } catch {
    /* non-JSON body → fall back to backoff */
  }
  return undefined;
}

/** Wrap raw little-endian PCM in a minimal WAV container. */
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
