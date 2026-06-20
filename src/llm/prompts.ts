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

/**
 * Fill all AI slots in a templated email in ONE call (cost control). Each slot
 * is a short, specific fragment dropped into fixed surrounding copy.
 */
export function buildSlotFillPrompt(args: {
  lead: Lead;
  campaign: Campaign;
  step: SequenceStep;
  priorBody?: string;
  slots: string[];
}): { system: string; user: string } {
  const system = `You write tiny, specific personalization fragments to slot INTO a cold email between fixed copy.
Rules: plain text only (no quotes, markdown, or emojis); make each fragment fit naturally where it's inserted; keep it as short as the instruction implies; sound like a human; and NEVER invent facts about the prospect — if you can't support a claim, write a safe generic phrasing or an empty string.
Return ONLY JSON: {"slots": {"1": "...", "2": "..."}} with exactly one entry per slot, keyed by its number.`;

  const thread = args.priorBody
    ? `\nThis email is a follow-up to:\n"""\n${args.priorBody}\n"""\n`
    : "";
  const slotList = args.slots.map((s, i) => `${i + 1}) ${s}`).join("\n");

  const user = `CONTEXT
Offer: ${args.campaign.offer}
Persona: ${args.campaign.targetPersona}
Step angle: ${args.step.angle}
${thread}
PROSPECT
${leadBlock(args.lead)}

Fill each slot below with a fragment that fits the offer + prospect. Return ONLY the JSON object.
SLOTS:
${slotList}`;

  return { system, user };
}

/**
 * Have the WRITER model (GPT) author a reusable hybrid template for a step —
 * fixed copy plus slots that get filled per-prospect at send time. GPT writes
 * the actual prose; the strategist only supplies guidance.
 */
export function buildTemplateAuthorPrompt(args: {
  campaign: Campaign;
  step: SequenceStep;
  guidance?: string;
}): { system: string; user: string } {
  const system = `You are an elite B2B SDR who designs reusable cold-email TEMPLATES.
A template is fixed copy you write yourself, plus placeholder SLOTS that get filled per-prospect at send time:
- {{firstName|there}}      → a lead field (firstName,lastName,name,title,company,industry,website,email, or a custom field) with an optional |default
- {{ai: short instruction}} → the writer model fills this tailored fragment per prospect
- {{research: task}}        → web research fills this factual fragment per prospect
Rules:
- Write the fixed copy in a human, concise voice (40-90 words first touch, 20-50 for follow-ups). Plain text only, no markdown/emojis.
- Put a slot ONLY where per-prospect personalization actually helps. Use {{research:}} for facts about the prospect, {{ai:}} for tailored phrasing, merge fields for known data.
- Do NOT fill the slots yourself. Do NOT nest slots. One clear CTA.
Return ONLY JSON: {"subjectTemplate":"...","bodyTemplate":"..."}.`;

  const thread = args.step.followUp
    ? "This is a FOLLOW-UP that threads as a reply — keep it short and reference the prior outreach lightly."
    : "This is a first-touch (or fresh-angle) email.";

  const user = `Design a template for step ${args.step.step} (${args.step.purpose}).
Offer: ${args.campaign.offer}
Persona: ${args.campaign.targetPersona}
Step angle: ${args.step.angle}
Guidance: ${args.guidance || "(use your best judgment)"}
${thread}
Return ONLY the JSON object.`;

  return { system, user };
}

/** Turn web-research context into ONE factual fragment for a single research slot. */
export function buildResearchSlotPrompt(args: {
  lead: Lead;
  task: string;
  context: string;
  cached?: string;
}): { system: string; user: string } {
  const system = `You turn web research into ONE short, factual personalization fragment for a cold email.
Plain text only, no quotes/markdown. NEVER invent — if the research doesn't clearly support the task, return an empty string.
Return ONLY JSON: {"text": "..."}.`;

  const user = `Prospect: ${args.lead.name ?? args.lead.email}, ${args.lead.title ?? ""} at ${args.lead.company ?? ""}.
${args.cached ? `Known context: ${args.cached}\n` : ""}Search results:
${args.context || "(none)"}

Task: ${args.task}
Write the fragment, or "" if the research doesn't support it. Return ONLY the JSON object.`;

  return { system, user };
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
