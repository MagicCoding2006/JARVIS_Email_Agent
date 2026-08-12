/** Result of a synthesis run, already in the one format Telegram accepts. */
export interface SpeechResult {
  /** OGG/Opus, mono — the only container Telegram renders as a voice note. */
  ogg: Buffer;
  durationSec: number;
}

/**
 * A text-to-speech backend. Mirrors the `EmailSender` split: business logic
 * talks to this, never to a model or a binary directly.
 */
export interface TtsEngine {
  readonly name: string;
  /** Synthesize plain prose (run it through `toSpeech` first). */
  synthesize(text: string): Promise<SpeechResult>;
}
