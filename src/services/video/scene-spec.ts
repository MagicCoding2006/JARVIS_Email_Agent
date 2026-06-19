import { strategist } from "../../llm/roles.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("scene-spec");

export interface Scene {
  durationSec: number;
  headline: string;
  subtext?: string;
  /** Optional data callouts drawn as animated stats. */
  dataPoints?: { label: string; value: string }[];
  /** Optional background image (e.g. a website screenshot URL). */
  bgImageUrl?: string;
}

export interface SceneSpec {
  title: string;
  accent: string;
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
  dataPoints?: { label: string; value: string }[];
  bgImageUrl?: string;
}): Promise<SceneSpec> {
  const fallback: SceneSpec = {
    title: "Quick intro",
    accent: "#4f46e5",
    scenes: [
      { durationSec: Math.max(args.durationSec, 6), headline: "A quick idea for you", subtext: args.script.slice(0, 80), dataPoints: args.dataPoints, bgImageUrl: args.bgImageUrl },
    ],
  };
  if (!strategist.configured) return fallback;

  const system = `You are a motion-graphics director for short "Loom-style" sales videos.
Split the voiceover into 2-4 scenes that sync to it, with punchy on-screen headlines and optional data callouts.
Total scene duration must equal the provided audio duration. Return ONLY JSON:
{"title":"...","accent":"#hex","scenes":[{"durationSec":number,"headline":"short","subtext":"optional","dataPoints":[{"label":"..","value":".."}]}]}`;
  const user = `Audio duration: ${args.durationSec.toFixed(1)}s
Voiceover script:\n"""\n${args.script}\n"""
${args.dataPoints?.length ? `Data to feature: ${JSON.stringify(args.dataPoints)}` : ""}
${args.bgImageUrl ? `Background image available: ${args.bgImageUrl}` : ""}`;

  try {
    const spec = await strategist.completeJSON<SceneSpec>(user, { system, temperature: 0.6 });
    if (!spec.scenes?.length) return fallback;
    if (args.bgImageUrl) spec.scenes.forEach((s) => (s.bgImageUrl ??= args.bgImageUrl));
    return spec;
  } catch (err) {
    log.error("scene spec generation failed", err);
    return fallback;
  }
}
