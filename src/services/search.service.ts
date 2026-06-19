import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("search");

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Pluggable web search for lead research/discovery. Providers, cheapest first:
 *   - duckduckgo : FREE, no key (we parse the HTML endpoint). Default.
 *   - searxng    : FREE, self-hosted metasearch (set SEARXNG_URL). Most robust.
 *   - serper     : paid API (serper.dev), most reliable.
 *   - tavily     : paid API (tavily.com), LLM-oriented.
 * Returns [] (not an error) on failure so the agent degrades gracefully.
 */
export async function webSearch(query: string, limit = 5): Promise<SearchResult[]> {
  try {
    switch (config.search.provider) {
      case "searxng":
        return await searxng(query, limit);
      case "serper":
        return config.search.apiKey ? await serper(query, limit) : warnEmpty("serper");
      case "tavily":
        return config.search.apiKey ? await tavily(query, limit) : warnEmpty("tavily");
      case "duckduckgo":
      default:
        return await duckduckgo(query, limit);
    }
  } catch (err) {
    log.error(`web search (${config.search.provider}) failed`, err);
    return [];
  }
}

function warnEmpty(provider: string): SearchResult[] {
  log.warn(`SEARCH_API_KEY not set — ${provider} disabled`);
  return [];
}

// ── FREE: DuckDuckGo (no key) ───────────────────────────────────────────────
// Uses the "lite" endpoint, which is the most permissive. DDG occasionally
// serves a challenge page (HTTP 202); we retry briefly. For high reliability
// without a key, self-host SearXNG instead.
async function duckduckgo(query: string, limit: number): Promise<SearchResult[]> {
  let html = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `q=${encodeURIComponent(query)}`,
    });
    html = await res.text();
    if (res.status === 200 && html.includes("result-link")) break;
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }

  const linkRe = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && links.length < limit) {
    links.push({ url: decodeDdgUrl(m[1]), title: stripHtml(m[2]) });
  }
  const snips: string[] = [];
  while ((m = snipRe.exec(html)) && snips.length < limit) snips.push(stripHtml(m[1]));

  return links.map((l, i) => ({ title: l.title, url: l.url, snippet: snips[i] ?? "" }));
}

function decodeDdgUrl(href: string): string {
  // DDG wraps results as //duckduckgo.com/l/?uddg=<encoded>&...
  const idx = href.indexOf("uddg=");
  if (idx >= 0) {
    const enc = href.slice(idx + 5).split("&")[0];
    try {
      return decodeURIComponent(enc);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ── FREE: self-hosted SearXNG (set SEARXNG_URL) ─────────────────────────────
async function searxng(query: string, limit: number): Promise<SearchResult[]> {
  if (!config.search.searxngUrl) throw new Error("SEARXNG_URL not set");
  const url = `${config.search.searxngUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`searxng ${res.status}`);
  const data: any = await res.json();
  return (data.results ?? []).slice(0, limit).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

// ── PAID: Serper ────────────────────────────────────────────────────────────
async function serper(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": config.search.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!res.ok) throw new Error(`serper ${res.status}`);
  const data: any = await res.json();
  return (data.organic ?? []).slice(0, limit).map((r: any) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}

// ── PAID: Tavily ────────────────────────────────────────────────────────────
async function tavily(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: config.search.apiKey, query, max_results: limit }),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const data: any = await res.json();
  return (data.results ?? []).slice(0, limit).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}
