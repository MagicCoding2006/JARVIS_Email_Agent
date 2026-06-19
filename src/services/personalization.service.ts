import { worker } from "../llm/roles.js";
import { buildPersonalizationPrompt, type DraftedEmail, type VariantHint } from "../llm/prompts.js";
import { createLogger } from "../lib/logger.js";
import type { Campaign, Lead, SequenceStep } from "../models/types.js";

const log = createLogger("personalization");

/**
 * Draft a single email for a lead/step using the worker model.
 * Falls back to a simple template if the model is unconfigured or errors,
 * so the pipeline keeps running in dev/dry-run.
 */
export async function draftEmail(args: {
  lead: Lead;
  campaign: Campaign;
  step: SequenceStep;
  priorSubject?: string;
  priorBody?: string;
  variant?: VariantHint;
}): Promise<DraftedEmail> {
  const { lead, campaign, step } = args;

  if (!worker.configured) {
    log.warn("worker LLM not configured — using fallback template");
    return fallbackTemplate(args);
  }

  try {
    const { system, user } = buildPersonalizationPrompt(args);
    const draft = await worker.completeJSON<DraftedEmail>(user, { system, temperature: 0.7 });
    if (!draft.subject || !draft.body) throw new Error("model returned empty subject/body");
    return { subject: draft.subject.trim(), body: draft.body.trim() };
  } catch (err) {
    log.error("draft failed, using fallback", err);
    return fallbackTemplate(args);
  }
}

function fallbackTemplate(args: {
  lead: Lead;
  campaign: Campaign;
  step: SequenceStep;
  priorSubject?: string;
}): DraftedEmail {
  const { lead, campaign, step, priorSubject } = args;
  const first = lead.firstName || lead.name?.split(" ")[0] || "there";
  const company = lead.company ? ` at ${lead.company}` : "";

  if (step.followUp) {
    return {
      subject: priorSubject || `Following up`,
      body: `Hi ${first},\n\nFloating this back to the top of your inbox — did my note land? ${campaign.offer}\n\nWorth a quick chat?\n\nAlex`,
    };
  }
  return {
    subject: `quick idea for ${lead.company || "your team"}`,
    body: `Hi ${first},\n\nI work with teams${company} on the following: ${campaign.offer}\n\nIf relevant, open to a 15-min call next week?\n\nAlex`,
  };
}
