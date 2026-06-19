import { config } from "../config/index.js";
import { token } from "../lib/ids.js";
import type { Lead, TrackedLink } from "../models/types.js";

const BASE = config.tracking.baseURL;

export const trackingUrls = {
  pixel: (messageId: string) => `${BASE}/o/${messageId}.gif`,
  click: (linkId: string) => `${BASE}/c/${linkId}`,
  unsubscribe: (unsubToken: string) => `${BASE}/u/${unsubToken}`,
  video: (videoId: string) => `${BASE}/v/${videoId}`,
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
}): { html: string; text: string; links: TrackedLink[] } {
  const { messageId, body, lead } = args;
  const links: TrackedLink[] = [];

  // Replace URLs in the HTML view with tracked redirects.
  const htmlBody = escapeHtml(body).replace(URL_RE, (url) => {
    const linkId = token(8);
    links.push({ linkId, url, label: url });
    const tracked = trackingUrls.click(linkId);
    return `<a href="${tracked}">${escapeHtml(url)}</a>`;
  });

  const htmlWithBreaks = htmlBody.replace(/\n/g, "<br>\n");
  const pixel = `<img src="${trackingUrls.pixel(messageId)}" width="1" height="1" alt="" style="display:none" />`;

  const footer = buildFooter(lead);

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">
${htmlWithBreaks}
${footer.html}
</div>${pixel}`;

  const text = `${body}\n${footer.text}`;

  return { html, text, links };
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
