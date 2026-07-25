/**
 * Video pipeline doctor. Diagnoses why "watch video" links show
 * "Your video is being prepared…" and never play.
 *
 *   npm run cli ... no — run directly:
 *   npx tsx scripts/video-doctor.ts               # inspect config + recent assets
 *   npx tsx scripts/video-doctor.ts --render <id> # actually run the render + show the error
 *   npx tsx scripts/video-doctor.ts --tts         # test Gemini TTS alone
 *
 * It touches each stage independently so you can see exactly where it breaks:
 *   env/config → DB asset status → file-on-disk → TTS → full render.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config/index.js";
import { getCollections } from "../src/repositories/collections.js";
import { closeDb } from "../src/lib/mongo.js";
import { produceVideo } from "../src/services/video.service.js";
import { synthesizeVoiceover } from "../src/services/video/gemini-tts.js";
import type { VideoAsset } from "../src/models/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
};

function h(title: string) {
  console.log(`\n\x1b[1m── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}\x1b[0m`);
}
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);

async function main() {
  // ── Stage 0: config / environment ────────────────────────────────────────
  h("Stage 0 · config & environment");
  config.gemini.apiKey ? ok("GEMINI_API_KEY set (TTS voiceover possible)")
                       : bad("GEMINI_API_KEY missing → TTS throws → every render fails");
  config.video.enableRemotion ? ok("VIDEO_ENABLE_REMOTION=true (render step armed)")
                              : bad("VIDEO_ENABLE_REMOTION=false → render throws, asset stays scripted");
  info(`VIDEO_OUTPUT_DIR = ${config.video.outputDir}  (resolved: ${path.resolve(ROOT, config.video.outputDir)})`);
  info(`TRACKING_BASE_URL = ${config.tracking.baseURL}`);

  const remotionDeps = path.join(ROOT, "remotion", "node_modules");
  existsSync(remotionDeps)
    ? ok("remotion/node_modules present (renderer can spawn)")
    : bad("remotion/node_modules MISSING → `npx remotion render` fails. Run `cd remotion && npm install` (and ensure the deploy build does too).");

  const outDir = path.resolve(ROOT, config.video.outputDir);
  if (existsSync(outDir)) {
    const files = readdirSync(outDir);
    const mp4s = files.filter((f) => f.endsWith(".mp4"));
    ok(`output dir exists — ${mp4s.length} mp4, ${files.filter((f) => f.endsWith(".wav")).length} wav on disk`);
    if (!mp4s.length) bad("no .mp4 files rendered yet on THIS machine (ephemeral disk? render never succeeded?)");
  } else {
    bad(`output dir does not exist yet: ${outDir}`);
  }

  // ── Stage 1: DB — what state are the assets actually in? ──────────────────
  h("Stage 1 · video assets in the DB");
  const c = await getCollections();
  const recent = await c.videos.find({}).sort({ createdAt: -1 }).limit(15).toArray();
  if (!recent.length) {
    bad("no video assets in DB at all — JARVIS has not created any videos.");
  } else {
    const counts: Record<string, number> = {};
    for (const v of recent) counts[v.status] = (counts[v.status] ?? 0) + 1;
    info(`last ${recent.length} assets by status: ${JSON.stringify(counts)}`);
    const withUrl = recent.filter((v) => v.videoUrl).length;
    (withUrl ? ok : bad)(`${withUrl}/${recent.length} have a playable videoUrl (the rest show "being prepared…")`);
    console.log();
    for (const v of recent) reportAsset(v, outDir);
  }

  // ── Optional: test TTS alone ──────────────────────────────────────────────
  if (args.includes("--tts")) {
    h("Stage 2 · Gemini TTS (isolated)");
    try {
      const out = path.join(outDir, `doctor-tts-test.wav`);
      const r = await synthesizeVoiceover({ text: "This is a test of the video voiceover pipeline.", outPath: out });
      ok(`TTS produced ${out} (~${r.durationSec}s). Gemini key + model work.`);
    } catch (err) {
      bad(`TTS failed: ${(err as Error).message}`);
    }
  }

  // ── Optional: run the full render for one asset and surface the real error ─
  const renderId = flag("render");
  if (renderId) {
    h(`Stage 3 · full render of ${renderId}`);
    console.log("  (watch for the Remotion child-process output below)\n");
    const result = await produceVideo(renderId);
    if (!result) bad("asset not found");
    else if (result.status === "uploaded") ok(`SUCCESS → ${result.videoUrl}`);
    else bad(`ended in status "${result.status}" — see the error logged above (audio may still exist).`);
  }

  console.log("\nDone.\n");
  await closeDb();
}

function reportAsset(v: VideoAsset, outDir: string) {
  const age = Math.round((Date.now() - new Date(v.createdAt).getTime()) / 3600000);
  console.log(`  • ${v._id}  [${v.status}]  ${age}h old  watch%=${v.watchPercent ?? 0}`);
  if (v.error) info(`\x1b[31merror:     ${v.error}\x1b[0m`);
  info(`watchUrl:  ${v.watchUrl}`);
  if (v.videoUrl) {
    info(`videoUrl:  ${v.videoUrl}`);
    // If it's a hosted /videos/<file>, check the file is actually on disk here.
    const base = decodeURIComponent(v.videoUrl.split("/videos/")[1] ?? "");
    if (base) {
      const p = path.join(outDir, base);
      existsSync(p)
        ? info(`  └ file on disk ✓ (${(statSync(p).size / 1e6).toFixed(1)} MB) — link should play`)
        : info(`  └ file MISSING on disk ✗ → /videos/${base} will 404 (ephemeral disk wiped it, or rendered elsewhere)`);
    }
  } else {
    info(`videoUrl:  (none) → /v/${v._id} returns the "being prepared…" page`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
