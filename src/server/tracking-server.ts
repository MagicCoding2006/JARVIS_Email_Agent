import express, { type Request, type Response } from "express";
import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { ensureIndexes } from "../repositories/collections.js";
import { EventsRepo, LeadsRepo, MessagesRepo, EnrollmentsRepo, VideosRepo } from "../repositories/index.js";
import { handleInboundReply } from "../services/replies.service.js";
import { createGmailPixel } from "../services/compose.service.js";
import { handleBookingWebhook, type BookingProvider } from "../services/booking.service.js";

const log = createLogger("tracking-server");

// 1x1 transparent GIF (same approach as the existing pixel app).
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

function sendPixel(res: Response, status = 200) {
  res.status(status).set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(PIXEL);
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // ── Open tracking ──────────────────────────────────────────────────────────
  app.get("/o/:messageId.gif", async (req: Request, res: Response) => {
    const messageId = req.params.messageId;
    try {
      const msg = await MessagesRepo.getById(messageId);
      if (msg) {
        await EventsRepo.record({
          leadId: msg.leadId,
          campaignId: msg.campaignId,
          enrollmentId: msg.enrollmentId,
          messageId: msg._id,
          type: "open",
          metadata: { ua: req.get("user-agent") ?? "", ip: req.ip },
        });
      }
    } catch (err) {
      log.error("open tracking error", err);
    }
    sendPixel(res);
  });

  // ── Click tracking + redirect ────────────────────────────────────────────────
  app.get("/c/:linkId", async (req: Request, res: Response) => {
    const linkId = req.params.linkId;
    try {
      const msg = await MessagesRepo.findByLinkId(linkId);
      const link = msg?.links.find((l) => l.linkId === linkId);
      if (msg && link) {
        await EventsRepo.record({
          leadId: msg.leadId,
          campaignId: msg.campaignId,
          enrollmentId: msg.enrollmentId,
          messageId: msg._id,
          type: "click",
          metadata: { url: link.url, label: link.label, ua: req.get("user-agent") ?? "" },
        });
        return res.redirect(302, link.url);
      }
    } catch (err) {
      log.error("click tracking error", err);
    }
    return res.redirect(302, "https://google.com");
  });

  // ── Unsubscribe ──────────────────────────────────────────────────────────────
  app.get("/u/:token", async (req: Request, res: Response) => {
    try {
      const lead = await LeadsRepo.findByUnsubscribeToken(req.params.token);
      if (lead) {
        await LeadsRepo.setUnsubscribed(lead._id);
        await EnrollmentsRepo.stopAllForLead(lead._id, "stopped", "unsubscribed");
        await EventsRepo.record({ leadId: lead._id, type: "unsubscribe", metadata: {} });
        log.info(`unsubscribed ${lead.email}`);
      }
    } catch (err) {
      log.error("unsubscribe error", err);
    }
    res
      .status(200)
      .send(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px">` +
          `<h2>You've been unsubscribed</h2><p>You won't receive further emails from us.</p></body></html>`,
      );
  });

  // ── Video watch tracking + redirect ─────────────────────────────────────────
  app.get("/v/:id", async (req: Request, res: Response) => {
    try {
      const asset = await VideosRepo.getById(req.params.id);
      if (asset) {
        const percent = Math.max(0, Math.min(100, Number(req.query.p ?? 0)));
        await VideosRepo.recordWatch(asset._id, percent);
        await EventsRepo.record({
          leadId: asset.leadId,
          campaignId: asset.campaignId,
          type: "video_watched",
          metadata: { videoId: asset._id, percent },
        });
        if (asset.videoUrl) return res.redirect(302, asset.videoUrl);
        return res
          .status(200)
          .send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Your video is being prepared…</h2></body></html>`);
      }
    } catch (err) {
      log.error("video tracking error", err);
    }
    return res.redirect(302, "https://google.com");
  });

  // ── Gmail compose pixel (ported from Pixel-Injectable) ──────────────────────
  // POST {email, subject, body, campaignId?} → returns a Gmail console snippet
  // whose pixel/links point at THIS tracking server.
  app.post("/api/createPixel", async (req: Request, res: Response) => {
    const { email, subject, body, campaignId } = req.body ?? {};
    if (!email || !subject || !body) {
      return res.status(400).json({ error: "email, subject, and body are required" });
    }
    try {
      const result = await createGmailPixel({ email, subject, body, campaignId });
      return res.json(result);
    } catch (err) {
      log.error("createPixel error", err);
      return res.status(500).json({ error: "internal error" });
    }
  });

  // ── Meeting booking webhook (Calendly / Cal.com / generic) ──────────────────
  app.post("/webhook/booking/:provider", async (req: Request, res: Response) => {
    const provider = (req.params.provider as BookingProvider) || "generic";
    try {
      const result = await handleBookingWebhook(provider, req.body);
      return res.json(result);
    } catch (err) {
      log.error("booking webhook error", err);
      return res.status(500).json({ error: "internal error" });
    }
  });

  // ── Inbound reply webhook ────────────────────────────────────────────────────
  // Wire Instantly / SES / Mailgun inbound (or a Zapier) to POST here.
  app.post("/webhook/reply", async (req: Request, res: Response) => {
    const secret = req.get("x-webhook-secret") || req.body?.secret;
    if (secret !== config.tracking.replyWebhookSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const fromEmail = req.body?.fromEmail || req.body?.from;
    const text = req.body?.text || req.body?.body || "";
    const messageId = req.body?.messageId || req.body?.inReplyTo;
    if (!fromEmail || !text) {
      return res.status(400).json({ error: "fromEmail and text required" });
    }
    try {
      const result = await handleInboundReply({ fromEmail, text, messageId });
      return res.json({ ok: true, ...result });
    } catch (err) {
      log.error("reply webhook error", err);
      return res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}

export async function startTrackingServer(): Promise<void> {
  await ensureIndexes();
  const app = createApp();
  app.listen(config.tracking.port, () => {
    log.info(`tracking server listening on :${config.tracking.port} (public: ${config.tracking.baseURL})`);
  });
}

// Allow running standalone: `npm run tracking-server`
if (import.meta.url === `file://${process.argv[1]}`) {
  startTrackingServer().catch((err) => {
    log.error("failed to start", err);
    process.exit(1);
  });
}
