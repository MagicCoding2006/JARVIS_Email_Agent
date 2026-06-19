import nodemailer from "nodemailer";
import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { NotificationsRepo } from "../repositories/index.js";
import { sendMessage as telegramSend, telegramEnabled } from "../chat/telegram-client.js";
import type { Lead } from "../models/types.js";

const log = createLogger("notify");

export type NotifyLevel = "info" | "important" | "hot";

export interface NotifyInput {
  kind: string;
  level: NotifyLevel;
  title: string;
  body: string;
  leadId?: string;
}

/**
 * Central notification fan-out. Immediate alerts (meeting booked, hot lead,
 * positive/major reply, VIP) go out now; routine info is logged for the daily
 * digest. Channels: webhook (Slack/Discord compatible), email, console, DB log.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const channels: string[] = ["console"];
  const icon = input.level === "hot" ? "🔥" : input.level === "important" ? "⭐" : "•";
  const line = `${icon} ${input.title}\n${input.body}`;

  if (input.level === "hot") log.warn(`HOT: ${input.title}`, { body: input.body });
  else log.info(input.title, { body: input.body });

  // Webhook (Slack expects {text}, Discord expects {content}; send both).
  if (config.notify.webhookURL && input.level !== "info") {
    try {
      await fetch(config.notify.webhookURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, content: line }),
      });
      channels.push("webhook");
    } catch (err) {
      log.error("webhook notify failed", err);
    }
  }

  // Telegram for important+ alerts (and the daily/weekly/monthly digests).
  if (telegramEnabled() && input.level !== "info") {
    try {
      await telegramSend(line);
      channels.push("telegram");
    } catch (err) {
      log.error("telegram notify failed", err);
    }
  }

  // Email yourself for important+ alerts.
  if (config.notify.email && config.smtp.user && input.level !== "info") {
    try {
      await sendSelfEmail(`[SDR ${input.level.toUpperCase()}] ${input.title}`, input.body);
      channels.push("email");
    } catch (err) {
      log.error("email notify failed", err);
    }
  }

  await NotificationsRepo.record({
    kind: input.kind,
    level: input.level,
    title: input.title,
    body: input.body,
    leadId: input.leadId,
    channels,
  });
}

export async function notifyHotLead(lead: Lead, reasons: string[]): Promise<void> {
  await notify({
    kind: "hot_lead",
    level: "hot",
    leadId: lead._id,
    title: `HOT LEAD — ${lead.name || lead.email} (score ${lead.score})`,
    body:
      `Company: ${lead.company ?? "n/a"}\n` +
      `Contact: ${lead.name ?? lead.email} (${lead.title ?? ""})\n` +
      `Email: ${lead.email}\n` +
      `Signals: ${reasons.join(", ")}\n` +
      `Recommended: call today.`,
  });
}

export async function notifyReply(lead: Lead, classification: string, summary: string): Promise<void> {
  const hot = classification === "positive" || classification === "request_info";
  await notify({
    kind: "reply",
    level: hot ? "hot" : "important",
    leadId: lead._id,
    title: `Reply (${classification}) — ${lead.name || lead.email}`,
    body: `${summary}\nEmail: ${lead.email}`,
  });
}

export async function notifyMeetingBooked(lead: Lead, when?: string): Promise<void> {
  await notify({
    kind: "meeting_booked",
    level: "hot",
    leadId: lead._id,
    title: `📅 Meeting booked — ${lead.name || lead.email}`,
    body: `${lead.company ?? ""} ${when ? `at ${when}` : ""}\nEmail: ${lead.email}`,
  });
}

let selfTransport: nodemailer.Transporter | null = null;
async function sendSelfEmail(subject: string, text: string): Promise<void> {
  if (!selfTransport) {
    selfTransport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  await selfTransport.sendMail({
    from: { name: config.mail.fromName, address: config.mail.fromEmail },
    to: config.notify.email,
    subject,
    text,
  });
}
