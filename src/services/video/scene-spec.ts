import { strategist } from "../../llm/roles.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("scene-spec");

export type SceneVisual = "website" | "missed_call" | "ai_intake" | "calendar" | "dashboard" | "cta";

export interface Scene {
  durationSec: number;
  headline: string;
  subtext?: string;
  /** Tiny act label above the headline, e.g. "THE PROBLEM" / "THE FIX". */
  kicker?: string;
  /** The single keyword/stat in the headline to emphasize in the brand color. */
  highlight?: string;
  /** Optional data callouts drawn as animated stats. */
  dataPoints?: { label: string; value: string }[];
  /** Optional background image, usually the prospect website screenshot. */
  bgImageUrl?: string;
  /** Which proof visual to show beside the copy. */
  visual?: SceneVisual;
}

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface SceneSpec {
  title: string;
  accent: string;
  prospectName?: string;
  companyName?: string;
  websiteUrl?: string;
  /** Company logo URL drawn in the corner so the prospect sees it is tailored. */
  logoUrl?: string;
  /** Booking link. The composition renders a pulsing CTA button on the last scene. */
  ctaUrl?: string;
  ctaLabel?: string;
  captions?: CaptionCue[];
  scenes: Scene[];
}

/**
 * GLM as creative director: turn a voiceover script, known duration, and
 * optional assets into a structured scene spec. The Remotion renderer stays
 * deterministic; the model only chooses concise copy and visual beats.
 */
export async function generateSceneSpec(args: {
  script: string;
  durationSec: number;
  prospectName?: string;
  companyName?: string;
  websiteUrl?: string;
  logoUrl?: string;
  industry?: string;
  brandColor?: string;
  dataPoints?: { label: string; value: string }[];
  bgImageUrl?: string;
  /** Booking link, e.g. config.booking.url. */
  ctaUrl?: string;
  ctaLabel?: string;
}): Promise<SceneSpec> {
  const fallback = buildFallbackSpec(args);
  if (!strategist.configured) return fallback;

  const system = `You are a senior motion director for short personalized sales videos selling an AI receptionist that answers missed calls, qualifies callers, books appointments, and texts the team.

Create 4-5 scenes that sync to the voiceover. The screen must feel like proof, not a slide deck.

Rules:
- Keep each headline under 7 words.
- Use concrete pain and outcome language. Avoid hype and generic claims.
- The first scene must feel personally made for this company.
- Use the prospect website only in scene 1, and optionally scene 2. Later scenes should show product proof visuals.
- Pick exactly one visual per scene from: website, missed_call, ai_intake, calendar, dashboard, cta.
- Put "cta" on the final scene.
- Do not invent statistics. Only use a data point when it is in the script or supplied data.
- The final headline is a low-friction ask to see it on their workflow.
- Total scene duration must equal the provided audio duration.

Return ONLY JSON:
{"title":"...","accent":"#hex","scenes":[{"durationSec":number,"kicker":"The cost","headline":"short","highlight":"keyword","subtext":"very short optional","dataPoints":[{"label":"..","value":".."}],"visual":"missed_call"}]}`;

  const user = `Audio duration: ${args.durationSec.toFixed(1)}s
Prospect name: ${args.prospectName ?? "unknown"}
Company: ${args.companyName ?? "unknown"}
Industry/segment: ${args.industry ?? "unknown"}
Website: ${args.websiteUrl ?? "unknown"}
Voiceover script:
"""
${args.script}
"""
${args.dataPoints?.length ? `Data to feature: ${JSON.stringify(args.dataPoints)}` : ""}
${args.bgImageUrl ? "Prospect website screenshot is available." : ""}`;

  try {
    const spec = await strategist.completeJSON<SceneSpec>(user, { system, temperature: 0.55 });
    if (!spec.scenes?.length) return fallback;

    spec.title ||= fallback.title;
    spec.accent = args.brandColor ?? validHex(spec.accent) ?? fallback.accent;
    spec.prospectName = args.prospectName;
    spec.companyName = args.companyName;
    spec.websiteUrl = args.websiteUrl;
    spec.logoUrl = args.logoUrl;
    spec.ctaUrl = args.ctaUrl;
    spec.ctaLabel = args.ctaLabel;
    spec.captions = buildCaptions(args.script, args.durationSec);
    spec.scenes = spec.scenes.slice(0, 5).map((scene, index, scenes) => ({
      ...scene,
      headline: fitText(scene.headline || fallback.scenes[Math.min(index, fallback.scenes.length - 1)].headline, 72),
      subtext: scene.subtext ? fitText(scene.subtext, 118) : undefined,
      visual: normalizeVisual(scene.visual, index, scenes.length),
      dataPoints: scene.dataPoints?.slice(0, 2),
    }));

    if (args.bgImageUrl) {
      spec.scenes.forEach((s, i) => {
        s.bgImageUrl = s.visual === "website" && i <= 1 ? args.bgImageUrl : undefined;
      });
    }

    normalizeDurations(spec, args.durationSec);
    return spec;
  } catch (err) {
    log.error("scene spec generation failed", err);
    return fallback;
  }
}

function buildFallbackSpec(args: {
  script: string;
  durationSec: number;
  prospectName?: string;
  companyName?: string;
  websiteUrl?: string;
  logoUrl?: string;
  industry?: string;
  brandColor?: string;
  dataPoints?: { label: string; value: string }[];
  bgImageUrl?: string;
  ctaUrl?: string;
  ctaLabel?: string;
}): SceneSpec {
  const company = args.companyName?.trim() || "your team";
  const industry = (args.industry ?? "").toLowerCase();
  const service = industry.includes("roof") ? "roof inspection" : "new job";
  const total = Math.max(args.durationSec, 12);
  const sceneDurations = splitDuration(total, [0.24, 0.22, 0.2, 0.2, 0.14]);

  return {
    title: `${company} missed-call demo`,
    accent: args.brandColor ?? "#22c55e",
    prospectName: args.prospectName,
    companyName: args.companyName,
    websiteUrl: args.websiteUrl,
    logoUrl: args.logoUrl,
    ctaUrl: args.ctaUrl,
    ctaLabel: args.ctaLabel,
    captions: buildCaptions(args.script, args.durationSec),
    scenes: [
      {
        durationSec: sceneDurations[0],
        headline: `${company}, missed calls cost jobs`,
        highlight: "cost jobs",
        subtext: "A personalized look at the calls that slip past the team.",
        dataPoints: args.dataPoints?.slice(0, 1),
        bgImageUrl: args.bgImageUrl,
        visual: args.bgImageUrl ? "website" : "missed_call",
      },
      {
        durationSec: sceneDurations[1],
        kicker: "The leak",
        headline: "Voicemail loses the buyer",
        highlight: "Voicemail",
        subtext: "The first business to answer usually gets the next step.",
        visual: "missed_call",
      },
      {
        durationSec: sceneDurations[2],
        kicker: "The fix",
        headline: "AI answers and qualifies",
        highlight: "qualifies",
        subtext: `It collects the need, address, and callback details for every ${service}.`,
        visual: "ai_intake",
      },
      {
        durationSec: sceneDurations[3],
        kicker: "Booked",
        headline: "The job hits your calendar",
        highlight: "calendar",
        subtext: "The caller gets confirmation. The team gets the details.",
        visual: "calendar",
      },
      {
        durationSec: sceneDurations[4],
        kicker: "Next step",
        headline: "See it on your workflow",
        highlight: "your workflow",
        subtext: `A quick walkthrough for ${company}, no rebuild required.`,
        visual: "cta",
      },
    ],
  };
}

function splitDuration(total: number, weights: number[]): number[] {
  let used = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return Math.max(1.5, total - used);
    const duration = Math.max(1.5, total * weight);
    used += duration;
    return duration;
  });
}

function normalizeVisual(value: unknown, index: number, length: number): SceneVisual {
  const allowed: SceneVisual[] = ["website", "missed_call", "ai_intake", "calendar", "dashboard", "cta"];
  if (typeof value === "string" && allowed.includes(value as SceneVisual)) return value as SceneVisual;
  if (index === length - 1) return "cta";
  return (["website", "missed_call", "ai_intake", "calendar", "dashboard"] as SceneVisual[])[Math.min(index, 4)];
}

function fitText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function validHex(value?: string): string | undefined {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value : undefined;
}

function normalizeDurations(spec: SceneSpec, durationSec: number): void {
  const total = spec.scenes.reduce((sum, s) => sum + Math.max(0, Number(s.durationSec) || 0), 0);
  if (!total) {
    spec.scenes = [{ durationSec, headline: spec.title, visual: "cta" }];
    return;
  }
  const scale = durationSec / total;
  for (const scene of spec.scenes) scene.durationSec = Math.max(1.5, scene.durationSec * scale);
  const corrected = spec.scenes.reduce((sum, s) => sum + s.durationSec, 0);
  spec.scenes[spec.scenes.length - 1].durationSec += durationSec - corrected;
}

function buildCaptions(script: string, durationSec: number): CaptionCue[] {
  const words = script.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length || durationSec <= 0) return [];

  const chunks: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    current.push(word);
    const endsPhrase = /[.!?;,]$/.test(word);
    if (current.length >= 7 || (current.length >= 4 && endsPhrase)) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);

  const totalChars = words.reduce((sum, w) => sum + w.length + 1, 0);
  let cursor = 0;
  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const chunkChars = chunk.reduce((sum, w) => sum + w.length + 1, 0);
    const share = chunkChars / totalChars;
    const cueDuration = isLast ? durationSec - cursor : Math.max(1.0, durationSec * share);
    const startSec = cursor;
    const endSec = Math.min(durationSec, cursor + cueDuration);
    cursor = endSec;
    return {
      startSec: Number(startSec.toFixed(2)),
      endSec: Number(endSec.toFixed(2)),
      text: chunk.join(" "),
    };
  });
}
