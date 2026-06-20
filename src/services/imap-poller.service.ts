import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { MailboxStateRepo, MessagesRepo } from "../repositories/index.js";
import { getMailboxes, type Mailbox } from "./sender/mailbox.js";
import { handleInboundReply } from "./replies.service.js";

const log = createLogger("imap");

/** Whether the IMAP reply poller is turned on. */
export function imapEnabled(): boolean {
  return config.imap.enabled;
}

/** Mailboxes we can actually log into (need IMAP creds = the SMTP user/pass). */
function pollableMailboxes(): Mailbox[] {
  return getMailboxes().filter((mb) => mb.smtp.user && mb.smtp.pass);
}

/**
 * Strip quoted history and signatures so the classifier sees only the new reply.
 * Cheap but effective: cut at the first quote marker or quoted line.
 */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^On\b.+\bwrote:?$/i.test(t)) break; // "On <date>, <name> wrote:"
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break; // Outlook divider
    if (out.length && /^(from|sent|to|subject|date):\s/i.test(t)) break; // quoted header block
    if (t.startsWith(">")) continue; // quoted line
    out.push(line);
  }
  return out.join("\n").trim() || text.trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Resolve an inbound reply's In-Reply-To/References to the touch it answers. */
async function resolveInternalMessageId(headerIds: string[]): Promise<string | undefined> {
  for (const h of headerIds) {
    if (!h) continue;
    const msg = await MessagesRepo.findByMessageIdHeader(h.trim());
    if (msg) return msg._id;
  }
  return undefined;
}

/** Process one fetched message: parse, map to a lead/touch, ingest the reply. */
async function processMessage(
  raw: FetchMessageObject,
  ownEmails: Set<string>,
): Promise<boolean> {
  if (!raw.source) return false;
  const parsed = await simpleParser(raw.source);

  const fromEmail = parsed.from?.value?.[0]?.address?.trim().toLowerCase();
  if (!fromEmail) return false;
  if (ownEmails.has(fromEmail)) return false; // ignore our own sends/auto-CCs

  const refs = parsed.references
    ? Array.isArray(parsed.references)
      ? parsed.references
      : [parsed.references]
    : [];
  const headerIds = [parsed.inReplyTo, ...refs].filter((x): x is string => Boolean(x));
  const messageId = await resolveInternalMessageId(headerIds);

  const bodyRaw = parsed.text || (parsed.html ? htmlToText(parsed.html) : "");
  const text = stripQuoted(bodyRaw);
  if (!text) return false;

  const { leadId } = await handleInboundReply({ fromEmail, text, messageId });
  return Boolean(leadId);
}

/**
 * Poll one mailbox's INBOX for messages newer than the stored UID cursor and
 * ingest any that are replies from known leads. Non-destructive: never marks
 * mail seen — it advances a per-mailbox UID cursor instead.
 */
async function pollMailbox(mb: Mailbox, ownEmails: Set<string>): Promise<number> {
  const client = new ImapFlow({
    host: mb.imap.host,
    port: mb.imap.port,
    secure: mb.imap.secure,
    auth: { user: mb.smtp.user!, pass: mb.smtp.pass! },
    logger: false,
  });

  let handled = 0;
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const box = client.mailbox;
    if (!box || typeof box === "boolean") return 0;
    const uidValidity = Number(box.uidValidity);
    const highestUid = Number(box.uidNext) - 1;

    const state = await MailboxStateRepo.get(mb.email);
    const baseUid = state && state.uidValidity === uidValidity ? state.lastUid : 0;

    if (highestUid <= 0 || highestUid <= baseUid) {
      // Nothing new — just keep the cursor anchored to the current top.
      await MailboxStateRepo.set(mb.email, Math.max(baseUid, Math.max(0, highestUid)), uidValidity);
      return 0;
    }

    // First run (no/stale cursor): only look back a bounded window.
    const found =
      baseUid > 0
        ? await client.search({ uid: `${baseUid + 1}:${highestUid}` }, { uid: true })
        : await client.search(
            { since: new Date(Date.now() - config.imap.lookbackDays * 86_400_000) },
            { uid: true },
          );
    const uids = (Array.isArray(found) ? found : []).filter((u) => u > baseUid && u <= highestUid);

    if (uids.length) {
      for await (const raw of client.fetch(
        uids,
        { uid: true, source: true, envelope: true },
        { uid: true },
      )) {
        try {
          if (await processMessage(raw, ownEmails)) handled++;
        } catch (err) {
          log.error(`failed to process uid ${raw.uid} in ${mb.email}`, err);
        }
      }
    }

    // Advance the cursor past everything we covered (older mail is intentionally skipped).
    await MailboxStateRepo.set(mb.email, highestUid, uidValidity);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return handled;
}

let polling = false;

/**
 * Poll every pollable mailbox once. Guarded against overlapping runs. No-ops
 * cleanly when IMAP is disabled or no mailbox has credentials.
 */
export async function pollReplies(): Promise<{ mailboxes: number; replies: number }> {
  if (!imapEnabled()) return { mailboxes: 0, replies: 0 };
  if (polling) {
    log.debug("poll already in progress — skipping");
    return { mailboxes: 0, replies: 0 };
  }
  polling = true;
  const boxes = pollableMailboxes();
  const ownEmails = new Set(getMailboxes().map((m) => m.email));
  let replies = 0;
  try {
    for (const mb of boxes) {
      try {
        replies += await pollMailbox(mb, ownEmails);
      } catch (err) {
        log.error(`IMAP poll failed for ${mb.email}`, err);
      }
    }
  } finally {
    polling = false;
  }
  if (replies) log.info(`ingested ${replies} repl${replies === 1 ? "y" : "ies"} from ${boxes.length} mailbox(es)`);
  return { mailboxes: boxes.length, replies };
}
