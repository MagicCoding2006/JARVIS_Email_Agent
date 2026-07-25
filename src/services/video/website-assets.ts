import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config/index.js";
import { videoOutputDir } from "./paths.js";
import { createLogger } from "../../lib/logger.js";
import type { Lead } from "../../models/types.js";

const log = createLogger("video-assets");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface WebsiteVisuals {
  websiteUrl?: string;
  brandColor?: string;
  /** Company logo URL, shown on screen so the prospect sees the video is for them. */
  logoUrl?: string;
  screenshotPath?: string;
}

export async function buildWebsiteVisuals(lead: Lead, videoId: string): Promise<WebsiteVisuals> {
  const websiteUrl = normalizeWebsite(lead.website);
  if (!websiteUrl) return {};

  const { brandColor, logoUrl } = await readBrandAssets(websiteUrl);
  const screenshotPath = config.video.captureWebsite
    ? await captureWebsiteScreenshot(websiteUrl, videoId)
    : undefined;

  return { websiteUrl, brandColor, logoUrl, screenshotPath };
}

function normalizeWebsite(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

async function readBrandAssets(url: string): Promise<{ brandColor?: string; logoUrl?: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "Mozilla/5.0 SDR video renderer" },
    });
    if (!res.ok) return { logoUrl: faviconFallback(url) };
    const html = await res.text();
    const brandColor =
      metaContent(html, "theme-color") ||
      metaContent(html, "msapplication-TileColor") ||
      cssAccent(html);
    return { brandColor, logoUrl: extractLogo(html, url) ?? faviconFallback(url) };
  } catch (err) {
    log.debug("brand asset fetch failed", { url, error: err instanceof Error ? err.message : String(err) });
    return { logoUrl: faviconFallback(url) };
  }
}

/**
 * Pick the best on-screen logo: a square apple-touch-icon / icon link if present,
 * else the social share image (og:image), else the host favicon. All resolved to
 * absolute URLs so Remotion can load them remotely.
 */
function extractLogo(html: string, pageUrl: string): string | undefined {
  const href =
    linkHref(html, "apple-touch-icon") ||
    linkHref(html, "icon") ||
    metaContentRaw(html, "og:image") ||
    metaContentRaw(html, "twitter:image");
  if (!href) return undefined;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return undefined;
  }
}

function linkHref(html: string, rel: string): string | undefined {
  const rx = new RegExp(`<link[^>]+rel=["'][^"']*${escapeRe(rel)}[^"']*["'][^>]*>`, "i");
  const tag = html.match(rx)?.[0];
  return tag?.match(/href=["']([^"']+)["']/i)?.[1];
}

function faviconFallback(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=128`;
  } catch {
    return undefined;
  }
}

/** Pull a meta/link content value by name or property. */
function metaContentRaw(html: string, name: string): string | undefined {
  const rx = new RegExp(`<meta[^>]+(?:name|property)=["']${escapeRe(name)}["'][^>]+content=["']([^"']+)["']`, "i");
  return html.match(rx)?.[1];
}

function metaContent(html: string, name: string): string | undefined {
  return normalizeHex(metaContentRaw(html, name));
}

function cssAccent(html: string): string | undefined {
  const match = html.match(/#[0-9a-f]{6}\b/i);
  return normalizeHex(match?.[0]);
}

function normalizeHex(value?: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return undefined;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function captureWebsiteScreenshot(url: string, videoId: string): Promise<string | undefined> {
  const chrome = await findChrome();
  if (!chrome) {
    log.warn("website screenshot skipped — no Chrome executable found");
    return undefined;
  }

  const outDir = videoOutputDir("screenshots");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${videoId}.png`);

  try {
    await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,1100",
      `--screenshot=${outPath}`,
      url,
    ]);
    log.info("captured website screenshot", { url, outPath });
    return outPath;
  } catch (err) {
    log.warn("website screenshot failed", { url, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

async function findChrome(): Promise<string | undefined> {
  const candidates = [
    config.video.chromePath,
    path.join(ROOT, "remotion/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

function run(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}
