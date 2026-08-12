import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("video-retention");

/**
 * Only these are ever removed. Everything here is a regenerable render artifact
 * keyed by videoId — the MP4 served to prospects, its voiceover WAV, and the
 * website screenshot. An unrecognized extension is left alone rather than
 * guessed at, because this directory is served publicly by the tracking server.
 */
const PRUNABLE = new Set([".mp4", ".wav", ".png", ".jpg", ".jpeg"]);

/** Subdirectories to sweep alongside the top level (website-assets writes here). */
const SUBDIRS = ["screenshots"];

export interface PruneResult {
  deleted: number;
  bytes: number;
  kept: number;
  dryRun: boolean;
}

/**
 * Delete rendered video artifacts older than `maxAgeDays`.
 *
 * These files are public: prospects stream the MP4 off this directory via the
 * tracking server, so the window has to outlive the time a cold lead may take
 * to open the email. 30 days is the default for that reason — do not shorten it
 * to "save space" without moving playback to object storage first.
 */
export async function pruneOldVideos(
  opts: { maxAgeDays?: number; dryRun?: boolean } = {},
): Promise<PruneResult> {
  const maxAgeDays = opts.maxAgeDays ?? config.video.retentionDays;
  const dryRun = opts.dryRun ?? false;
  const result: PruneResult = { deleted: 0, bytes: 0, kept: 0, dryRun };

  if (maxAgeDays <= 0) {
    log.info("retention disabled (VIDEO_RETENTION_DAYS <= 0) — keeping everything");
    return result;
  }

  const root = path.resolve(config.video.outputDir);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const dir of [root, ...SUBDIRS.map((s) => path.join(root, s))]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // directory not created yet — nothing rendered here
    }

    for (const name of entries) {
      if (!PRUNABLE.has(path.extname(name).toLowerCase())) continue;
      const file = path.join(dir, name);
      // Defense in depth: never step outside the configured output directory.
      if (!file.startsWith(root + path.sep)) continue;

      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        if (info.mtimeMs >= cutoff) {
          result.kept++;
          continue;
        }
        if (!dryRun) await unlink(file);
        result.deleted++;
        result.bytes += info.size;
        log.info(`${dryRun ? "[dry-run] would delete" : "deleted"} ${path.relative(root, file)}`);
      } catch (err) {
        log.warn(`could not prune ${name}: ${(err as Error).message}`);
      }
    }
  }

  const mb = (result.bytes / 1e6).toFixed(1);
  log.info(
    `${dryRun ? "[dry-run] " : ""}pruned ${result.deleted} file(s), ${mb}MB freed; ` +
      `${result.kept} still within ${maxAgeDays}d`,
  );
  return result;
}
