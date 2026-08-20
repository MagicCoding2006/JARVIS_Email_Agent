/**
 * Post-processing on the agent's outbound audio — the "after-market filter".
 *
 * Be clear about what this can and cannot do. It changes **timbre**, not
 * behaviour. The things that actually give a bot away are pacing, turn-taking,
 * and whether it monologues, and none of those live here — they are prompt and
 * VAD concerns. What this fixes is narrower and real:
 *
 *  - **Dead silence between words.** A synthesized stream has a mathematically
 *    silent noise floor. No real phone call does. That absolute silence is a
 *    strong subconscious tell, and a faint comfort-noise bed removes it. (Real
 *    telephony does the same thing — comfort noise generation is why a muted
 *    call doesn't sound "dead".)
 *  - **Flat dynamics.** Phone lines compress hard. Gentle drive into a soft
 *    limiter gives the voice the forward, slightly squashed presence people
 *    associate with a real handset.
 *  - **Overlong synthetic pauses.** Realtime audio often leaves clean gaps
 *    around punctuation. Dropping some quiet frames after the first few dozen
 *    milliseconds tightens the cadence without time-stretching voiced speech.
 *  - **Muffled narrowband speech.** A small pre-emphasis stage brings consonants
 *    forward so the voice reads clearer on a handset, without adding bitrate
 *    or latency.
 *
 * Everything is deliberately subtle. This audio is already narrowband 8kHz
 * μ-law; heavy processing costs intelligibility, which loses more deals than a
 * slightly synthetic timbre ever will.
 *
 * **Off by default, and that default is empirical.** Tested on real calls, drive
 * above 0dB made the voice HARSHER, not warmer: the soft limiter's saturation
 * adds harmonics that narrowband μ-law has no headroom to carry, and the result
 * reads as "robotic". Comfort noise alone is the only setting that reliably
 * helps. Turn it on deliberately and A/B it against raw audio — do not assume
 * processing is an improvement.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** μ-law byte → signed 16-bit PCM. */
export function muLawDecode(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  const value = sign ? -sample : sample;
  // The negative-zero code (0x7F) would otherwise yield JavaScript's -0, which
  // is silently unequal to 0 under Object.is and poisons any comparison or
  // accumulator it reaches. Normalize it here, once.
  return value === 0 ? 0 : value;
}

/** Segment exponent for μ-law encoding: the index of the highest set bit. */
function segment(value: number): number {
  if (value <= 0) return 0;
  return Math.min(7, 31 - Math.clz32(value));
}

/**
 * Signed 16-bit PCM → μ-law byte.
 *
 * Inverse of `muLawDecode` at the SAMPLE level, not the byte level: μ-law has
 * two codes for zero (0x7F is −0, 0xFF is +0), so encoding a decoded 0x7F
 * yields 0xFF. Both play as silence, so the normalization is inaudible — but it
 * means a decode→encode pass is not bit-identical, and shouldn't be asserted as
 * such.
 */
export function muLawEncode(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  const exponent = segment(s >> 7);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export interface HumanizeOptions {
  /** Noise-floor level in dBFS. Around -55 is a quiet room; -45 is a busy one. */
  comfortNoiseDb: number;
  /** Gain into the soft limiter, in dB. 0 disables the dynamics stage. */
  driveDb: number;
  /** Small consonant/presence lift. 0 disables it; 1-2dB is usually enough. */
  clarityDb?: number;
  /** Shorten quiet pauses by dropping some low-energy frames. */
  compressPauses?: boolean;
  /** Preserve this much quiet audio before compression starts. */
  pauseKeepMs?: number;
  /** Peak level below which a frame is treated as quiet, in dBFS. */
  pauseThresholdDb?: number;
  /** Speed up the very beginning of the first agent utterance by dropping frames. */
  fastStart?: boolean;
  /** Duration of the opening segment to speed up. */
  fastStartMs?: number;
  /** Approximate speed multiplier for the opening segment. */
  fastStartRate?: number;
}

const dbToAmplitude = (db: number): number => 32767 * Math.pow(10, db / 20);
const frameDurationMs = (frame: Buffer): number => frame.length / 8;

/**
 * Soft saturation. Rounds peaks instead of shearing them, so added drive reads
 * as loudness rather than distortion.
 */
function softLimit(sample: number): number {
  const x = sample / 32767;
  return Math.tanh(x * 0.9) * 32767;
}

export class VoiceHumanizer {
  private noiseAmp: number;
  private driveGain: number;
  private clarityAmount: number;
  private lastInputSample = 0;
  private compressPauses: boolean;
  private pauseKeepMs: number;
  private quietThreshold: number;
  private fastStart: boolean;
  private fastStartMs: number;
  private fastStartRate: number;
  private fastStartElapsedMs = 0;
  private fastStartFrame = 0;
  private quietMs = 0;
  private droppedQuietFrames = 0;
  /** Carries the noise generator's last value so the bed is smooth, not hissy. */
  private lastNoise = 0;

  constructor(opts: HumanizeOptions) {
    this.noiseAmp = opts.comfortNoiseDb <= -100 ? 0 : dbToAmplitude(opts.comfortNoiseDb);
    this.driveGain = Math.pow(10, opts.driveDb / 20);
    this.clarityAmount = opts.clarityDb && opts.clarityDb > 0 ? Math.min(0.45, (Math.pow(10, opts.clarityDb / 20) - 1) * 0.55) : 0;
    this.compressPauses = Boolean(opts.compressPauses);
    this.pauseKeepMs = opts.pauseKeepMs ?? 80;
    this.quietThreshold = dbToAmplitude(opts.pauseThresholdDb ?? -48);
    this.fastStart = Boolean(opts.fastStart);
    this.fastStartMs = opts.fastStartMs ?? 260;
    this.fastStartRate = Math.max(1, opts.fastStartRate ?? 1.3);
  }

  /**
   * Filter one μ-law frame in place-ish. Twilio frames are 160 bytes (20ms), so
   * this runs a few thousand times a minute — it stays branch-light and
   * allocation-free apart from the output buffer.
   */
  process(frame: Buffer): Buffer {
    const durationMs = frameDurationMs(frame);
    if (this.fastStart && this.fastStartElapsedMs < this.fastStartMs) {
      this.fastStartElapsedMs += durationMs;
      this.fastStartFrame++;

      // Preserve the initial attack so "hello" starts cleanly, then drop a
      // predictable share of early frames. At 1.3x this drops roughly every
      // fourth 20ms frame, close enough for a very short phone opener.
      const preserveMs = 40;
      const dropEvery = Math.max(2, Math.round(1 / (1 - 1 / this.fastStartRate)));
      if (this.fastStartElapsedMs > preserveMs && this.fastStartFrame % dropEvery === 0) {
        return Buffer.alloc(0);
      }
    }

    let peak = 0;
    if (this.compressPauses) {
      for (let i = 0; i < frame.length; i++) {
        const level = Math.abs(muLawDecode(frame[i]));
        if (level > peak) peak = level;
      }

      if (peak <= this.quietThreshold) {
        this.quietMs += frameDurationMs(frame);
        if (this.quietMs > this.pauseKeepMs) {
          this.droppedQuietFrames++;
          // Keep one out of every three quiet frames after the preserved lead-in.
          // This shortens punctuation gaps while leaving enough room tone to avoid clicks.
          if (this.droppedQuietFrames % 3 !== 0) return Buffer.alloc(0);
        }
      } else {
        this.quietMs = 0;
        this.droppedQuietFrames = 0;
      }
    }

    const out = Buffer.allocUnsafe(frame.length);
    for (let i = 0; i < frame.length; i++) {
      let sample = muLawDecode(frame[i]);

      if (this.clarityAmount > 0) {
        const emphasized = sample + (sample - this.lastInputSample) * this.clarityAmount;
        this.lastInputSample = sample;
        sample = emphasized;
      }

      if (this.driveGain !== 1) sample = softLimit(sample * this.driveGain);

      if (this.noiseAmp > 0) {
        // One-pole lowpass over white noise → a soft "room" bed rather than hiss.
        const white = (Math.random() * 2 - 1) * this.noiseAmp;
        this.lastNoise = this.lastNoise * 0.85 + white * 0.15;
        sample += this.lastNoise;
      }

      out[i] = muLawEncode(sample);
    }
    return out;
  }
}

/** Build a humanizer from config, or null when the filter is switched off. */
export function createHumanizer(opts: { enabled: boolean } & HumanizeOptions): VoiceHumanizer | null {
  if (!opts.enabled) return null;
  if (opts.comfortNoiseDb <= -100 && opts.driveDb === 0 && !opts.clarityDb && !opts.compressPauses && !opts.fastStart) {
    return null;
  }
  return new VoiceHumanizer(opts);
}
