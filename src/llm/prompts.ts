import type { Campaign, Lead, SequenceStep } from "../models/types.js";

export interface DraftedEmail {
  subject: string;
  body: string;
}

const WRITER_SYSTEM = `You are an elite B2B SDR who writes cold outreach that gets replies.
Rules you never break:
- Sound like a human typing quickly, not a marketer. No corporate fluff.
- Keep it SHORT: 40-90 words for first touch, 20-50 words for follow-ups.
- Plain text only. No markdown, no bullet symbols, no emojis.
- ONE clear, low-friction call to action. Never stack multiple asks.
- Reference something specific about the prospect or their company when given.
- Never use spammy phrases ("act now", "limited time", "guarantee", "free money").
- Never invent facts about the prospect. If you don't know it, don't claim it.
- Write at a 6th-grade reading level. Subject lines under 50 characters, lowercase-ish, curiosity over hype.
Return ONLY JSON: {"subject": "...", "body": "..."}.`;

function leadBlock(lead: Lead): string {
  const fields: string[] = [];
  const push = (k: string, v?: string) => v && fields.push(`${k}: ${v}`);
  push("First name", lead.firstName || lead.name);
  push("Title", lead.title);
  push("Company", lead.company);
  push("Industry", lead.industry);
  push("Website", lead.website);
  for (const [k, v] of Object.entries(lead.customFields ?? {})) push(`Custom/${k}`, v);
  return fields.join("\n");
}

export interface VariantHint {
  subjectLine?: string;
  cta?: string;
  tone?: string;
}

export function buildPersonalizationPrompt(args: {
  lead: Lead;
  campaign: Campaign;
  step: SequenceStep;
  priorSubject?: string;
  priorBody?: string;
  variant?: VariantHint;
}): { system: string; user: string } {
  const { lead, campaign, step, priorSubject, priorBody, variant } = args;

  const threadContext =
    step.followUp && priorBody
      ? `\nThis is a FOLLOW-UP in an existing thread. The previous email was:\nSubject: ${priorSubject ?? ""}\n"""\n${priorBody}\n"""\nWrite a brief nudge that adds a new angle or a tiny bit of value. Do NOT repeat the previous email. If appropriate, keep the same subject (the system threads it as a reply).`
      : "";

  const variantBlock = variant
    ? `\nA/B VARIANT TO USE (this is the test arm — honor it):${variant.subjectLine ? `\nSubject line (use this or a very close variation): ${variant.subjectLine}` : ""}${variant.cta ? `\nCall to action: ${variant.cta}` : ""}${variant.tone ? `\nTone: ${variant.tone}` : ""}`
    : "";

  const user = `Write email step ${step.step} of a ${campaign.sequence.length}-touch sequence.

CAMPAIGN
Offer: ${campaign.offer}
Target persona: ${campaign.targetPersona}

THIS STEP
Purpose: ${step.purpose}
Angle: ${step.angle}
Extra guidance: ${step.instructions}
${variantBlock}
${threadContext}

PROSPECT
${leadBlock(lead)}

Personalize naturally using the prospect details above. End with one CTA aligned to the step's angle.
Return ONLY the JSON object.`;

  return { system: WRITER_SYSTEM, user };
}

export function buildSubjectLinesPrompt(args: {
  campaign: Campaign;
  count: number;
}): { system: string; user: string } {
  return {
    system: WRITER_SYSTEM,
    user: `Generate ${args.count} distinct cold-email subject lines for this offer.
Offer: ${args.campaign.offer}
Persona: ${args.campaign.targetPersona}
Each under 50 chars, curiosity-driven, no clickbait, no emojis.
Return ONLY JSON: {"subjects": ["...", "..."]}.`,
  };
}

export function buildReplyClassifyPrompt(replyText: string): { system: string; user: string } {
  return {
    system: `You classify inbound replies to cold sales emails. Be strict and literal.
Return ONLY JSON: {"label": one of ["positive","negative","neutral","out_of_office","not_interested","request_info"], "wantsMeeting": boolean, "summary": "one short sentence", "suggestedReply": "a short, helpful reply draft or empty string"}.
- positive: interested, asking to talk, picking a time, warm.
- request_info: wants pricing/details/a deck before committing.
- out_of_office: auto-reply / away message.
- not_interested: explicit no, "remove me", "not a fit".
- negative: annoyed/hostile but not an unsubscribe request.
- neutral: ambiguous, forwarded, or unclear.`,
    user: `Classify this reply:\n"""\n${replyText}\n"""`,
  };
}
