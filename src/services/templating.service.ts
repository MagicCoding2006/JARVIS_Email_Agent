import { worker } from "../llm/roles.js";
import {
  buildSlotFillPrompt,
  buildResearchSlotPrompt,
  buildTemplateAuthorPrompt,
} from "../llm/prompts.js";
import { createLogger } from "../lib/logger.js";
import { webSearch } from "./search.service.js";
import type { Campaign, Lead, SequenceStep } from "../models/types.js";

const log = createLogger("templating");

// Cap research slots per email — each one costs a web search + an LLM call.
const MAX_RESEARCH_SLOTS = 3;

const TOKEN = /\{\{\s*([\s\S]*?)\s*\}\}/g;

export interface TemplateContext {
  lead: Lead;
  campaign: Campaign;
  step: SequenceStep;
  priorSubject?: string;
  priorBody?: string;
}

interface ParsedToken {
  full: string; // the literal "{{...}}" to replace
  kind: "field" | "ai" | "research";
  arg: string; // field name, or AI/research instruction
  def: string; // default for field tokens ("{{company|your team}}")
}

/**
 * Author a hybrid template for a step using the WRITER model (GPT). The
 * strategist supplies guidance; GPT writes the fixed copy + places the slots.
 * Keeps GPT as the email writer even when the brain drives templating.
 */
export async function generateStepTemplate(args: {
  campaign: Campaign;
  step: SequenceStep;
  guidance?: string;
}): Promise<{ subjectTemplate: string; bodyTemplate: string }> {
  if (!worker.configured) {
    throw new Error("worker (GPT) model not configured — cannot author templates");
  }
  const { system, user } = buildTemplateAuthorPrompt(args);
  const res = await worker.completeJSON<{ subjectTemplate?: string; bodyTemplate?: string }>(user, {
    system,
    temperature: 0.7,
  });
  return {
    subjectTemplate: (res.subjectTemplate ?? "").trim(),
    bodyTemplate: (res.bodyTemplate ?? "").trim(),
  };
}

/** True if the string contains any template tokens worth rendering. */
export function hasTokens(s: string | undefined): boolean {
  if (!s) return false;
  TOKEN.lastIndex = 0;
  return TOKEN.test(s);
}

/**
 * Render a hybrid template into final email text. Fixed copy passes through
 * untouched; slots are resolved:
 *   {{field}} / {{field|default}}   → lead merge field
 *   {{ai: instruction}}             → one batched worker-LLM call fills all AI slots
 *   {{research: task}}              → web search + LLM fragment, per slot (capped)
 * AI/research slots resolve to "" gracefully when the worker model is off, so
 * the fixed parts of the email always send.
 */
export async function renderTemplate(template: string, ctx: TemplateContext): Promise<string> {
  const tokens = parseTokens(template);
  if (!tokens.length) return template;

  const fields = mergeMap(ctx.lead);

  // Resolve AI slots in ONE call; research slots individually (capped + deduped).
  const aiArgs = unique(tokens.filter((t) => t.kind === "ai").map((t) => t.arg));
  const researchArgs = unique(tokens.filter((t) => t.kind === "research").map((t) => t.arg));

  const [aiValues, researchValues] = await Promise.all([
    fillAiSlots(aiArgs, ctx),
    fillResearchSlots(researchArgs, ctx),
  ]);

  return template.replace(TOKEN, (full, inner) => {
    const t = classify(full, String(inner));
    if (t.kind === "field") return fields.get(t.arg.toLowerCase()) ?? t.def;
    if (t.kind === "ai") return aiValues.get(t.arg) ?? "";
    return researchValues.get(t.arg) ?? "";
  });
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function classify(full: string, inner: string): ParsedToken {
  const lower = inner.toLowerCase();
  if (lower.startsWith("ai:")) return { full, kind: "ai", arg: inner.slice(3).trim(), def: "" };
  if (lower.startsWith("research:")) return { full, kind: "research", arg: inner.slice(9).trim(), def: "" };
  const [name, ...rest] = inner.split("|");
  return { full, kind: "field", arg: name.trim(), def: rest.join("|").trim() };
}

function parseTokens(template: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(template)) !== null) out.push(classify(m[0], m[1]));
  return out;
}

function mergeMap(lead: Lead): Map<string, string> {
  const map = new Map<string, string>();
  const set = (k: string, v?: string) => {
    if (v != null && v !== "") map.set(k.toLowerCase(), String(v));
  };
  set("firstName", lead.firstName || lead.name?.split(" ")[0]);
  set("lastName", lead.lastName);
  set("name", lead.name);
  set("title", lead.title);
  set("company", lead.company);
  set("industry", lead.industry);
  set("website", lead.website);
  set("email", lead.email);
  for (const [k, v] of Object.entries(lead.customFields ?? {})) set(k, v);
  return map;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

// ── Slot resolution ─────────────────────────────────────────────────────────

async function fillAiSlots(args: string[], ctx: TemplateContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!args.length) return out;
  if (!worker.configured) {
    for (const a of args) out.set(a, "");
    return out;
  }
  try {
    const { system, user } = buildSlotFillPrompt({
      lead: ctx.lead,
      campaign: ctx.campaign,
      step: ctx.step,
      priorBody: ctx.priorBody,
      slots: args,
    });
    const res = await worker.completeJSON<{ slots: Record<string, string> }>(user, {
      system,
      temperature: 0.7,
    });
    args.forEach((a, i) => out.set(a, (res.slots?.[String(i + 1)] ?? "").trim()));
  } catch (err) {
    log.error("AI slot fill failed — leaving slots blank", err);
    for (const a of args) out.set(a, "");
  }
  return out;
}

async function fillResearchSlots(args: string[], ctx: TemplateContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const task of args.slice(0, MAX_RESEARCH_SLOTS)) {
    out.set(task, await researchSlot(ctx.lead, task));
  }
  // Anything beyond the cap resolves to empty rather than spending more budget.
  for (const task of args.slice(MAX_RESEARCH_SLOTS)) out.set(task, "");
  return out;
}

async function researchSlot(lead: Lead, task: string): Promise<string> {
  if (!worker.configured) return "";
  const query = `${lead.name ?? ""} ${lead.company ?? ""} ${task}`.trim();
  let context = "";
  try {
    const results = await webSearch(query, 4);
    context = results.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n");
  } catch (err) {
    log.warn(`research slot search failed for "${task}"`, err);
  }
  try {
    const { system, user } = buildResearchSlotPrompt({
      lead,
      task,
      context,
      cached: lead.customFields?.research,
    });
    const res = await worker.completeJSON<{ text: string }>(user, { system, temperature: 0.3 });
    return (res.text ?? "").trim();
  } catch (err) {
    log.error(`research slot LLM failed for "${task}"`, err);
    return "";
  }
}
