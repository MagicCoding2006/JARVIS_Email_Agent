import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Resolve the configured video output directory from the repository root.
 *
 * Multiple video services run from different working directories in production
 * (CLI, tracking server, and Remotion child process). Resolving relative paths
 * from one shared root keeps rendered MP4s, TTS audio, screenshots, and the
 * public /videos static mount pointed at the same folder.
 */
export function videoOutputDir(...parts: string[]): string {
  const base = path.isAbsolute(config.video.outputDir)
    ? config.video.outputDir
    : path.resolve(ROOT, config.video.outputDir);
  return path.join(base, ...parts);
}
