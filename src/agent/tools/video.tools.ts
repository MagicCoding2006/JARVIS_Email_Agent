import { schema, type Tool } from "./types.js";
import { createVideoForLead, produceVideo } from "../../services/video.service.js";

export const createVideoScript: Tool = {
  name: "create_video_script",
  description: "Create a personalized video script and tracked watch URL for one lead. Does not render or send the video.",
  risk: "low",
  parameters: schema(
    {
      email: { type: "string", description: "Lead email address" },
      offer: { type: "string", description: "Offer/value prop to use in the video script" },
      campaignId: { type: "string", description: "Optional campaign id for attribution" },
    },
    ["email", "offer"],
  ),
  async run(args: { email: string; offer: string; campaignId?: string }) {
    const asset = await createVideoForLead({
      leadEmail: args.email,
      offer: args.offer,
      campaignId: args.campaignId,
    });
    if (!asset) return { error: `lead not found: ${args.email}` };
    return {
      id: asset._id,
      status: asset.status,
      hook: asset.hook,
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
