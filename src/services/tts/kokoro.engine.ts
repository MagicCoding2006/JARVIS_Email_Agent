import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { wavToOpus } from "./opus.js";
import type { SpeechResult, TtsEngine } from "./tts.interface.js";

const log = createLogger("tts:kokoro");

type LoadedTts = Awaited<ReturnType<typeof loadModel>>;

async function loadModel() {
  // kokoro-js resolves its bundled voices through `import.meta.dirname`, added
  // in Node 20.11. On older runtimes it fails as an unreadable path.resolve
  // crash inside a minified bundle, so check up front and say why.
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 20 || (maj === 20 && min < 11)) {
    throw new Error(
      `TTS needs Node >= 20.11 (running ${process.versions.node}) — kokoro-js uses import.meta.dirname`,
    );
  }
  // Imported lazily: onnxruntime-node is ~200MB and pulls native bindings, and
  // nothing should slow the boot path before Railway's health check binds.
  const { KokoroTTS } = await import("kokoro-js");
  const t0 = Date.now();
  log.info(`loading ${config.tts.model} (${config.tts.dtype})`);
  const tts = await KokoroTTS.from_pretrained(config.tts.model, {
    dtype: config.tts.dtype as "fp32" | "fp16" | "q8" | "q4",
    device: "cpu",
  });
  log.info(`model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return tts;
}

let loading: Promise<LoadedTts> | null = null;

/** Load once, then keep it hot — the ONNX session costs ~6s and ~400MB RSS. */
function getModel(): Promise<LoadedTts> {
  if (!loading) {
    loading = loadModel().catch((err) => {
      loading = null; // a failed weight download shouldn't poison every later tap
      throw err;
    });
  }
  return loading;
}

/**
 * Kokoro-82M (Apache-2.0) running locally on CPU via ONNX. Free, no API key,
 * no system binary — the voices ship inside the npm package and the weights are
 * cached under node_modules (baked at build time by scripts/prewarm-tts.mjs).
 */
export class KokoroEngine implements TtsEngine {
  readonly name = "kokoro";

  /** Inference is CPU-bound, so serialize it: two taps at once would double
   *  peak RSS and make both slower rather than either finish sooner. */
  private queue: Promise<unknown> = Promise.resolve();

  async synthesize(text: string): Promise<SpeechResult> {
    const run = this.queue.then(() => this.run(text), () => this.run(text));
    this.queue = run.catch(() => {});
    return run;
  }

  private async run(text: string): Promise<SpeechResult> {
    const tts = await getModel();
    const t0 = Date.now();
    const audio = await tts.generate(text, { voice: config.tts.voice as never });
    const ogg = await wavToOpus(Buffer.from(audio.toWav()));
    const durationSec = audio.audio.length / audio.sampling_rate;
    log.info(
      `synthesized ${text.length} chars → ${durationSec.toFixed(1)}s audio ` +
        `(${Math.round(ogg.length / 1024)}KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    return { ogg, durationSec };
  }
}
