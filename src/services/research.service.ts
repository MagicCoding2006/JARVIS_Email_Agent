import { worker } from "../llm/roles.js";
import { createLogger } from "../lib/logger.js";
import { LeadsRepo } from "../repositories/index.js";
import { webSearch } from "./search.service.js";

const log = createLogger("research");

export interface ResearchResult {
  email: string;
  summary: string;
  hooks: string[];
}

/**
 * Research a lead online: web-search their name/company, then have the worker
 * model summarize what's relevant for outreach + suggest personalization hooks.
 * Saves the summary into the lead's customFields so personalization can use it.
 */
export async function researchLead(email: string): Promise<ResearchResult | null> {
  const lead = await LeadsRepo.getByEmail(email);
  if (!lead) {
    log.warn(`no lead ${email}`);
    return null;
  }

  const queries = [
    `${lead.name ?? ""} ${lead.company ?? ""} ${lead.title ?? ""}`.trim(),
    lead.company ? `${lead.company} recent news` : "",
  ].filter(Boolean);

  const results = (await Promise.all(queries.map((q) => webSearch(q, 4)))).flat();
  if (results.length === 0 && !worker.configured) {
    return { email, summary: "No research available (search/model unconfigured).", hooks: [] };
  }

  const context = results.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n");

  let summary = "";
  let hooks: string[] = [];
  if (worker.configured) {
    try {
      const system = `You research B2B prospects for cold outreach. Be factual; do NOT invent details.
Return ONLY JSON: {"summary":"2-3 sentences on the company/person relevant to outreach","hooks":["specific personalization hook","..."]}.`;
      const user = `Prospect: ${lead.name ?? lead.email}, ${lead.title ?? ""} at ${lead.company ?? ""}.
Search results:\n${context || "(none)"}\n\nSummarize and propose hooks.`;
      const res = await worker.completeJSON<{ summary: string; hooks: string[] }>(user, { system, temperature: 0.3 });
      summary = res.summary ?? "";
      hooks = res.hooks ?? [];
    } catch (err) {
      log.error("research summarize failed", err);
    }
  }

  await LeadsRepo.mergeCustomFields(lead._id, {
    research: summary,
    researchHooks: hooks.join(" | "),
  });
  log.info(`researched ${email}`);
  return { email, summary, hooks };
}
