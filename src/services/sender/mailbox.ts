import { readFileSync } from "node:fs";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { MessagesRepo } from "../../repositories/index.js";
import { SmtpSender } from "./smtp.sender.js";
import type { EmailSender } from "./sender.interface.js";

const log = createLogger("mailbox");

/**
 * A single sending identity in the rotation pool. Each mailbox sends from its
 * own SMTP credentials and carries its own daily cap + warmup state, so volume
 * is spread across addresses instead of burning one domain.
 */
export interface Mailbox {
  email: string;
  fromName: string;
  replyTo: string;
  smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string };
  /** IMAP connection for reply polling (auth reuses the SMTP user/pass). */
  imap: { host: string; port: number; secure: boolean };
  /** Ceiling once fully warmed. */
  dailyCap: number;
  /** Whether the warmup ramp applies to this mailbox. */
  warmup: boolean;
}

export interface MailboxCapacity {
  email: string;
  /** Today's effective cap (warmup-adjusted). */
  cap: number;
  sentToday: number;
  remaining: number;
  /** Days since this mailbox's first-ever send (0 = first day). */
  warmupDay: number;
}

// ── Roster loading ────────────────────────────────────────────────────────────

let cachedRoster: Mailbox[] | null = null;
const senders = new Map<string, EmailSender>();

function coerceMailbox(m: Record<string, unknown>): Mailbox | null {
  const email = typeof m.email === "string" ? m.email.trim().toLowerCase() : "";
  if (!email) return null;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const s = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim() : d);
  return {
    email,
    fromName: s(m.fromName, config.mail.fromName),
    replyTo: s(m.replyTo, email),
    smtp: {
      host: s(m.host, config.smtp.host),
      port: n(m.port, config.smtp.port),
      secure: typeof m.secure === "boolean" ? m.secure : config.smtp.secure,
      user: s(m.user, email),
      pass: s(m.pass, config.smtp.pass),
    },
    imap: {
      host: s(m.imapHost, config.imap.host),
      port: n(m.imapPort, config.imap.port),
      secure: typeof m.imapSecure === "boolean" ? m.imapSecure : config.imap.secure,
    },
    dailyCap: n(m.dailyCap, config.mailboxes.defaultDailyCap),
    warmup: typeof m.warmup === "boolean" ? m.warmup : config.mailboxes.warmup.enabled,
  };
}

function parseRoster(): Mailbox[] {
  const raw = config.mailboxes.rosterFile
    ? safeReadFile(config.mailboxes.rosterFile)
    : config.mailboxes.roster;
  if (!raw || !raw.trim()) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch (err) {
    log.error("MAILBOXES is not valid JSON — falling back to single mailbox", err);
    return [];
  }
  if (!Array.isArray(arr)) {
    log.error("MAILBOXES must be a JSON array — falling back to single mailbox");
    return [];
  }
  const boxes = arr
    .map((m) => coerceMailbox(m as Record<string, unknown>))
    .filter((m): m is Mailbox => m !== null);
  // De-dupe by email (first wins).
  const seen = new Set<string>();
  return boxes.filter((m) => (seen.has(m.email) ? false : (seen.add(m.email), true)));
}

function safeReadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    log.error(`could not read MAILBOXES_FILE at ${path}`, err);
    return "";
  }
}

/** The sending pool. Falls back to a single mailbox from smtp/mail (back-compat). */
export function getMailboxes(): Mailbox[] {
  if (cachedRoster) return cachedRoster;
  const roster = parseRoster();
  if (roster.length) {
    cachedRoster = roster;
    log.info(`loaded ${roster.length} sending mailbox(es) for rotation`);
  } else {
    cachedRoster = [
      {
        email: config.mail.fromEmail.toLowerCase(),
        fromName: config.mail.fromName,
        replyTo: config.mail.replyTo,
        smtp: { ...config.smtp },
        imap: { host: config.imap.host, port: config.imap.port, secure: config.imap.secure },
        dailyCap: config.mailboxes.defaultDailyCap,
        warmup: config.mailboxes.warmup.enabled,
      },
    ];
  }
  return cachedRoster;
}

export function getMailboxByEmail(email: string): Mailbox | undefined {
  const e = email.trim().toLowerCase();
  return getMailboxes().find((m) => m.email === e);
}

/** A throwaway mailbox for a from-address outside the roster (e.g. campaign pin). */
function syntheticMailbox(email: string): Mailbox {
  return {
    email: email.trim().toLowerCase(),
    fromName: config.mail.fromName,
    replyTo: config.mail.replyTo,
    smtp: { ...config.smtp },
    imap: { host: config.imap.host, port: config.imap.port, secure: config.imap.secure },
    dailyCap: config.mailboxes.defaultDailyCap,
    warmup: false,
  };
}

/** Cached SMTP transport bound to a mailbox's own credentials. */
export function senderForMailbox(mb: Mailbox): EmailSender {
  let s = senders.get(mb.email);
  if (!s) {
    s = new SmtpSender(mb.smtp, `smtp:${mb.email}`);
    senders.set(mb.email, s);
  }
  return s;
}

// ── Warmup + capacity ─────────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/** Effective daily cap for a mailbox on a given warmup day (0-based). */
export function warmupCap(mb: Mailbox, warmupDay: number): number {
  if (!mb.warmup) return mb.dailyCap;
  const w = config.mailboxes.warmup;
  const ramped = w.startPerDay + Math.max(0, warmupDay) * w.incrementPerDay;
  return Math.max(0, Math.min(mb.dailyCap, w.maxPerDay, ramped));
}

/** Compute a mailbox's remaining send capacity for today. */
export async function capacityFor(mb: Mailbox): Promise<MailboxCapacity> {
  const todayStart = startOfDay(new Date());
  const [sentToday, firstSent] = await Promise.all([
    MessagesRepo.countSentSinceFrom(todayStart, mb.email),
    mb.warmup ? MessagesRepo.firstSentAtFrom(mb.email) : Promise.resolve(null),
  ]);
  const warmupDay = firstSent
    ? Math.floor((todayStart.getTime() - startOfDay(firstSent).getTime()) / 86_400_000)
    : 0;
  const cap = warmupCap(mb, warmupDay);
  return { email: mb.email, cap, sentToday, remaining: Math.max(0, cap - sentToday), warmupDay };
}

/** Capacity for any from-address (roster mailbox or a synthetic pinned one). */
export function capacityForEmail(email: string): Promise<MailboxCapacity> {
  return capacityFor(getMailboxByEmail(email) ?? syntheticMailbox(email));
}

/** Capacities for every roster mailbox, keyed by email. */
export async function allCapacities(): Promise<Map<string, MailboxCapacity>> {
  const entries = await Promise.all(getMailboxes().map(capacityFor));
  return new Map(entries.map((e) => [e.email, e]));
}

/**
 * Choose the sticky mailbox for a new prospect. Picks the mailbox with the most
 * remaining capacity today (tie-broken by lowest fill ratio) so load spreads
 * evenly. Never returns null — send-time cap checks handle throttling.
 */
export async function assignMailbox(): Promise<Mailbox> {
  const boxes = getMailboxes();
  if (boxes.length === 1) return boxes[0];
  const caps = await allCapacities();
  return [...boxes].sort((a, b) => {
    const ca = caps.get(a.email)!;
    const cb = caps.get(b.email)!;
    if (cb.remaining !== ca.remaining) return cb.remaining - ca.remaining;
    return ca.sentToday / Math.max(1, ca.cap) - cb.sentToday / Math.max(1, cb.cap);
  })[0];
}
