import { worker } from "../llm/roles.js";
import { buildPersonalizationPrompt, type DraftedEmail, type VariantHint } from "../llm/prompts.js";
import { createLogger } from "../lib/logger.js";
import { renderTemplate } from "./templating.service.js";
import type { Campaign, Lead, SequenceStep } from "../models/types.js";

const log = createLogger("personalization");

/**
 * Draft a single email for a lead/step.
 *  - If the step has a `bodyTemplate`, render the hybrid template (fixed copy +
 *    AI/research/merge slots) — you keep structural control, AI fills only the
 *    portions you marked.
 *  - Otherwise the worker model writes the whole email from the step's angle.
 * Falls back to a simple template if the model is unconfigured or errors, so the
 * pipeline keeps running in dev/dry-run.
 */
export async function draftEmail(args: {
  lead: Lead;
  campaign: Campaign;
  step: SequenceStep;
  priorSubject?: string;
  priorBody?: string;
  variant?: VariantHint;
}): Promise<DraftedEmail> {
  const { lead, campaign, step, priorSubject } = args;

  // Hybrid-template path: structured email with AI/research/merge slots.
  if (step.bodyTemplate) {
    const ctx = { lead, campaign, step, priorSubject, priorBody: args.priorBody };
    const body = await renderTemplate(step.bodyTemplate, ctx);
    let subject = step.subjectTemplate ? await renderTemplate(step.subjectTemplate, ctx) : "";
    if (!subject.trim()) {
      // No subject template: reuse the thread subject on follow-ups, else a default.
      subject = step.followUp && priorSubject ? priorSubject : defaultSubject(lead);
    }
    return { subject: subject.trim() || defaultSubject(lead), body: body.trim() };
  }

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

function defaultSubject(lead: Lead): string {
  return `quick idea for ${lead.company || "your team"}`;
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
