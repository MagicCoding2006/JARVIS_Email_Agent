import { schema, type Tool } from "./types.js";
import { createVideoForLead, produceVideo } from "../../services/video.service.js";
import type { VideoPurpose } from "../../models/types.js";

const VIDEO_PURPOSES: VideoPurpose[] = ["cold", "follow_up", "appointment", "proposal"];

export const createVideoScript: Tool = {
  name: "create_video_script",
  description:
    "Create a personalized video script + supporting email context line and tracked watch URL for one lead. Does not render or send. Use purpose=follow_up/appointment/proposal for warm later-stage videos, which convert better than cold.",
  risk: "low",
  parameters: schema(
    {
      email: { type: "string", description: "Lead email address" },
      offer: { type: "string", description: "Offer/value prop to use in the video script" },
      campaignId: { type: "string", description: "Optional campaign id for attribution" },
      purpose: { type: "string", description: `Funnel stage: ${VIDEO_PURPOSES.join(", ")} (default cold)` },
    },
    ["email", "offer"],
  ),
  async run(args: { email: string; offer: string; campaignId?: string; purpose?: string }) {
    const purpose = VIDEO_PURPOSES.includes(args.purpose as VideoPurpose)
      ? (args.purpose as VideoPurpose)
      : undefined;
    const asset = await createVideoForLead({
      leadEmail: args.email,
      offer: args.offer,
      campaignId: args.campaignId,
      purpose,
    });
    if (!asset) return { error: `lead not found: ${args.email}` };
    return {
      id: asset._id,
      status: asset.status,
      purpose: asset.purpose,
      hook: asset.hook,
      context: asset.context,
      script: asset.script,
      watchUrl: asset.watchUrl,
    };
  },
};

export const renderVideoAsset: Tool = {
  name: "render_video",
  description: "Render an existing scripted video into an MP4 using Gemini TTS + Remotion. HIGH RISK because it uses paid/compute resources.",
  risk: "high",
  parameters: schema({ videoId: { type: "string" } }, ["videoId"]),
  async run(args: { videoId: string }) {
    const asset = await produceVideo(args.videoId);
    if (!asset) return { error: `video not found: ${args.videoId}` };
    return {
      id: asset._id,
      status: asset.status,
      watchUrl: asset.watchUrl,
      videoUrl: asset.videoUrl,
    };
  },
};
