import { schema, type Tool } from "./types.js";
import { ensureCampaign } from "../../services/variants.service.js";
import { generateStepTemplate } from "../../services/templating.service.js";
import { CampaignsRepo } from "../../repositories/index.js";

export const draftStepTemplate: Tool = {
  name: "draft_step_template",
  description:
    "Have the WRITER model (GPT) author a hybrid email template (fixed copy + {{ai:}}/{{research:}}/{{merge}} slots) for a campaign step from your guidance. Returns the template for review — does NOT save it. You never write email copy yourself; this delegates the writing to GPT.",
  risk: "low",
  parameters: schema(
    {
      campaign: { type: "string" },
      step: { type: "number", description: "Sequence step number (default 1)" },
      guidance: {
        type: "string",
        description: "What the template should do / which parts to research or AI-personalize",
      },
    },
    ["campaign"],
  ),
  async run(args: { campaign: string; step?: number; guidance?: string }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    const stepNum = args.step ?? 1;
    const step = c.sequence.find((s) => s.step === stepNum);
    if (!step) return { error: `step ${stepNum} not found in campaign` };
    try {
      const tpl = await generateStepTemplate({ campaign: c, step, guidance: args.guidance });
      return {
        campaign: c._id,
        step: stepNum,
        ...tpl,
        note: "Review this, then call set_step_template with the same text to apply it.",
      };
    } catch (err) {
      return { error: String(err) };
    }
  },
};

export const setStepTemplate: Tool = {
  name: "set_step_template",
  description:
    "Apply a hybrid template to a campaign step (GPT fills its slots per prospect at send time). Pass an empty bodyTemplate to revert the step to fully-AI-written. HIGH RISK — changes live campaign copy.",
  risk: "high",
  parameters: schema(
    {
      campaign: { type: "string" },
      step: { type: "number", description: "Sequence step number (default 1)" },
      bodyTemplate: {
        type: "string",
        description: "Body template with slots; pass an empty string to revert to fully-AI-written",
      },
      subjectTemplate: { type: "string", description: "Optional subject template with slots" },
    },
    ["campaign", "bodyTemplate"],
  ),
  async run(args: {
    campaign: string;
    step?: number;
    bodyTemplate: string;
    subjectTemplate?: string;
  }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    const stepNum = args.step ?? 1;
    const ok = await CampaignsRepo.setStepTemplate(c._id, stepNum, {
      bodyTemplate: args.bodyTemplate,
      subjectTemplate: args.subjectTemplate ?? "",
    });
    if (!ok) return { error: `step ${stepNum} not found in campaign` };
    return {
      ok: true,
      campaign: c._id,
      step: stepNum,
      mode: args.bodyTemplate ? "templated" : "fully-AI",
    };
  },
};
