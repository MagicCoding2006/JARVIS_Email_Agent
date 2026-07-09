import nodemailer from "nodemailer";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import type { EmailSender, SendRequest, SendResult } from "./sender.interface.js";

const log = createLogger("sender:graph");

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

let cachedToken = "";
let tokenExpiresAt = 0;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const body = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  const result = (await response.json()) as TokenResponse;
  if (!response.ok || !result.access_token) {
    throw new Error(
      `Microsoft OAuth failed (${response.status}): ${result.error_description ?? result.error ?? "unknown error"}`,
    );
  }

  cachedToken = result.access_token;
  tokenExpiresAt = Date.now() + (result.expires_in ?? 3600) * 1000;
  return cachedToken;
}

/**
 * Sends RFC822 MIME through Microsoft Graph over HTTPS. MIME preserves the
 * existing Message-ID, threading, reply-to, and unsubscribe headers.
 */
export class MicrosoftGraphSender implements EmailSender {
  readonly name: string;
  private readonly mailbox: string;
  private readonly mimeBuilder = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });

  constructor(mailbox: string) {
    this.mailbox = mailbox.trim().toLowerCase();
    this.name = `microsoft-graph:${this.mailbox}`;
  }

  async verify(): Promise<boolean> {
    try {
      await accessToken();
      log.info(`Microsoft Graph authentication verified for ${this.mailbox}`);
      return true;
    } catch (err) {
      log.error("Microsoft Graph authentication failed", err);
      return false;
    }
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.fromEmail.trim().toLowerCase() !== this.mailbox) {
      throw new Error(`Graph sender for ${this.mailbox} cannot send as ${req.fromEmail}`);
    }

    const built = await this.mimeBuilder.sendMail({
      from: { name: req.fromName, address: req.fromEmail },
      to: req.to,
      replyTo: req.replyTo,
      subject: req.subject,
      text: req.text,
      html: req.html,
      messageId: req.messageId,
      inReplyTo: req.inReplyTo,
      references: req.references,
      headers: req.headers,
    });
    const mime = Buffer.isBuffer(built.message)
      ? built.message.toString("base64")
      : Buffer.from(String(built.message)).toString("base64");
    const token = await accessToken();
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.mailbox)}/sendMail`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
        },
        body: mime,
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Microsoft Graph send failed (${response.status}): ${detail.slice(0, 1000)}`);
    }
    return {
      messageId: req.messageId ?? "",
      accepted: true,
      detail: `Microsoft Graph accepted (${response.status})`,
    };
  }
}
