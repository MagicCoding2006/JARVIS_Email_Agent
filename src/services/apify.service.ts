import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { LeadsRepo } from "../repositories/index.js";
import type { Lead } from "../models/types.js";

const log = createLogger("apify");

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

export interface ApifyLeadInput {
  companyCountry?: string[];
  companyEmployeeSize?: string[];
  contactEmailStatus?: string;
  includeEmails?: boolean;
  industry?: string[];
  personCountry?: string[];
  personTitle?: string[];
  totalResults?: number;
}

interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
}

interface ApifyLeadItem {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  all_emails?: string;
  phone_numbers?: string;
  position?: string;
  linkedinUrl?: string;
  city?: string;
  state?: string;
  country?: string;
  organizationName?: string;
  organizationWebsite?: string;
  organizationLinkedinUrl?: string;
  organizationIndustry?: string;
  organizationSize?: string;
  organizationDescription?: string;
  organizationSpecialities?: string;
  organizationCity?: string;
  organizationState?: string;
  organizationCountry?: string;
  source?: string;
  [key: string]: unknown;
}

export async function sourceLeadsFromApify(input: ApifyLeadInput = {}): Promise<{
  runId: string;
  datasetId?: string;
  found: number;
  imported: Lead[];
  costUsd?: number;
}> {
  if (!config.apify.apiToken) throw new Error("APIFY_API_TOKEN not set — Apify sourcing disabled");

  const body = withDefaults(input);
  log.info("starting Apify actor", {
    actorId: config.apify.actorId,
    totalResults: body.totalResults,
    maxCostUsd: config.apify.maxCostPerRunUsd,
  });

  const started = await apifyPost<{ data: ApifyRun }>(`/acts/${encodeURIComponent(config.apify.actorId)}/runs`, body);
  const run = await waitForRun(started.data.id);
  if (run.status !== "SUCCEEDED") {
    throw new Error(`Apify run ${run.id} ended with status ${run.status}`);
  }
  if (!run.defaultDatasetId) {
    throw new Error(`Apify run ${run.id} succeeded without defaultDatasetId`);
  }

  const items = await fetchDataset(run.defaultDatasetId);
  const imported: Lead[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const email = firstEmail(item.email || item.all_emails || "");
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const lead = await LeadsRepo.upsertByEmail({
      email,
      firstName: item.firstName,
      lastName: item.lastName,
      name: item.fullName,
      title: item.position,
      company: item.organizationName,
      industry: normalizeIndustry(item.organizationIndustry),
      website: item.organizationWebsite,
      linkedin: item.linkedinUrl,
      source: "apify",
    });
    await LeadsRepo.mergeCustomFields(lead._id, {
      apifyRunId: run.id,
      apifyDatasetId: run.defaultDatasetId,
      apifySource: String(item.source ?? ""),
      companyLinkedin: item.organizationLinkedinUrl ?? "",
      companySize: item.organizationSize ?? "",
      companyLocation: [item.organizationCity, item.organizationState, item.organizationCountry].filter(Boolean).join(", "),
      contactLocation: [item.city, item.state, item.country].filter(Boolean).join(", "),
      companyPhone: item.phone_numbers ?? "",
      keywords: item.organizationSpecialities ?? "",
      description: item.organizationDescription ?? "",
      niche: inferNiche(item),
      subNiche: inferSubNiche(item),
      emailStatus: body.contactEmailStatus ?? "",
    });
    imported.push(lead);
  }

  log.info(`Apify imported ${imported.length}/${items.length} dataset item(s)`, {
    runId: run.id,
    datasetId: run.defaultDatasetId,
    costUsd: run.usageTotalUsd,
  });

  return {
    runId: run.id,
    datasetId: run.defaultDatasetId,
    found: items.length,
    imported,
    costUsd: run.usageTotalUsd,
  };
}

function withDefaults(input: ApifyLeadInput): Required<ApifyLeadInput> {
  return {
    companyCountry: input.companyCountry?.length ? input.companyCountry : ["United States"],
    companyEmployeeSize: input.companyEmployeeSize?.length ? input.companyEmployeeSize : ["0 - 1", "2 - 10"],
    contactEmailStatus: input.contactEmailStatus ?? "verified",
    includeEmails: input.includeEmails ?? true,
    industry: input.industry?.length ? input.industry : [
      "Construction",
      "HVAC and Refrigeration Equipment Manufacturing",
      "Specialty Trade Contractors",
    ],
    personCountry: input.personCountry?.length ? input.personCountry : ["United States"],
    personTitle: input.personTitle?.length ? input.personTitle : [
      "President",
      "owner",
      "chief executive officer",
      "founder",
      "CEO",
    ],
    totalResults: Math.min(input.totalResults ?? config.apify.maxResultsPerRun, config.apify.maxResultsPerRun),
  };
}

async function waitForRun(runId: string): Promise<ApifyRun> {
  for (;;) {
    const { data } = await apifyGet<{ data: ApifyRun }>(`/actor-runs/${runId}`);
    log.info("Apify run status", {
      runId,
      status: data.status,
      usageTotalUsd: data.usageTotalUsd,
      datasetId: data.defaultDatasetId,
    });
    if ((data.usageTotalUsd ?? 0) > config.apify.maxCostPerRunUsd && !TERMINAL_STATUSES.has(data.status)) {
      await apifyPost(`/actor-runs/${runId}/abort`, {});
      throw new Error(`Apify run ${runId} exceeded cost cap $${config.apify.maxCostPerRunUsd}; abort requested`);
    }
    if (TERMINAL_STATUSES.has(data.status)) return data;
    await new Promise((r) => setTimeout(r, config.apify.pollSeconds * 1000));
  }
}

async function fetchDataset(datasetId: string): Promise<ApifyLeadItem[]> {
  return apifyGet<ApifyLeadItem[]>(`/datasets/${datasetId}/items`, { clean: "true" });
}

async function apifyGet<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const url = apifyUrl(path, query);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`apify GET ${path} ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

async function apifyPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const url = apifyUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`apify POST ${path} ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

function apifyUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(`https://api.apify.com/v2${path}`);
  url.searchParams.set("token", config.apify.apiToken);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

function firstEmail(value: string): string {
  const match = value.match(/[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+/);
  return match ? match[0].toLowerCase() : "";
}

function normalizeIndustry(industry = ""): string {
  const text = industry.trim().toLowerCase();
  if (["construction", "specialty trade contractors", "hvac and refrigeration equipment manufacturing"].includes(text)) {
    return "Construction";
  }
  return industry;
}

function inferNiche(item: ApifyLeadItem): string {
  return normalizeIndustry(item.organizationIndustry) || "Uncategorized";
}

function inferSubNiche(item: ApifyLeadItem): string {
  const text = `${item.organizationName ?? ""} ${item.organizationIndustry ?? ""} ${item.organizationDescription ?? ""} ${item.organizationSpecialities ?? ""}`.toLowerCase();
  if (has(text, ["hvac", "heating", "cooling", "air conditioning", "furnace"])) return "HVAC";
  if (has(text, ["paving", "asphalt", "sealcoat", "striping"])) return "Paving / Asphalt";
  if (has(text, ["roof", "roofing", "shingle", "gutters"])) return "Roofing";
  if (has(text, ["electrical", "electrician", "security", "alarm"])) return "Electrical / Security";
  if (has(text, ["remodel", "renovation", "home improvement", "kitchen", "bathroom"])) return "Remodeling / Renovation";
  if (has(text, ["concrete", "driveway", "sidewalk"])) return "Concrete";
  if (has(text, ["contractor", "construction management", "builder"])) return "General Contractor";
  return "";
}

function has(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}
