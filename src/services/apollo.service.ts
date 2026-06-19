import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { LeadsRepo } from "../repositories/index.js";
import type { Lead } from "../models/types.js";

const log = createLogger("apollo");

export interface ApolloSearch {
  titles?: string[];
  industries?: string[];
  companies?: string[];
  keywords?: string;
  limit?: number;
}

/**
 * Source leads from Apollo.io's People Search API and import any with a usable
 * email. Gated behind APOLLO_API_KEY and hard-capped by AGENT_MAX_LEADS_PER_SOURCE
 * (this is a PAID API — credits are spent per reveal). Returns the imported leads.
 */
export async function sourceLeadsFromApollo(params: ApolloSearch): Promise<{ imported: Lead[]; found: number }> {
  if (!config.apollo.apiKey) {
    throw new Error("APOLLO_API_KEY not set — lead sourcing disabled");
  }
  const limit = Math.min(params.limit ?? 10, config.agent.maxLeadsPerSource);

  const body: Record<string, unknown> = {
    api_key: config.apollo.apiKey,
    page: 1,
    per_page: limit,
  };
  if (params.titles?.length) body.person_titles = params.titles;
  if (params.industries?.length) body.q_organization_industries = params.industries;
  if (params.companies?.length) body.organization_names = params.companies;
  if (params.keywords) body.q_keywords = params.keywords;

  const res = await fetch("https://api.apollo.io/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`apollo ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const people: any[] = data.people ?? [];

  const imported: Lead[] = [];
  for (const p of people) {
    const email: string | undefined = p.email;
    if (!email || /email_not_unlocked|noemail/i.test(email)) continue; // skip locked emails
    const lead = await LeadsRepo.upsertByEmail({
      email,
      firstName: p.first_name,
      lastName: p.last_name,
      name: p.name,
      title: p.title,
      company: p.organization?.name ?? p.organization_name,
      industry: p.organization?.industry,
      website: p.organization?.website_url,
      linkedin: p.linkedin_url,
      source: "apollo",
    });
    imported.push(lead);
  }
  log.info(`apollo: found ${people.length}, imported ${imported.length}`);
  return { imported, found: people.length };
}
