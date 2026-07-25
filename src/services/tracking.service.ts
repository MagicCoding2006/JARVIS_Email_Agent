import { config } from "../config/index.js";
import { token } from "../lib/ids.js";
import type { Lead, TrackedLink } from "../models/types.js";

const BASE = config.tracking.baseURL;

export const trackingUrls = {
  pixel: (messageId: string) => `${BASE}/o/${messageId}.gif`,
  click: (linkId: string) => `${BASE}/c/${linkId}`,
  unsubscribe: (unsubToken: string) => `${BASE}/u/${unsubToken}`,
  video: (videoId: string) => `${BASE}/v/${videoId}`,
  videoFile: (fileName: string) => `${BASE}/videos/${encodeURIComponent(fileName)}`,
};

const URL_RE = /https?:\/\/[^\s<>")]+/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the HTML + text bodies for an outbound email:
 *  - rewrites links in the HTML version through the click tracker
 *  - appends a 1x1 open-tracking pixel
 *  - appends a compliant unsubscribe + physical-address footer
 *
 * The plain-text version keeps the original URLs (cleaner, and most clicks
 * happen in the HTML view where the pixel also lives).
 */
export function buildTrackedContent(args: {
  messageId: string;
  body: string;
  lead: Lead;
  /** Gmail manual compose inserts plain text, so those URLs need tracking too. */
  trackTextLinks?: boolean;
}): { html: string; text: string; links: TrackedLink[] } {
  const { messageId, body, lead } = args;
  const tracked = linkifyBody(body, Boolean(args.trackTextLinks));

  const htmlWithBreaks = tracked.html.replace(/\n/g, "<br>\n");
  const pixel = `<img src="${trackingUrls.pixel(messageId)}" width="1" height="1" alt="" style="display:none" />`;

  const footer = buildFooter(lead);

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">
${htmlWithBreaks}
${footer.html}
</div>${pixel}`;

  const text = `${tracked.text}\n${footer.text}`;

  return { html, text, links: tracked.links };
}

function linkifyBody(body: string, trackTextLinks: boolean): { html: string; text: string; links: TrackedLink[] } {
  const links: TrackedLink[] = [];
  let html = "";
  let text = "";
  let last = 0;

  for (const match of body.matchAll(URL_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const { url, trailing } = stripTrailingPunctuation(raw);
    const end = start + raw.length;
    const linkId = token(8);
    const tracked = trackingUrls.click(linkId);

    links.push({ linkId, url, label: url });
    html += escapeHtml(body.slice(last, start)) + `<a href="${tracked}">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
    text += body.slice(last, start) + (trackTextLinks ? tracked : url) + trailing;
    last = end;
  }

  html += escapeHtml(body.slice(last));
  text += body.slice(last);
  return { html, text, links };
}

function stripTrailingPunctuation(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = "";
  while (/[.,!?;:]$/.test(url)) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

function buildFooter(lead: Lead): { html: string; text: string } {
  if (!config.compliance.unsubscribeFooter) return { html: "", text: "" };
  const unsub = trackingUrls.unsubscribe(lead.unsubscribeToken);
  const addr = config.compliance.companyAddress;
  const company = config.compliance.companyName;

  const text =
    `\n\n—\n${company}${addr ? `, ${addr}` : ""}\n` +
    `Not interested? Unsubscribe: ${unsub}`;

  const html =
    `<br><br><hr style="border:none;border-top:1px solid #eee;margin:16px 0">` +
    `<div style="font-size:12px;color:#888">${escapeHtml(company)}${addr ? `, ${escapeHtml(addr)}` : ""}<br>` +
    `<a href="${unsub}" style="color:#888">Unsubscribe</a></div>`;

  return { html, text };
}
