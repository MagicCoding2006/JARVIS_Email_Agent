import { config } from "../config/index.js";
import { worker } from "../llm/roles.js";
import { createLogger } from "../lib/logger.js";
import { LeadsRepo } from "../repositories/index.js";
import { webSearch, type SearchResult } from "./search.service.js";
import { emailCandidates, verifyBestEmail, type Verdict } from "../lib/email-verify.js";

const log = createLogger("discovery");

export interface DiscoverParams {
  role?: string;
  industry?: string;
  location?: string;
  company?: string;
  keywords?: string;
  limit?: number;
}

interface ExtractedPerson {
  name: string;
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  companyDomain: string;
  sourceUrl?: string;
}

export interface DiscoveredLead {
  email: string;
  verdict: Verdict;
  name: string;
  company: string;
}

/**
 * Free, self-hosted lead sourcing (no Apollo subscription needed):
 *   web search → LLM extracts real people → derive company domain →
 *   generate likely email patterns → MX/SMTP-verify → import deliverable ones.
 *
 * "guessed" emails (couldn't SMTP-verify, e.g. catch-all or blocked port 25) are
 * imported only if DISCOVERY_IMPORT_GUESSED=true; bounces auto-stop bad ones.
 */
export async function discoverLeads(params: DiscoverParams): Promise<{
  imported: DiscoveredLead[];
  consideredPeople: number;
  searchResults: number;
}> {
  const limit = Math.min(params.limit ?? 10, config.agent.maxLeadsPerSource);
  const terms = [params.role, params.company, params.industry, params.location, params.keywords]
    .filter(Boolean)
    .join(" ");

  const queries = [
    `${terms} site:linkedin.com/in`,
    params.company ? `${params.company} leadership team` : `${params.role} ${params.industry} companies`,
    `${terms} contact`,
  ].filter((q) => q.trim());

  // Run sequentially with a small gap — gentler on the free DuckDuckGo endpoint
  // (parallel bursts trigger its rate-limit challenge). SearXNG has no such limit.
  const searchResults: SearchResult[] = [];
  for (const q of queries) {
    searchResults.push(...(await webSearch(q, 8)));
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (searchResults.length === 0) {
    log.warn("no search results — check your search provider");
    return { imported: [], consideredPeople: 0, searchResults: 0 };
  }
  if (!worker.configured) {
    log.warn("worker LLM not configured — cannot extract people");
    return { imported: [], consideredPeople: 0, searchResults: searchResults.length };
  }

  const people = await extractPeople(searchResults, params, limit * 2);
  const imported: DiscoveredLead[] = [];

  for (const p of people) {
    if (imported.length >= limit) break;
    if (!p.companyDomain || !p.firstName) continue;

    const candidates = emailCandidates(p.firstName, p.lastName, p.companyDomain);
    const { email, verdict } = await verifyBestEmail(candidates);
    if (!email) continue;
    if (verdict === "guessed" && !config.discovery.importGuessed) continue;

    const lead = await LeadsRepo.upsertByEmail({
      email,
      firstName: p.firstName,
      lastName: p.lastName,
      name: p.name,
      title: p.title,
      company: p.company,
      industry: params.industry,
      website: `https://${p.companyDomain}`,
      source: "discovery",
    });
    await LeadsRepo.mergeCustomFields(lead._id, {
      emailConfidence: verdict,
      discoveredFrom: p.sourceUrl ?? "",
    });
    imported.push({ email, verdict, name: p.name, company: p.company });
  }

  log.info(`discovery: ${searchResults.length} results → ${people.length} people → ${imported.length} imported`);
  return { imported, consideredPeople: people.length, searchResults: searchResults.length };
}

async function extractPeople(
  results: SearchResult[],
  params: DiscoverParams,
  max: number,
): Promise<ExtractedPerson[]> {
  const context = results
    .slice(0, 25)
    .map((r) => `- ${r.title} | ${r.snippet} | ${r.url}`)
    .join("\n");

  const system = `You extract real B2B prospects from web search results for cold outreach.
Rules:
- Only include REAL named people who appear in the results (name + title + company). Skip generic pages.
- companyDomain = the company's OWN website domain (e.g. "acmehealth.com"). NEVER linkedin.com or social domains. Leave "" if you can't infer it.
- Match the target role/industry where possible.
Return ONLY JSON: {"people":[{"name":"","firstName":"","lastName":"","title":"","company":"","companyDomain":"","sourceUrl":""}]}.`;
  const user = `Target: role="${params.role ?? ""}" industry="${params.industry ?? ""}" company="${params.company ?? ""}" location="${params.location ?? ""}".
Search results:\n${context}\n\nExtract up to ${max} matching people.`;

  try {
    const out = await worker.completeJSON<{ people: ExtractedPerson[] }>(user, { system, temperature: 0.2, maxTokens: 2000 });
    return (out.people ?? []).filter((p) => p.firstName && p.company);
  } catch (err) {
    log.error("extractPeople failed", err);
    return [];
  }
}
