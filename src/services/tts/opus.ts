import { spawn } from "node:child_process";

/** Override if ffmpeg isn't on PATH (Railway installs it via nixpacks aptPkgs). */
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Transcode a WAV buffer to OGG/Opus mono in-memory (no temp files).
 *
 * Telegram's `sendVoice` only renders the waveform/voice-note UI for OGG/Opus;
 * other formats degrade to a generic file player. Every engine outputs WAV, so
 * this is the shared last step. 32kbps voip-tuned Opus puts a minute of speech
 * at roughly 240KB, far under the 50MB upload ceiling.
 */
export async function wavToOpus(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-ac",
      "1",
      "-application",
      "voip",
      "-f",
      "ogg",
      "pipe:1",
    ]);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.stderr.on("data", (c: Buffer) => err.push(c));
    ff.on("error", (e) => reject(new Error(`ffmpeg not runnable (${FFMPEG}): ${e.message}`)));
    ff.on("close", (code) => {
      if (code === 0 && out.length) return resolve(Buffer.concat(out));
      reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
    });
    // ffmpeg can bail before reading all of stdin; the close handler reports why.
    ff.stdin.on("error", () => {});
    ff.stdin.end(wav);
  });
}
