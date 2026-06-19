import { config } from "../config/index.js";
import { uuid, token } from "../lib/ids.js";
import { createLogger } from "../lib/logger.js";
import { EventsRepo, LeadsRepo, MessagesRepo } from "../repositories/index.js";
import { buildTrackedContent, trackingUrls } from "./tracking.service.js";
import type { TrackedLink } from "../models/types.js";

const log = createLogger("compose");

const URL_RE = /https?:\/\/[^\s<>")]+/g;

/**
 * Port of the original "Pixel-Injectable" flow, upgraded to the unified system.
 *
 * Given a one-off email you intend to paste into Gmail's compose window, this:
 *  1. upserts the recipient as a Lead,
 *  2. records a Message (status=sent) + a `sent` event so it shows up in scoring,
 *  3. returns a console snippet that injects the body + a tracking pixel into the
 *     open Gmail Compose box — but the pixel/links now point at THIS system's
 *     tracking server, so opens/clicks land in the same pipeline as automated sends.
 *
 * Plain-text URLs in the body are swapped for tracked redirect URLs (Gmail
 * auto-linkifies them), giving click tracking on manual sends for free.
 */
export async function createGmailPixel(input: {
  email: string;
  subject: string;
  body: string;
  campaignId?: string;
}): Promise<{ consoleScript: string; messageId: string; pixelUrl: string }> {
  const lead = await LeadsRepo.upsertByEmail({
    email: input.email,
    source: "gmail-manual",
  });

  const messageId = uuid();

  // Swap raw URLs for tracked redirects (kept as plain text for Gmail).
  const links: TrackedLink[] = [];
  const trackedBody = input.body.replace(URL_RE, (url) => {
    const linkId = token(8);
    links.push({ linkId, url, label: url });
    return trackingUrls.click(linkId);
  });

  const pixelUrl = trackingUrls.pixel(messageId);
  const { html, text } = buildTrackedContent({ messageId, body: trackedBody, lead });

  await MessagesRepo.create({
    _id: messageId,
    leadId: lead._id,
    campaignId: input.campaignId ?? "manual",
    enrollmentId: "manual",
    step: 0,
    subject: input.subject,
    body: input.body,
    bodyHtml: html,
    bodyText: text,
    fromEmail: config.mail.fromEmail,
    toEmail: lead.email,
    status: "sent",
    scheduledAt: new Date(),
    sentAt: new Date(),
    trackingPixelId: messageId,
    links,
  });

  await EventsRepo.record({
    leadId: lead._id,
    messageId,
    campaignId: input.campaignId,
    type: "sent",
    metadata: { manual: true, subject: input.subject, channel: "gmail" },
  });

  const safeBody = JSON.stringify(trackedBody);
  const consoleScript = buildConsoleSnippet(safeBody, pixelUrl);

  log.info(`created gmail pixel for ${lead.email} (message ${messageId})`);
  return { consoleScript, messageId, pixelUrl };
}

function buildConsoleSnippet(safeBodyLiteral: string, pixelUrl: string): string {
  // Mirrors the original execCommand approach (avoids innerHTML), pointing the
  // pixel at this system's tracking server instead of the old Cloud Run host.
  return `(function() {
  var bodyDiv = document.querySelector('div[aria-label="Message Body"]');
  if (!bodyDiv) {
    console.error("Could not find Gmail Compose 'Message Body' div. Open Compose first.");
    return;
  }
  bodyDiv.focus();
  document.execCommand('insertText', false, ${safeBodyLiteral});
  var img = document.createElement('img');
  img.src = "${pixelUrl}";
  img.width = 1; img.height = 1; img.alt = ""; img.style.display = "none";
  bodyDiv.appendChild(img);
  console.log("✅ Tracking pixel injected.");
})();`;
}
