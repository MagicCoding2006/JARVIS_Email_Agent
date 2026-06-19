import { createLogger } from "../lib/logger.js";
import { EnrollmentsRepo, EventsRepo, LeadsRepo, MessagesRepo } from "../repositories/index.js";
import { applyScore } from "../services/scoring.service.js";
import { ESCALATION } from "../services/scoring.config.js";
import { notifyHotLead, notifyMeetingBooked } from "../services/notifications.service.js";
import { rollupEventToVariant } from "../services/variants.service.js";
import type { Event } from "../models/types.js";

const log = createLogger("event-processor");

// Reply notifications are handled in replies.service; don't double-notify here.
const REPLY_TYPES = new Set([
  "reply",
  "positive_reply",
  "negative_reply",
  "neutral_reply",
  "out_of_office",
  "request_info",
]);

/**
 * Batch-process unprocessed events: apply scores, then run side effects
 * (escalation, sequence stops, status changes). Designed to run on a schedule
 * (e.g. hourly) so we DON'T call models/logic on every single open or click.
 */
export async function processEvents(): Promise<{ processed: number }> {
  const events = await EventsRepo.getUnprocessed(1000);
  for (const ev of events) {
    const { delta, newScore } = await applyScore(ev);
    await EventsRepo.markProcessed(ev._id, delta);
    await rollupVariantStats(ev);
    await handleSideEffects(ev, newScore, delta);
  }
  if (events.length) log.info(`processed ${events.length} events`);
  return { processed: events.length };
}

async function handleSideEffects(ev: Event, newScore: number, delta: number): Promise<void> {
  switch (ev.type) {
    case "booked": {
      await EnrollmentsRepo.stopAllForLead(ev.leadId, "converted", "meeting booked");
      await LeadsRepo.setStatus(ev.leadId, "meeting");
      const lead = await LeadsRepo.getById(ev.leadId);
      if (lead) await notifyMeetingBooked(lead, String(ev.metadata?.meeting_time ?? ""));
      return;
    }
    case "unsubscribe": {
      await LeadsRepo.setUnsubscribed(ev.leadId);
      await EnrollmentsRepo.stopAllForLead(ev.leadId, "stopped", "unsubscribed");
      return;
    }
    case "bounce": {
      await LeadsRepo.setBounced(ev.leadId);
      await EnrollmentsRepo.stopAllForLead(ev.leadId, "stopped", "bounced");
      return;
    }
    case "closed_won":
      await LeadsRepo.setStatus(ev.leadId, "won");
      return;
    case "closed_lost":
      await LeadsRepo.setStatus(ev.leadId, "lost");
      return;
    default:
      break;
  }

  // Engagement escalation: notify the moment a lead crosses into the HOT band.
  if (!REPLY_TYPES.has(ev.type)) {
    const crossedHot = newScore >= ESCALATION.hot && newScore - delta < ESCALATION.hot;
    if (crossedHot) {
      const lead = await LeadsRepo.getById(ev.leadId);
      if (lead) {
        const recent = await EventsRepo.recentForLead(ev.leadId, 10);
        const reasons = summarizeSignals(recent);
        await notifyHotLead(lead, reasons);
      }
    }
  }
}

const VARIANT_EVENTS = new Set(["sent", "open", "click", "reply", "positive_reply", "booked", "closed_won"]);

/** Attribute an event to its message's A/B variant so the bandit can learn. */
async function rollupVariantStats(ev: Event): Promise<void> {
  if (!ev.messageId || !VARIANT_EVENTS.has(ev.type)) return;
  const msg = await MessagesRepo.getById(ev.messageId);
  if (msg?.variantId) await rollupEventToVariant(msg.variantId, ev.type, ev.metadata);
}

function summarizeSignals(events: Event[]): string[] {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return Object.entries(counts).map(([t, n]) => (n > 1 ? `${t} x${n}` : t));
}
