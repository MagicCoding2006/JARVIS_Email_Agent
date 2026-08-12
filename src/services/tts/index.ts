import { config } from "../../config/index.js";
import { KokoroEngine } from "./kokoro.engine.js";
import type { TtsEngine } from "./tts.interface.js";

let cached: TtsEngine | null = null;

/** The active TTS engine, or null when TTS_PROVIDER=off. */
export function getTts(): TtsEngine | null {
  if (config.tts.provider === "off") return null;
  if (!cached) cached = new KokoroEngine();
  return cached;
}

export function ttsEnabled(): boolean {
  return config.tts.provider !== "off";
}

export { toSpeech } from "./speech-text.js";
export type { TtsEngine, SpeechResult } from "./tts.interface.js";
