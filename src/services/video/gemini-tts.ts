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

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: args.text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  if (!res.ok) throw new Error(`gemini tts ${res.status}: ${await res.text()}`);

  const data: any = await res.json();
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
