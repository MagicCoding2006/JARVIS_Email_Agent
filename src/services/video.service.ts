import path from "node:path";
import { worker } from "../llm/roles.js";
import { uuid } from "../lib/ids.js";
import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { LeadsRepo, VideosRepo } from "../repositories/index.js";
import { trackingUrls } from "./tracking.service.js";
import { synthesizeVoiceover } from "./video/gemini-tts.js";
import { generateSceneSpec } from "./video/scene-spec.js";
import { renderWithRemotion } from "./video/remotion.renderer.js";
import type { Lead, VideoAsset } from "../models/types.js";

const log = createLogger("video");

/**
 * Loom / video outreach. The pipeline is:
 *   research → script (worker LLM) → TTS → avatar → render → upload → tracked link
 *
 * Script generation + tracking are implemented here. TTS/avatar/render are
 * pluggable external services (HeyGen, ElevenLabs, etc.) — see VideoRenderer.
 */

export interface ScriptResult {
  script: string;
  hook: string; // short line used as the email CTA
}

export async function generateVideoScript(args: {
  lead: Lead;
  offer: string;
}): Promise<ScriptResult> {
  const { lead, offer } = args;
  const first = lead.firstName || lead.name?.split(" ")[0] || "there";

  if (!worker.configured) {
    return {
      script: `Hey ${first}, quick 30-second note for ${lead.company ?? "your team"} — ${offer}. Worth a look?`,
      hook: `I made you a quick video, ${first}`,
    };
  }

  const system = `You write 30-45 second personalized cold video scripts (spoken aloud, first person).
Natural, warm, specific to the prospect. No fluff. End with a soft ask.
Return ONLY JSON: {"script":"...", "hook":"a 4-7 word email CTA line referencing the video"}.`;
  const user = `Prospect: ${first}${lead.title ? `, ${lead.title}` : ""} at ${lead.company ?? "their company"} (${lead.industry ?? ""}).
Offer: ${offer}
Write the spoken script + the email hook.`;

  try {
    const res = await worker.completeJSON<ScriptResult>(user, { system, temperature: 0.7 });
    return { script: res.script, hook: res.hook };
  } catch (err) {
    log.error("script generation failed", err);
    return {
      script: `Hi ${first}, made you a quick video about ${offer}.`,
      hook: `quick video for you, ${first}`,
    };
  }
}

/** Create a VideoAsset (scripted) with a tracked watch URL ready to embed in email. */
export async function createVideoForLead(args: {
  leadEmail: string;
  offer: string;
  campaignId?: string;
}): Promise<VideoAsset | null> {
  const lead = await LeadsRepo.getByEmail(args.leadEmail);
  if (!lead) {
    log.warn(`no lead ${args.leadEmail}`);
    return null;
  }
  const { script, hook } = await generateVideoScript({ lead, offer: args.offer });
  const id = uuid();
  const asset = await VideosRepo.create({
    _id: id,
    leadId: lead._id,
    campaignId: args.campaignId,
    script,
    hook,
    status: "scripted",
    watchUrl: trackingUrls.video(id),
    watchPercent: 0,
  });
  log.info(`scripted video for ${lead.email} → ${asset.watchUrl}`);
  return asset;
}

/**
 * Full pipeline: script → Gemini TTS voiceover → GLM scene spec → Remotion render.
 * The voiceover (Gemini TTS) always runs if a key is set; the Remotion render only
 * runs when VIDEO_ENABLE_REMOTION=true (after `cd remotion && npm install`).
 */
export async function produceVideo(
  videoId: string,
  opts: { dataPoints?: { label: string; value: string }[]; bgImageUrl?: string } = {},
): Promise<VideoAsset | null> {
  const asset = await VideosRepo.getById(videoId);
  if (!asset) {
    log.warn(`no video asset ${videoId}`);
    return null;
  }
  await VideosRepo.setStatus(videoId, "rendering");
  try {
    const audioPath = path.resolve(config.video.outputDir, `${videoId}.wav`);
    const { durationSec } = await synthesizeVoiceover({ text: asset.script, outPath: audioPath });
    const spec = await generateSceneSpec({
      script: asset.script,
      durationSec,
      dataPoints: opts.dataPoints,
      bgImageUrl: opts.bgImageUrl,
    });
    const mp4 = await renderWithRemotion({ videoId, spec, audioPath, durationSec });
    await VideosRepo.setStatus(videoId, "uploaded", `file://${mp4}`);
    log.info(`produced video ${videoId}`);
  } catch (err) {
    await VideosRepo.setStatus(videoId, "failed");
    log.error(`produceVideo failed for ${videoId} (audio may still exist)`, err);
  }
  return VideosRepo.getById(videoId);
}

/**
 * Pluggable renderer interface for ALTERNATIVE backends (HeyGen/ElevenLabs/
 * Higgsfield MCP). Implement this and call renderVideo() to move an asset to
 * "uploaded" with a videoUrl, instead of the built-in Gemini+Remotion path.
 */
export interface VideoRenderer {
  render(script: string): Promise<{ videoUrl: string }>;
}

export async function renderVideo(videoId: string, renderer: VideoRenderer): Promise<void> {
  const asset = await VideosRepo.getById(videoId);
  if (!asset) return;
  await VideosRepo.setStatus(videoId, "rendering");
  try {
    const { videoUrl } = await renderer.render(asset.script);
    await VideosRepo.setStatus(videoId, "uploaded", videoUrl);
    log.info(`rendered video ${videoId} → ${videoUrl}`);
  } catch (err) {
    await VideosRepo.setStatus(videoId, "failed");
    log.error(`render failed for ${videoId}`, err);
  }
}
