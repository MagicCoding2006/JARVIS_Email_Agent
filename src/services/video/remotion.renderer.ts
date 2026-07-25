import { spawn } from "node:child_process";
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import type { SceneSpec } from "./scene-spec.js";

const log = createLogger("remotion");

const FPS = 30;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const REMOTION_DIR = path.join(ROOT, "remotion");
const ENTRY_POINT = path.join(REMOTION_DIR, "src", "index.ts");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * Render the final mp4 with Remotion. Composites the scene spec over the audio.
 * Requires `cd remotion && npm install` once, and VIDEO_ENABLE_REMOTION=true.
 * Returns the absolute path to the rendered mp4.
 */
export async function renderWithRemotion(args: {
  videoId: string;
  spec: SceneSpec;
  audioPath: string;
  durationSec: number;
}): Promise<string> {
  if (!config.video.enableRemotion) {
    throw new Error("VIDEO_ENABLE_REMOTION is false — set it true after `cd remotion && npm install`");
  }

  // Make the audio available to Remotion via its public/ dir (staticFile).
  const audioName = `${args.videoId}.wav`;
  await mkdir(path.join(REMOTION_DIR, "public"), { recursive: true });
  await copyFile(args.audioPath, path.join(REMOTION_DIR, "public", audioName));
  const spec = await normalizeLocalAssets(args.videoId, args.spec);

  const durationInFrames = Math.max(1, Math.round(args.durationSec * FPS));
  const props = { spec, audioFile: audioName, fps: FPS, durationInFrames };

  const propsPath = path.join(REMOTION_DIR, "out", `${args.videoId}.props.json`);
  await mkdir(path.dirname(propsPath), { recursive: true });
  await writeFile(propsPath, JSON.stringify(props));

  const outDir = path.resolve(ROOT, config.video.outputDir);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${args.videoId}.mp4`);

  const renderArgs = [
    "remotion", "render", ENTRY_POINT, "LoomVideo", outPath,
    `--props=${propsPath}`,
    `--frames=0-${durationInFrames - 1}`,
  ];
  // Cap parallel Chrome tabs → cap peak RAM on memory-limited hosts (Railway).
  if (config.video.renderConcurrency > 0) renderArgs.push(`--concurrency=${config.video.renderConcurrency}`);
  // Use a system Chrome if one is pinned; otherwise Remotion uses the browser
  // baked in at build time (`remotion browser ensure`).
  if (config.video.chromePath) renderArgs.push(`--browser-executable=${config.video.chromePath}`);

  await run(NPX, renderArgs, REMOTION_DIR);
  log.info(`rendered ${outPath}`);
  return outPath;
}

async function normalizeLocalAssets(videoId: string, spec: SceneSpec): Promise<SceneSpec> {
  const next: SceneSpec = { ...spec, scenes: spec.scenes.map((s) => ({ ...s })) };
  const copied = new Map<string, string>();

  for (const scene of next.scenes) {
    const src = scene.bgImageUrl;
    if (!src || /^https?:\/\//i.test(src) || /^data:/i.test(src)) continue;

    const localPath = src.startsWith("file://") ? new URL(src).pathname : src;
    if (!path.isAbsolute(localPath)) continue;

    let publicName = copied.get(localPath);
    if (!publicName) {
      const ext = path.extname(localPath) || ".png";
      publicName = `${videoId}-bg-${copied.size}${ext}`;
      await copyFile(localPath, path.join(REMOTION_DIR, "public", publicName));
      copied.set(localPath, publicName);
    }
    scene.bgImageUrl = publicName;
  }

  return next;
}

function run(cmd: string, argv: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}
