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
import { buildWebsiteVisuals } from "./video/website-assets.js";
import type { Lead, VideoAsset, VideoPurpose } from "../models/types.js";

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
  /** One-sentence supporting line for the carrier email: why this video is for them. */
  context: string;
}

export async function generateVideoScript(args: {
  lead: Lead;
  offer: string;
  purpose?: VideoPurpose;
}): Promise<ScriptResult> {
  const { lead, offer } = args;
  const purpose = args.purpose ?? "cold";
  const greeting = videoGreeting(lead);
  const recipient = recipientLabel(lead);
  const segment = lead.industry?.trim() || "your line of work";
  const cleanOffer = cleanForScript(offer);
  const avgJob = avgJobValueForIndustry(lead.industry);
  const city = leadCity(lead);

  if (!worker.configured) {
    return sanitizeScriptResult(deterministicVideoScript(lead, greeting, recipient, segment, avgJob), greeting);
  }

  const system = `You are a direct, no-nonsense sales expert writing a short personalized video script, spoken aloud, first person. Conversational and human, never corporate. Keep it under 60 seconds, roughly 90-130 words.

Use a Pain -> Agitation -> Solution -> CTA flow:
1) HOOK (Pain). After the greeting, the very first sentence hits their pain head-on. No preamble, no introducing yourself. Pick the single STRONGEST hook for the data you have:
   - Loss Aversion: quantify the loss. If an average job value is given, say how much they lose by sending a few calls a week to voicemail (e.g. "missing three calls a week hands competitors $30,000 in jobs").
   - Pattern Interrupt: one blunt, frustrating truth about their day (max ~15 words), stated as cold fact, with no solution yet.
   - Hyper-Local Threat: if a city is given, say competitors in that city answer faster and are booking the jobs they miss.
   - Anti-Pitch: admit it is a cold video, say what it is about in five words or less, and give them permission to close it if it is not relevant.
2) AGITATION. One short line twisting the knife: the cost of inaction, the competitor who answered first, the lead that went cold.
3) SOLUTION (outcome, not features). Describe the RESULT for the owner, not a feature list. Energy to match: "Imagine never missing a lead again. The AI answers in under 30 seconds, qualifies the homeowner, and books the job straight to your calendar. You just show up and quote." Use at most two concrete proof points from the offer. Do NOT recite every feature.
4) CTA. Low-risk consultation, not a hard sell. Offer to show a blueprint of how you would set it up for their workflow, and ask for about five minutes this week.

${purposeGuidance(purpose)}

Hard rules:
- Start the script exactly with the provided greeting, then go straight into the hook.
- If there is no real person name, address the company team, not "there".
- Benefits over features. Keep the pain concrete and specific to their segment.
- NEVER use these words/phrases: skyrocket, turbocharge, supercharge, unlock, streamline, leverage, seamless, cutting-edge, game-changer, revolutionize, synergy, circle back, take it to the next level, "hope this finds you well", "I took a look", "I help", "I noticed".
- No em dashes or en dashes. Use commas, periods, colons, or simple hyphens only.
- No emojis, markdown, bullet points, stage directions, or weird symbols.
- The "context" line is the supporting email text that carries the video. It names the specific pain, like: "I made this video specifically to address <pain>."
Return ONLY JSON: {"script":"...", "hook":"a 4-7 word email CTA line referencing the video", "context":"one sentence of supporting email text naming the pain point"}.`;
  const user = `Greeting to use exactly: ${greeting}
Video purpose: ${purpose}
Prospect/contact name: ${realPersonName(lead) ?? "none"}
Company: ${lead.company ?? "unknown"}
Title: ${lead.title ?? "unknown"}
Industry/segment: ${lead.industry ?? "unknown"}
City: ${city ?? "unknown"}
Average job value in this segment: ${avgJob ? `about $${avgJob.toLocaleString("en-US")} (use for a loss-aversion hook)` : "unknown (use a pattern-interrupt or anti-pitch hook)"}
Website: ${lead.website ?? "unknown"}
Offer (translate into outcomes, do not recite the list): ${cleanOffer}
Pick the strongest hook strategy for the data above, then write the spoken script, the email hook, and the supporting context line.`;

  try {
    const res = await worker.completeJSON<ScriptResult>(user, { system, temperature: 0.8 });
    return sanitizeScriptResult(res, greeting);
  } catch (err) {
    log.error("script generation failed", err);
    return sanitizeScriptResult(deterministicVideoScript(lead, greeting, recipient, segment, avgJob), greeting);
  }
}

/**
 * Pain-led fallback script (used when the worker LLM is off or errors). Mirrors
 * the Pain -> Agitation -> Solution -> CTA flow so even the deterministic path
 * leads with loss, not features.
 */
function deterministicVideoScript(
  lead: Lead,
  greeting: string,
  recipient: string,
  segment: string,
  avgJob?: number,
): ScriptResult {
  const loss = avgJob
    ? `At about $${avgJob.toLocaleString("en-US")} a job, every few calls that hit voicemail is real money handed to whoever answered first.`
    : `In ${segment}, the first company to answer usually wins the job, so every call that hits voicemail is money walking to a competitor.`;
  return {
    script: `${greeting} how much work are you losing to missed calls every week? ${loss} Imagine never missing a lead again: our AI answers in under 30 seconds, qualifies the homeowner, and books the job straight to your calendar, so you just show up and quote. I mapped out how this would run on your current setup. Do you have five minutes this week to take a look?`,
    hook: `quick video for ${recipient}`,
    context: `I made this video specifically to address the calls slipping past ${lead.company ?? "your team"} to voicemail.`,
  };
}

/** Rough average job value by trade/segment — fuels the loss-aversion hook. */
function avgJobValueForIndustry(industry?: string): number | undefined {
  const i = (industry ?? "").toLowerCase();
  if (!i) return undefined;
  const table: [RegExp, number][] = [
    [/solar/, 20000],
    [/remodel|renovat|general contractor|construction|build/, 15000],
    [/roof/, 10000],
    [/hvac|heating|cooling|air condition/, 8000],
    [/pool|spa/, 8000],
    [/window|siding|exterior/, 6000],
    [/concrete|masonry|foundation/, 6000],
    [/floor|tile/, 4000],
    [/fenc/, 4000],
    [/paint/, 3500],
    [/landscap|lawn|tree|irrigation/, 3000],
    [/garage door/, 1500],
    [/electric/, 1500],
    [/plumb/, 1200],
    [/clean|janitor|maid/, 400],
    [/pest|exterminat/, 400],
  ];
  for (const [rx, val] of table) if (rx.test(i)) return val;
  return undefined;
}

/** Best-effort city for a hyper-local hook, from common custom-field keys. */
function leadCity(lead: Lead): string | undefined {
  const fields = lead.customFields ?? {};
  for (const [key, value] of Object.entries(fields)) {
    if (/^(city|town|locality)$/i.test(key) && value?.trim()) return value.trim();
  }
  return undefined;
}

/** Tone guidance per funnel stage — cold pitches vs warmer follow-up touches. */
function purposeGuidance(purpose: VideoPurpose): string {
  switch (purpose) {
    case "follow_up":
      return "This is a follow-up to earlier outreach, not a cold intro. Briefly acknowledge the prior touch and build on it instead of restarting from scratch.";
    case "appointment":
      return "This is an appointment confirmation video. Trust is already established: warmly confirm the meeting, restate the value they'll get, and reduce any no-show risk. Keep the pitch light.";
    case "proposal":
      return "This is a proposal walkthrough for a warm prospect. Walk through the offer as the next step, confident and consultative, assuming they already know the basics.";
    case "cold":
    default:
      return "This is a cold first-touch video. Earn attention fast with a personally relevant opener before the ask.";
  }
}

function realPersonName(lead: Lead): string | undefined {
  const name = lead.name?.trim();
  const company = lead.company?.trim();
  if (lead.firstName?.trim()) return lead.firstName.trim();
  if (!name) return undefined;
  if (company && name.toLowerCase() === company.toLowerCase()) return undefined;
  if (/\b(roofing|roof|construction|contractor|company|inc|llc|corp|services?)\b/i.test(name)) return undefined;
  return name.split(/\s+/)[0];
}

function videoGreeting(lead: Lead): string {
  const first = realPersonName(lead);
  if (first) return `Hey ${first},`;
  if (lead.company?.trim()) return `Hey ${lead.company.trim()} team,`;
  return "Hey team,";
}

function recipientLabel(lead: Lead): string {
  return realPersonName(lead) ?? lead.company?.trim() ?? "your team";
}

function cleanForScript(value: string): string {
  return value
    .replace(/[—–]/g, ",")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .trim();
}

function sanitizeScriptResult(result: ScriptResult, greeting?: string): ScriptResult {
  let script = cleanForScript(result.script);
  if (greeting && !script.toLowerCase().startsWith(greeting.toLowerCase())) {
    script = `${greeting} ${script.replace(/^(hey|hi|hello)\b[^,]*,\s*/i, "")}`;
  }
  return {
    script,
    hook: cleanForScript(result.hook).slice(0, 80),
    context: cleanForScript(result.context ?? "").slice(0, 220),
  };
}

/** Create a VideoAsset (scripted) with a tracked watch URL ready to embed in email. */
export async function createVideoForLead(args: {
  leadEmail: string;
  offer: string;
  campaignId?: string;
  purpose?: VideoPurpose;
}): Promise<VideoAsset | null> {
  const lead = await LeadsRepo.getByEmail(args.leadEmail);
  if (!lead) {
    log.warn(`no lead ${args.leadEmail}`);
    return null;
  }
  const purpose = args.purpose ?? "cold";
  const { script, hook, context } = await generateVideoScript({ lead, offer: args.offer, purpose });
  const id = uuid();
  const asset = await VideosRepo.create({
    _id: id,
    leadId: lead._id,
    campaignId: args.campaignId,
    purpose,
    script,
    hook,
    context,
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
    const lead = await LeadsRepo.getById(asset.leadId);
    const visuals = lead ? await buildWebsiteVisuals(lead, videoId) : {};
    const audioPath = path.resolve(config.video.outputDir, `${videoId}.wav`);
    const { durationSec } = await synthesizeVoiceover({ text: asset.script, outPath: audioPath });
    const spec = await generateSceneSpec({
      script: asset.script,
      durationSec,
      prospectName: lead ? realPersonName(lead) : undefined,
      companyName: lead?.company,
      websiteUrl: visuals.websiteUrl,
      logoUrl: visuals.logoUrl,
      industry: lead?.industry,
      brandColor: visuals.brandColor,
      dataPoints: opts.dataPoints,
      bgImageUrl: opts.bgImageUrl ?? visuals.screenshotPath,
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
