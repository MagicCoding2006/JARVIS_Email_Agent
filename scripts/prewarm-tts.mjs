// Download the Kokoro ONNX weights at BUILD time.
//
// Railway's runtime disk is ephemeral per deploy, but node_modules is part of
// the built image — and that's exactly where @huggingface/transformers caches
// (node_modules/@huggingface/transformers/.cache, ~90MB at q8). Baking it here
// means the first 🔊 tap after a deploy waits ~6s for the ONNX session instead
// of ~6s plus a 90MB download. The voices themselves ship inside kokoro-js.
import { KokoroTTS } from "kokoro-js";

const provider = process.env.TTS_PROVIDER ?? "kokoro";
if (provider === "off") {
  console.log("[prewarm-tts] TTS_PROVIDER=off — skipping");
  process.exit(0);
}

const model = process.env.TTS_MODEL ?? "onnx-community/Kokoro-82M-v1.0-ONNX";
const dtype = process.env.TTS_DTYPE ?? "q8";
const t0 = Date.now();

try {
  await KokoroTTS.from_pretrained(model, { dtype, device: "cpu" });
  console.log(`[prewarm-tts] cached ${model} (${dtype}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (err) {
  // Never fail a deploy because HuggingFace blipped — without the cache the
  // model just downloads on first use instead.
  console.warn(`[prewarm-tts] skipped: ${err?.message ?? err}`);
}
