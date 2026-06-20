import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import type { EmailSender, SendRequest, SendResult } from "./sender.interface.js";

const log = createLogger("sender:smtp");

export interface SmtpTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

/**
 * Generic SMTP sender (nodemailer). Works with Google Workspace, Zoho,
 * Mailgun/SES SMTP, etc. Swappable: add a GmailOAuthSender or
 * InstantlySender implementing EmailSender and wire it in ./index.ts.
 *
 * Pass a per-mailbox `SmtpTransportConfig` to bind one transport (and one set
 * of credentials) per sending mailbox; defaults to the global `config.smtp`.
 */
export class SmtpSender implements EmailSender {
  readonly name: string;
  private transporter: Transporter;

  constructor(smtp: SmtpTransportConfig = config.smtp, label = "smtp") {
    this.name = label;
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      pool: true,
      maxConnections: 1,
      maxMessages: 50,
    });
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      log.info("SMTP connection verified");
      return true;
    } catch (err) {
      log.error("SMTP verify failed", err);
      return false;
    }
  }

  async send(req: SendRequest): Promise<SendResult> {
    const info = await this.transporter.sendMail({
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
    const accepted = (info.accepted?.length ?? 0) > 0;
    return { messageId: info.messageId ?? req.messageId ?? "", accepted, detail: info.response };
  }
}
