import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { verifyBestEmail, type Verdict } from "../lib/email-verify.js";
import { LeadsRepo } from "../repositories/index.js";
import { webSearch, type SearchResult } from "./search.service.js";

const log = createLogger("business-discovery");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const CONTACT_PATHS = [
  "",
  "/contact",
  "/contact-us",
  "/contacts",
  "/about",
  "/about-us",
  "/team",
  "/our-team",
  "/staff",
  "/people",
  "/meet-the-team",
  "/owner",
  "/ownership",
  "/founders",
  "/services",
  "/service-areas",
  "/service-area",
  "/privacy",
];
const GENERIC_MAILBOXES = ["info", "contact", "office", "sales", "service", "hello", "support"];
const PLACEHOLDER_EMAIL_RE = /^(your|you|name|email|test|example|sample|someone|user|admin)@|@(example|domain|email)\./i;
const WEBMAIL_DOMAINS = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com"]);
const SOCIAL_DOMAINS = new Set([
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "linkedin.com",
  "www.linkedin.com",
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "yelp.com",
  "www.yelp.com",
]);
const DIRECTORY_HOSTS = new Set([
  "angi.com",
  "www.angi.com",
  "bbb.org",
  "www.bbb.org",
  "enigma.com",
  "www.enigma.com",
  "hvacinformed.com",
  "www.hvacinformed.com",
  "greaterlawrencechamber.org",
  "www.greaterlawrencechamber.org",
  "indianachamber.com",
  "www.indianachamber.com",
]);

export interface BusinessContactDiscoveryParams {
  industry?: string;
  location?: string;
  keywords?: string;
  limit?: number;
  importGuessed?: boolean;
  allowUnverified?: boolean;
}

export interface BusinessContactLead {
  email: string;
  verdict: Verdict | "unverified";
  company: string;
  website?: string;
  evidenceUrl: string;
  source: "website" | "facebook_snippet" | "search_snippet" | "guessed_domain";
  confidence: "direct_found" | "snippet_found" | "guessed";
}

interface BusinessCandidate {
  company: string;
  website?: string;
  facebookUrl?: string;
  sourceUrl: string;
  snippet: string;
}

interface CrawlEvidence {
  emails: Map<string, string>;
  contactForms: Set<string>;
  socialUrls: Set<string>;
}

export async function discoverBusinessContacts(params: BusinessContactDiscoveryParams): Promise<{
  imported: BusinessContactLead[];
  candidates: number;
  searchResults: number;
}> {
  const limit = Math.min(params.limit ?? 10, config.agent.maxLeadsPerSource);
  const importGuessed = params.importGuessed ?? config.discovery.importGuessed;
  const allowUnverified = params.allowUnverified ?? false;
  log.info("starting business contact discovery", {
    industry: params.industry,
    location: params.location,
    keywords: params.keywords,
    requestedLimit: params.limit ?? 10,
    effectiveLimit: limit,
    importGuessed,
    allowUnverified,
    searchProvider: config.search.provider,
  });
  const searchResults = await searchBusinesses(params);
  const candidates = buildCandidates(searchResults, limit * 3);
  log.info(`built ${candidates.length} business candidates from ${searchResults.length} search results`);
  const imported: BusinessContactLead[] = [];
  const seenEmails = new Set<string>();

  for (const candidate of candidates) {
    if (imported.length >= limit) break;
    log.info("checking business candidate", {
      company: candidate.company,
      website: candidate.website,
      facebookUrl: candidate.facebookUrl,
      sourceUrl: candidate.sourceUrl,
    });
    const found = await findContactForBusiness(candidate, importGuessed, allowUnverified);
    log.info(`candidate produced ${found.length} contact(s)`, {
      company: candidate.company,
      contacts: found.map((c) => ({
        email: c.email,
        verdict: c.verdict,
        confidence: c.confidence,
        source: c.source,
        evidenceUrl: c.evidenceUrl,
      })),
    });
    for (const contact of found) {
      if (imported.length >= limit) break;
      if (seenEmails.has(contact.email)) {
        log.info("skipping duplicate discovered email", { email: contact.email, company: contact.company });
        continue;
      }
      seenEmails.add(contact.email);

      const lead = await LeadsRepo.upsertByEmail({
        email: contact.email,
        name: contact.company,
        company: contact.company,
        industry: params.industry,
        website: contact.website,
        source: "business_discovery",
      });
      await LeadsRepo.mergeCustomFields(lead._id, {
        emailConfidence: contact.verdict,
        contactConfidence: contact.confidence,
        discoveredFrom: contact.evidenceUrl,
        discoverySource: contact.source,
        discoveryLocation: params.location ?? "",
        discoveryKeywords: params.keywords ?? "",
      });
      imported.push(contact);
      log.info("imported business contact lead", {
        email: contact.email,
        company: contact.company,
        verdict: contact.verdict,
        confidence: contact.confidence,
        evidenceUrl: contact.evidenceUrl,
        leadId: lead._id,
      });
    }
  }

  log.info(`business discovery: ${searchResults.length} results → ${candidates.length} businesses → ${imported.length} imported`);
  return { imported, candidates: candidates.length, searchResults: searchResults.length };
}

// ── Contractor-specific discovery ────────────────────────────────────────────

export interface ContractorDiscoveryParams {
  /** Trade type: "HVAC", "plumbing", "electrical", "roofing", "general contractor", etc. */
  trade?: string;
  location?: string;
  keywords?: string;
  limit?: number;
  importGuessed?: boolean;
  allowUnverified?: boolean;
}

/**
 * Targeted contractor lead discovery: builds trade-specific SERP queries,
 * crawls contractor websites (contact/about/team/service pages), extracts
 * emails via mailto: hrefs, JSON-LD, and text regex, then verifies and imports.
 *
 * Usage: npm run cli discover-contractors --trade "roofing" --location "Austin, TX" --limit 20
 */
export async function discoverContractors(params: ContractorDiscoveryParams): Promise<{
  imported: BusinessContactLead[];
  candidates: number;
  searchResults: number;
}> {
  const trade = params.trade ?? "contractor";
  const tradeKeywords = [
    params.keywords,
    "owner operated",
    "local",
  ].filter(Boolean).join(" ");

  return discoverBusinessContacts({
    industry: trade,
    location: params.location,
    keywords: tradeKeywords,
    limit: params.limit,
    importGuessed: params.importGuessed,
    allowUnverified: params.allowUnverified,
  });
}

async function searchBusinesses(params: BusinessContactDiscoveryParams): Promise<SearchResult[]> {
  const terms = [params.industry, params.location, params.keywords].filter(Boolean).join(" ");
  const queries = [
    `${terms} official website`,
    `${terms} "contact" "email" -jobs -directory`,
    `${terms} business website email`,
    `${terms} contact us`,
    `${terms} "info@" OR "service@" OR "admin@" OR "office@"`,
    `${terms} mailto email address`,
    `${terms} site:facebook.com email contact`,
    `${terms} "email us" OR "send us an email"`,
  ].filter((q) => q.trim());

  const out: SearchResult[] = [];
  for (const q of queries) {
    log.info("searching businesses", { query: q });
    const results = await webSearch(q, 10);
    log.info(`search returned ${results.length} result(s)`, {
      query: q,
      topUrls: results.slice(0, 5).map((r) => r.url),
    });
    out.push(...results);
    await new Promise((r) => setTimeout(r, 900));
  }
  const deduped = dedupeResults(out);
  log.info(`deduped search results ${out.length} → ${deduped.length}`);
  return deduped;
}

function buildCandidates(results: SearchResult[], max: number): BusinessCandidate[] {
  const byCompany = new Map<string, BusinessCandidate>();
  for (const r of results) {
    const url = normalizeUrl(r.url);
    if (!url) {
      log.debug("skipping result with invalid url", { rawUrl: r.url, title: r.title });
      continue;
    }
    const host = hostOf(url);
    if (isLowQualitySource(url, host)) {
      log.debug("skipping low-quality business source", { url, host, title: r.title });
      continue;
    }
    const company = companyFromResult(r);
    if (!company || company.length < 3) {
      log.debug("skipping result without usable company name", { url, title: r.title });
      continue;
    }
    const key = company.toLowerCase();
    const existing = byCompany.get(key);
    const isFacebook = host.endsWith("facebook.com");
    const website = !isSocialHost(host) && !isDirectoryHost(host) ? originOf(url) : undefined;
    const candidate: BusinessCandidate = existing ?? {
      company,
      sourceUrl: url,
      snippet: r.snippet,
    };
    if (website && !candidate.website) candidate.website = website;
    if (isFacebook && !candidate.facebookUrl) candidate.facebookUrl = url;
    if (!candidate.snippet && r.snippet) candidate.snippet = r.snippet;
    byCompany.set(key, candidate);
    log.debug("business candidate extracted", {
      company: candidate.company,
      website: candidate.website,
      facebookUrl: candidate.facebookUrl,
      sourceUrl: candidate.sourceUrl,
    });
    if (byCompany.size >= max) break;
  }
  return [...byCompany.values()]
    .sort((a, b) => candidateScore(b) - candidateScore(a))
    .slice(0, max);
}

async function findContactForBusiness(
  candidate: BusinessCandidate,
  importGuessed: boolean,
  allowUnverified: boolean,
): Promise<BusinessContactLead[]> {
  const contacts: BusinessContactLead[] = [];
  const snippetEmails = extractEmails(`${candidate.company} ${candidate.snippet}`);
  log.info(`snippet scan found ${snippetEmails.length} email(s)`, {
    company: candidate.company,
    emails: snippetEmails,
  });
  for (const email of snippetEmails) {
    const verified = await verifyFoundEmail(email, importGuessed, allowUnverified);
    if (!verified) {
      log.info("snippet email rejected by verifier or guessed policy", { company: candidate.company, email });
      continue;
    }
    log.info("snippet email accepted", { company: candidate.company, email: verified.email, verdict: verified.verdict });
    contacts.push({
      email: verified.email,
      verdict: verified.verdict,
      company: candidate.company,
      website: candidate.website,
      evidenceUrl: candidate.sourceUrl,
      source: candidate.facebookUrl ? "facebook_snippet" : "search_snippet",
      confidence: "snippet_found",
    });
  }

  const website = candidate.website ?? await findOfficialWebsite(candidate);
  if (website) {
    log.info("crawling website for contacts", { company: candidate.company, website });
    const evidence = await crawlWebsiteForContacts(website);
    log.info("website crawl summary", {
      company: candidate.company,
      website,
      emails: [...evidence.emails.keys()],
      contactForms: [...evidence.contactForms],
      socialUrls: [...evidence.socialUrls],
    });
    for (const [email, evidenceUrl] of evidence.emails) {
      const verified = await verifyFoundEmail(email, importGuessed, allowUnverified);
      if (!verified) {
        log.info("website email rejected by verifier or guessed policy", { company: candidate.company, email, evidenceUrl });
        continue;
      }
      log.info("website email accepted", {
        company: candidate.company,
        email: verified.email,
        verdict: verified.verdict,
        evidenceUrl,
      });
      contacts.push({
        email: verified.email,
        verdict: verified.verdict,
        company: candidate.company,
        website,
        evidenceUrl,
        source: "website",
        confidence: "direct_found",
      });
    }

    if (contacts.length === 0) {
      const domain = hostOf(website).replace(/^www\./, "");
      const guessed = GENERIC_MAILBOXES.map((box) => `${box}@${domain}`);
      log.info("no direct emails accepted; trying generic mailbox guesses", {
        company: candidate.company,
        domain,
        guessed,
      });
      const verified = await verifyBestEmail(guessed);
      if (verified.email && (verified.verdict !== "guessed" || importGuessed)) {
        log.info("generic mailbox accepted", {
          company: candidate.company,
          email: verified.email,
          verdict: verified.verdict,
        });
        contacts.push({
          email: verified.email,
          verdict: verified.verdict,
          company: candidate.company,
          website,
          evidenceUrl: [...evidence.contactForms][0] ?? website,
          source: "guessed_domain",
          confidence: "guessed",
        });
      } else {
        log.info("generic mailbox guesses rejected", {
          company: candidate.company,
          verdict: verified.verdict,
          email: verified.email,
          importGuessed,
        });
      }
    }
  } else {
    log.info("no official website found for candidate", { company: candidate.company, sourceUrl: candidate.sourceUrl });
  }

  return dedupeContacts(contacts).sort((a, b) => contactScore(b) - contactScore(a));
}

async function findOfficialWebsite(candidate: BusinessCandidate): Promise<string | undefined> {
  log.info("searching for official website", { company: candidate.company });
  const results = await webSearch(`"${candidate.company}" official website`, 5);
  log.info(`official website search returned ${results.length} result(s)`, {
    company: candidate.company,
    topUrls: results.map((r) => r.url),
  });
  for (const r of results) {
    const url = normalizeUrl(r.url);
    if (!url) continue;
    const host = hostOf(url);
    if (!isSocialHost(host)) {
      const website = originOf(url);
      log.info("official website selected", { company: candidate.company, website });
      return website;
    }
  }
  return undefined;
}

async function crawlWebsiteForContacts(base: string): Promise<CrawlEvidence> {
  const evidence: CrawlEvidence = {
    emails: new Map(),
    contactForms: new Set(),
    socialUrls: new Set(),
  };

  let consecutiveTimeouts = 0;

  for (const path of CONTACT_PATHS) {
    // If the last two fetches both timed out the site is blocking us — bail early.
    if (consecutiveTimeouts >= 2) {
      log.info("site appears unreachable — skipping remaining paths", { base });
      break;
    }

    const url = joinUrl(base, path);
    log.info("fetching contact page", { url });
    const { html, timedOut } = await fetchPublicHtml(url);
    if (timedOut) consecutiveTimeouts++;
    else consecutiveTimeouts = 0;

    if (!html) {
      log.info("contact page unavailable or not html", { url });
      continue;
    }
    const emailsBefore = evidence.emails.size;
    const formsBefore = evidence.contactForms.size;
    const socialsBefore = evidence.socialUrls.size;
    const siteDomain = hostOf(base).replace(/^www\./, "");
    const allEmails = [
      ...extractMailtoHrefs(html),   // primary: mailto: hrefs
      ...extractJsonLdEmails(html),  // secondary: JSON-LD
      ...extractEmails(html),        // tertiary: full-text regex
    ];
    for (const email of allEmails) {
      const emailDomain = (email.split("@")[1] ?? "").replace(/^www\./, "");
      // Only keep emails that belong to this site's domain — skip third-party
      // widgets, "powered by" footers, and placeholder template emails.
      if (emailDomain && emailDomain !== siteDomain && !WEBMAIL_DOMAINS.has(emailDomain)) {
        log.debug("skipping off-domain email", { email, siteDomain, emailDomain });
        continue;
      }
      evidence.emails.set(email, url);
    }
    for (const social of extractSocialUrls(html, url)) {
      evidence.socialUrls.add(social);
    }
    if (/<form[\s>]/i.test(html) || /href=["'][^"']*contact[^"']*["']/i.test(html)) {
      evidence.contactForms.add(url);
    }
    log.info("contact page parsed", {
      url,
      addedEmails: evidence.emails.size - emailsBefore,
      addedForms: evidence.contactForms.size - formsBefore,
      addedSocials: evidence.socialUrls.size - socialsBefore,
    });
  }

  return evidence;
}

async function fetchPublicHtml(url: string): Promise<{ html: string; timedOut: boolean }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.info("fetch failed status", { url, status: res.status });
      return { html: "", timedOut: false };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      log.info("fetch skipped non-html", { url, contentType });
      return { html: "", timedOut: false };
    }
    return { html: await res.text(), timedOut: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = /timeout|aborted/i.test(msg);
    log.info("fetch failed", { url, error: msg });
    return { html: "", timedOut };
  }
}

async function verifyFoundEmail(
  email: string,
  importGuessed: boolean,
  allowUnverified: boolean,
): Promise<{ email: string; verdict: Verdict | "unverified" } | null> {
  log.info("verifying email", { email, importGuessed, allowUnverified });
  const verified = await verifyBestEmail([email]);
  log.info("email verification result", { input: email, email: verified.email, verdict: verified.verdict });
  if (!verified.email) {
    if (allowUnverified) {
      log.info("accepting directly found email without verification", { email });
      return { email, verdict: "unverified" };
    }
    return null;
  }
  if (verified.verdict === "guessed" && !importGuessed) {
    if (allowUnverified) {
      log.info("accepting guessed verifier result as unverified direct email", { email: verified.email });
      return { email: verified.email, verdict: "unverified" };
    }
    return null;
  }
  return { email: verified.email, verdict: verified.verdict };
}

/** Pull emails from explicit mailto: href attributes — highest confidence source. */
function extractMailtoHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href=["']mailto:([^"'?#\s]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const email = cleanEmail(m[1].trim());
    if (email) out.push(email);
  }
  return [...new Set(out)];
}

/** Parse JSON-LD blocks for schema.org ContactPoint/Organization email fields. */
function extractJsonLdEmails(html: string): string[] {
  const out: string[] = [];
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      collectJsonLdEmails(data, out);
    } catch {
      /* malformed JSON-LD — skip */
    }
  }
  return [...new Set(out.map(cleanEmail).filter(Boolean))];
}

function collectJsonLdEmails(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdEmails(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of ["email", "contactEmail", "emailAddress"]) {
    if (typeof obj[key] === "string") out.push(obj[key] as string);
  }
  for (const val of Object.values(obj)) collectJsonLdEmails(val, out);
}

function extractEmails(text: string): string[] {
  const normalized = text
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".");
  const matches = normalized.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return [...new Set(matches.map((m) => cleanEmail(m)).filter(Boolean))];
}

function cleanEmail(email: string): string {
  const cleaned = email.toLowerCase().replace(/^mailto:/, "").replace(/[),.;:'"\]>]+$/g, "");
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(cleaned)) return "";
  if (cleaned.includes("@example.")) return "";
  if (PLACEHOLDER_EMAIL_RE.test(cleaned)) return "";
  return cleaned;
}

function extractSocialUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const re = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = absolutize(m[1], baseUrl);
    if (!url) continue;
    if (isSocialHost(hostOf(url))) urls.add(url);
  }
  return [...urls];
}

function companyFromResult(result: SearchResult): string {
  const title = stripHtml(result.title)
    .split(/\s[-|–]\s/)[0]
    .replace(/\.\.\.$/, "")
    .replace(/\b(home|official site|facebook|linkedin|instagram|contact us|near me)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const host = hostOf(result.url).replace(/^www\./, "");
  if (title && !/^http/i.test(title) && !isGenericBusinessTitle(title)) return title.slice(0, 120);
  return domainToCompany(host);
}

function domainToCompany(host: string): string {
  return host
    .split(".")[0]
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isGenericBusinessTitle(title: string): boolean {
  return /\b(hvac|air conditioning|heating|cooling|contractor|service|services|installation|repair|near me|business directory|directory search|companies|needed|looking for|who can|does anyone|how to find)\b/i.test(title);
}

function isLowQualitySource(url: string, host: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  if (isDirectoryHost(host)) return true;
  if (host.endsWith("facebook.com") && (/\/groups\//.test(path) || /\/posts\//.test(path))) return true;
  return false;
}

function isDirectoryHost(host: string): boolean {
  return DIRECTORY_HOSTS.has(host) || [...DIRECTORY_HOSTS].some((d) => host.endsWith(`.${d}`));
}

function candidateScore(candidate: BusinessCandidate): number {
  let score = 0;
  if (candidate.website) score += 10;
  if (candidate.facebookUrl) score += 2;
  if (candidate.snippet) score += 1;
  if (isGenericBusinessTitle(candidate.company)) score -= 4;
  return score;
}

function contactScore(contact: BusinessContactLead): number {
  let score = 0;
  if (contact.confidence === "direct_found") score += 10;
  if (contact.confidence === "snippet_found") score += 6;
  if (contact.confidence === "guessed") score += 2;
  if (contact.verdict === "valid") score += 6;
  if (contact.verdict === "unverified") score += 3;
  if (contact.verdict === "guessed") score += 1;
  if (contact.website) {
    const emailDomain = contact.email.split("@")[1];
    const websiteDomain = hostOf(contact.website).replace(/^www\./, "");
    if (emailDomain === websiteDomain) score += 5;
  }
  if (WEBMAIL_DOMAINS.has(contact.email.split("@")[1])) score -= 2;
  return score;
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const url = normalizeUrl(r.url);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function dedupeContacts(contacts: BusinessContactLead[]): BusinessContactLead[] {
  const seen = new Set<string>();
  return contacts.filter((c) => {
    if (seen.has(c.email)) return false;
    seen.add(c.email);
    return true;
  });
}

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function originOf(raw: string): string {
  const url = new URL(raw);
  return url.origin;
}

function hostOf(raw: string): string {
  try {
    return new URL(normalizeUrl(raw)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isSocialHost(host: string): boolean {
  return SOCIAL_DOMAINS.has(host) || [...SOCIAL_DOMAINS].some((d) => host.endsWith(`.${d}`));
}

function joinUrl(base: string, path: string): string {
  return new URL(path || "/", base).toString();
}

function absolutize(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
