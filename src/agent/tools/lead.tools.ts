import { schema, type Tool } from "./types.js";
import { LeadsRepo, EventsRepo } from "../../repositories/index.js";
import { webSearch } from "../../services/search.service.js";
import { researchLead } from "../../services/research.service.js";
import { sourceLeadsFromApollo } from "../../services/apollo.service.js";
import { discoverLeads } from "../../services/discovery.service.js";
import { emailCandidates, verifyBestEmail } from "../../lib/email-verify.js";

export const getLead: Tool = {
  name: "get_lead",
  description: "Look up one lead by email: profile, status, score, and recent events.",
  risk: "low",
  parameters: schema({ email: { type: "string" } }, ["email"]),
  async run(args: { email: string }) {
    const lead = await LeadsRepo.getByEmail(args.email);
    if (!lead) return { error: `lead not found: ${args.email}` };
    const events = await EventsRepo.recentForLead(lead._id, 10);
    return {
      email: lead.email,
      name: lead.name,
      company: lead.company,
      title: lead.title,
      status: lead.status,
      score: lead.score,
      recentEvents: events.map((e) => ({ type: e.type, at: e.timestamp })),
    };
  },
};

export const listHotLeads: Tool = {
  name: "list_hot_leads",
  description: "List the hottest leads by score (most engaged first).",
  risk: "low",
  parameters: schema({ limit: { type: "number", description: "default 10" } }),
  async run(args: { limit?: number }) {
    const leads = await LeadsRepo.list({}, args.limit ?? 10);
    return leads.map((l) => ({ email: l.email, name: l.name, company: l.company, score: l.score, status: l.status }));
  },
};

export const search: Tool = {
  name: "web_search",
  description: "Search the web (for lead/company research, trends, intel). Returns top results.",
  risk: "low",
  parameters: schema({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
  async run(args: { query: string; limit?: number }) {
    const results = await webSearch(args.query, args.limit ?? 5);
    return { count: results.length, results };
  },
};

export const research: Tool = {
  name: "research_lead",
  description: "Research a lead online and save a summary + personalization hooks to their profile.",
  risk: "low",
  parameters: schema({ email: { type: "string" } }, ["email"]),
  async run(args: { email: string }) {
    const r = await researchLead(args.email);
    return r ?? { error: `lead not found: ${args.email}` };
  },
};

export const discover: Tool = {
  name: "discover_leads",
  description:
    "FREE lead sourcing (no Apollo needed): web-search for people matching a role/industry/company, derive their company email, verify it, and import deliverable leads. HIGH RISK (imports leads you'll email).",
  risk: "high",
  parameters: schema(
    {
      role: { type: "string", description: "Target title, e.g. 'VP of Operations'" },
      industry: { type: "string" },
      company: { type: "string", description: "Optional: a specific company to source from" },
      location: { type: "string" },
      keywords: { type: "string" },
      limit: { type: "number", description: "Max leads to import (hard-capped by config)" },
    },
    [],
  ),
  async run(args: { role?: string; industry?: string; company?: string; location?: string; keywords?: string; limit?: number }) {
    const r = await discoverLeads(args);
    return {
      searchResults: r.searchResults,
      consideredPeople: r.consideredPeople,
      imported: r.imported.length,
      leads: r.imported,
    };
  },
};

export const verifyEmail: Tool = {
  name: "verify_email",
  description: "Check if an email (or a name+domain) is deliverable via DNS/MX + SMTP probe. Returns valid/guessed/invalid.",
  risk: "low",
  parameters: schema(
    {
      email: { type: "string", description: "Exact email to verify (optional if name+domain given)" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      domain: { type: "string", description: "Company domain, e.g. acme.com" },
    },
    [],
  ),
  async run(args: { email?: string; firstName?: string; lastName?: string; domain?: string }) {
    const candidates = args.email
      ? [args.email]
      : emailCandidates(args.firstName ?? "", args.lastName ?? "", args.domain ?? "");
    const r = await verifyBestEmail(candidates);
    return r;
  },
};

export const sourceLeads: Tool = {
  name: "source_leads_apollo",
  description: "Find and import NEW leads from Apollo.io by title/industry/keywords. Requires a PAID Apollo API key (spends credits). Prefer discover_leads if you have no Apollo plan. HIGH RISK.",
  risk: "high",
  parameters: schema(
    {
      titles: { type: "array", items: { type: "string" }, description: "e.g. ['VP of Operations','COO']" },
      industries: { type: "array", items: { type: "string" } },
      keywords: { type: "string" },
      limit: { type: "number", description: "Max leads (hard-capped by config)" },
    },
    [],
  ),
  async run(args: { titles?: string[]; industries?: string[]; keywords?: string; limit?: number }) {
    const { imported, found } = await sourceLeadsFromApollo(args);
    return { found, imported: imported.length, emails: imported.map((l) => l.email) };
  },
};
