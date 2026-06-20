import { strategist } from "../../llm/roles.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("scene-spec");

export interface Scene {
  durationSec: number;
  headline: string;
  subtext?: string;
  /** The single keyword/stat in the headline to emphasize in the brand color. */
  highlight?: string;
  /** Optional data callouts drawn as animated stats. */
  dataPoints?: { label: string; value: string }[];
  /** Optional background image (e.g. a website screenshot URL). */
  bgImageUrl?: string;
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
  /** Company logo URL drawn in the corner so the prospect sees it's tailored for them. */
  logoUrl?: string;
  captions?: CaptionCue[];
  scenes: Scene[];
}

/**
 * GLM as "creative director": turn a voiceover script (+ known duration and
 * optional assets) into a structured, data-driven scene spec that a fixed
 * Remotion composition renders. We use a structured spec rather than executing
 * model-generated React code — safer and far more reliable.
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
}): Promise<SceneSpec> {
  const fallback: SceneSpec = {
    title: args.companyName ? `Quick idea for ${args.companyName}` : "Quick intro",
    accent: args.brandColor ?? "#22c55e",
    prospectName: args.prospectName,
    companyName: args.companyName,
    websiteUrl: args.websiteUrl,
    logoUrl: args.logoUrl,
    captions: buildCaptions(args.script, args.durationSec),
    scenes: [
      {
        durationSec: Math.max(args.durationSec, 6),
        headline: args.companyName ? `A quick idea for ${args.companyName}` : "A quick idea for you",
        subtext: args.script.slice(0, 100),
        dataPoints: args.dataPoints,
        bgImageUrl: args.bgImageUrl,
      },
    ],
  };
  if (!strategist.configured) return fallback;

  const system = `You are a motion-graphics director for short personalized "Loom-style" sales videos.
Split the voiceover into 3-5 scenes that sync to it. Keep the screen simple: ONE bold, short phrase per scene (max ~6 words) so the viewer reads it instantly and listens to the voiceover for the rest. Let the detail live in the voiceover, not on screen.
For each scene give a "highlight": the single most important keyword or stat inside that headline (e.g. "30 seconds", "no setup fee", "booked jobs", "$10,000") that we will paint in the brand color. Keep subtext rare and very short, or omit it.
Personalization is about relevance, not fill-in-the-blank: make every headline hyper-relevant to this prospect's specific segment and its real challenges, even if the visual shell stays consistent.
The first scene must feel personally addressed (use the prospect/company name on screen as a variable field), not generic.
If a website background is available, use it on the first 1-2 scenes only; later scenes can be cleaner offer/CTA scenes.
Total scene duration must equal the provided audio duration. Return ONLY JSON:
{"title":"...","accent":"#hex","scenes":[{"durationSec":number,"headline":"short","highlight":"keyword","subtext":"optional","dataPoints":[{"label":"..","value":".."}]}]}`;
  const user = `Audio duration: ${args.durationSec.toFixed(1)}s
Prospect name: ${args.prospectName ?? "unknown"}
Company: ${args.companyName ?? "unknown"}
Industry/segment: ${args.industry ?? "unknown"}
Website: ${args.websiteUrl ?? "unknown"}
Voiceover script:\n"""\n${args.script}\n"""
${args.dataPoints?.length ? `Data to feature: ${JSON.stringify(args.dataPoints)}` : ""}
${args.bgImageUrl ? `Background image available: ${args.bgImageUrl}` : ""}`;

  try {
    const spec = await strategist.completeJSON<SceneSpec>(user, { system, temperature: 0.6 });
    if (!spec.scenes?.length) return fallback;
    spec.title ||= fallback.title;
    spec.accent = args.brandColor ?? validHex(spec.accent) ?? fallback.accent;
    spec.prospectName = args.prospectName;
    spec.companyName = args.companyName;
    spec.websiteUrl = args.websiteUrl;
    spec.logoUrl = args.logoUrl;
    spec.captions = buildCaptions(args.script, args.durationSec);
    if (args.bgImageUrl) spec.scenes.forEach((s) => (s.bgImageUrl ??= args.bgImageUrl));
    normalizeDurations(spec, args.durationSec);
    return spec;
  } catch (err) {
    log.error("scene spec generation failed", err);
    return fallback;
  }
}

function validHex(value?: string): string | undefined {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value : undefined;
}

function normalizeDurations(spec: SceneSpec, durationSec: number): void {
  const total = spec.scenes.reduce((sum, s) => sum + Math.max(0, Number(s.durationSec) || 0), 0);
  if (!total) {
    spec.scenes = [{ durationSec, headline: spec.title }];
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

  let cursor = 0;
  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const share = chunk.length / words.length;
    const cueDuration = isLast ? durationSec - cursor : Math.max(1.2, durationSec * share);
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
