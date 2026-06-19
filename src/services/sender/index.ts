import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { SmtpSender } from "./smtp.sender.js";
import type { EmailSender, SendRequest, SendResult } from "./sender.interface.js";

const log = createLogger("sender:dryrun");

/** Logs the email instead of sending. Used when DRY_RUN=true. */
class DryRunSender implements EmailSender {
  readonly name = "dry-run";
  async verify(): Promise<boolean> {
    return true;
  }
  async send(req: SendRequest): Promise<SendResult> {
    log.info(`[DRY RUN] would send to ${req.to}`, {
      subject: req.subject,
      preview: req.text.slice(0, 140),
    });
    return { messageId: req.messageId ?? `dryrun-${Date.now()}`, accepted: true, detail: "dry-run" };
  }
}

let cached: EmailSender | null = null;

/** Returns the active sender, honoring DRY_RUN. */
export function getSender(): EmailSender {
  if (cached) return cached;
  cached = config.sending.dryRun ? new DryRunSender() : new SmtpSender();
  return cached;
}

export type { EmailSender, SendRequest, SendResult } from "./sender.interface.js";
