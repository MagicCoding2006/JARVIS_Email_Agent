import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { CallsRepo, DncRepo } from "../../repositories/index.js";
import type { Lead } from "../../models/types.js";

const log = createLogger("voice:compliance");

/**
 * The gate every outbound call passes through immediately before dialing.
 *
 * Deliberately NOT part of the model's judgment: a language model asked to
 * respect calling hours will mostly respect calling hours, and "mostly" is the
 * wrong standard for a channel where the failure mode is a 9pm call to someone
 * who asked you to stop. Every rule here is a plain boolean the dialer cannot
 * talk its way past, checked at dial time rather than queue time because a lead
 * can go on the DNC list between the two.
 */

export type BlockReason =
  | "voice_disabled"
  | "no_phone"
  | "dnc"
  | "unsubscribed"
  | "do_not_contact"
  | "outside_hours"
  | "weekend"
  | "max_attempts"
  | "daily_limit"
  | "max_concurrent";

export interface GateResult {
  allowed: boolean;
  reason?: BlockReason;
  detail?: string;
}

const ALLOW: GateResult = { allowed: true };
const block = (reason: BlockReason, detail: string): GateResult => ({ allowed: false, reason, detail });

/**
 * Cutoff for "this call could still plausibly be live".
 *
 * A row older than the hard hangup plus a margin lost its completion signal —
 * a crashed bridge, a missed webhook, a killed process. Counting those against
 * the concurrency ceiling would shrink the budget permanently, so both the gate
 * and the dialer's reaper measure from here.
 */
export function staleCallCutoff(at = new Date()): Date {
  return new Date(at.getTime() - (config.voice.dialing.maxCallSeconds + 180) * 1000);
}

/**
 * Normalize to E.164-ish. Assumes NANP when a bare 10-digit number shows up,
 * which is the common case for a US contractor list; anything already carrying
 * a `+` is trusted as-is.
 */
export function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 ? `+${digits}` : undefined;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Anything else we can't confidently place — refuse rather than misdial.
  return undefined;
}

/**
 * The prospect's local hour. Uses the lead's IANA timezone when we have one
 * (`America/Chicago`), and falls back to server-local time when we don't —
 * so set `timezone` on imported leads if you dial across the country.
 */
export function localHourFor(lead: Pick<Lead, "timezone">, at = new Date()): { hour: number; weekday: number } {
  const tz = lead.timezone?.trim();
  if (!tz) return { hour: at.getHours(), weekday: at.getDay() };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? at.getHours());
    const wdName = parts.find((p) => p.type === "weekday")?.value ?? "";
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wdName);
    return { hour: hour % 24, weekday: weekday >= 0 ? weekday : at.getDay() };
  } catch {
    log.warn(`unknown timezone "${tz}" — falling back to server time`);
    return { hour: at.getHours(), weekday: at.getDay() };
  }
}

/** Is it an acceptable moment to ring this specific person's phone? */
export function withinCallingHours(lead: Pick<Lead, "timezone">, at = new Date()): GateResult {
  const { windowStartHour, windowEndHour, callOnWeekends } = config.voice.dialing;
  const { hour, weekday } = localHourFor(lead, at);
  if (!callOnWeekends && (weekday === 0 || weekday === 6)) {
    return block("weekend", `local weekday ${weekday} — weekend calling is off`);
  }
  if (hour < windowStartHour || hour >= windowEndHour) {
    return block("outside_hours", `local hour ${hour} outside ${windowStartHour}:00–${windowEndHour}:00`);
  }
  return ALLOW;
}

/**
 * Full pre-dial check. Order matters: the cheap per-lead rules run before the
 * collection-wide counts so a blocked lead never costs a query.
 */
export async function canCall(lead: Lead, at = new Date()): Promise<GateResult> {
  if (!config.voice.enabled) return block("voice_disabled", "VOICE_ENABLED=false");

  const phone = normalizePhone(lead.phone);
  if (!phone) return block("no_phone", "lead has no usable E.164 phone number");

  if (lead.unsubscribed) return block("unsubscribed", "lead opted out");
  if (lead.status === "do_not_contact") return block("do_not_contact", "lead marked do_not_contact");
  if (await DncRepo.has(phone)) return block("dnc", `${phone} is on the do-not-call list`);

  const hours = withinCallingHours(lead, at);
  if (!hours.allowed) return hours;

  const attempts = await CallsRepo.countAttemptsForLead(lead._id);
  if (attempts >= config.voice.dialing.maxAttempts) {
    return block("max_attempts", `${attempts} attempts already made (max ${config.voice.dialing.maxAttempts})`);
  }

  const live = await CallsRepo.countLive(staleCallCutoff(at));
  if (live >= config.voice.dialing.maxConcurrent) {
    return block("max_concurrent", `${live} calls already in flight (max ${config.voice.dialing.maxConcurrent})`);
  }

  const startOfDay = new Date(at);
  startOfDay.setHours(0, 0, 0, 0);
  const placedToday = await CallsRepo.countPlacedSince(startOfDay);
  if (placedToday >= config.voice.dialing.dailyLimit) {
    return block("daily_limit", `${placedToday} calls placed today (max ${config.voice.dialing.dailyLimit})`);
  }

  return ALLOW;
}

/**
 * When to try again after a no-answer. Deliberately shifts the time of day on
 * each attempt — a prospect who never answers at 9am may always answer at 4pm,
 * and calling the same slot three days running is how you get marked as spam.
 */
export function nextAttemptAt(attempt: number, from = new Date()): Date {
  const { retryHours, windowStartHour, windowEndHour } = config.voice.dialing;
  const next = new Date(from.getTime() + retryHours * 3_600_000);
  const span = Math.max(1, windowEndHour - windowStartHour);
  // Walk the window across attempts, plus jitter so retries aren't clockwork.
  const hour = windowStartHour + ((attempt * Math.ceil(span / 3)) % span);
  next.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
  if (!config.voice.dialing.callOnWeekends) {
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  }
  return next;
}

/** Put a number beyond reach of the dialer, permanently. */
export async function addToDnc(
  phone: string,
  reason: string,
  source: "prospect" | "operator" | "agent",
  leadId?: string,
): Promise<string | undefined> {
  const normalized = normalizePhone(phone);
  if (!normalized) return undefined;
  await DncRepo.add(normalized, reason, source, leadId);
  if (leadId) await CallsRepo.cancelQueuedForLead(leadId, `dnc: ${reason}`);
  log.warn(`added ${normalized} to DNC (${source}): ${reason}`);
  return normalized;
}
