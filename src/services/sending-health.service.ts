import { config } from "../config/index.js";
import { EventsRepo } from "../repositories/index.js";

export interface SendingHealth {
  healthy: boolean;
  windowHours: number;
  sent: number;
  bounces: number;
  bounceRatePct: number;
  thresholdPct: number;
  /** Set when unhealthy — a human-readable reason for the pause. */
  reason?: string;
}

/**
 * Reputation guard. Computes the recent bounce rate and reports whether sending
 * should continue. The dispatcher consults this before each batch and pauses
 * (and alerts) when the rate spikes — a high bounce rate is the fastest way to
 * torch a sending domain, usually from a bad import or unverified emails.
 *
 * Below `bouncePauseMinSample` sends we always report healthy (too little data
 * to judge — don't pause on the first couple of bounces).
 */
export async function checkSendingHealth(): Promise<SendingHealth> {
  const windowHours = config.compliance.bounceWindowHours;
  const since = new Date(Date.now() - windowHours * 3600 * 1000);
  const counts = await EventsRepo.countByTypeSince(since);

  const sent = counts["sent"] ?? 0;
  const bounces = counts["bounce"] ?? 0;
  const bounceRatePct = sent > 0 ? Math.round((bounces / sent) * 1000) / 10 : 0;
  const thresholdPct = config.compliance.bouncePauseThresholdPct;

  const enoughSample = sent >= config.compliance.bouncePauseMinSample;
  const healthy = !enoughSample || bounceRatePct < thresholdPct;

  return {
    healthy,
    windowHours,
    sent,
    bounces,
    bounceRatePct,
    thresholdPct,
    reason: healthy
      ? undefined
      : `bounce rate ${bounceRatePct}% ≥ ${thresholdPct}% (${bounces}/${sent} sends in ${windowHours}h)`,
  };
}
