import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { CallsRepo, CampaignsRepo, EventsRepo, LeadsRepo } from "../repositories/index.js";
import { canCall, normalizePhone, staleCallCutoff } from "../services/voice/compliance.service.js";
import { getTelephony } from "../services/voice/twilio.telephony.js";
import { realtimeAuthCheck } from "../services/voice/openai-realtime.js";
import { answerUrl, statusUrl } from "../server/voice.routes.js";
import { dispositionForCampaignStatus } from "../services/campaign-control.service.js";

const log = createLogger("dialer");

/**
 * The voice channel's dispatcher.
 *
 * Same shape as `dispatchDue`, and same discipline: it picks up due rows,
 * re-checks every guardrail at the last possible moment, and places calls one
 * at a time. Nothing here decides WHO to call — the agent, the CLI, or a
 * campaign does that when it queues the row. This just decides whether a queued
 * call may legally and safely dial right now.
 */
export async function dialDue(): Promise<{ placed: number; skipped: number }> {
  if (!config.voice.enabled) {
    log.info("voice channel disabled (VOICE_ENABLED=false) — nothing to dial");
    return { placed: 0, skipped: 0 };
  }

  const telephony = getTelephony();
  if (!telephony.configured()) {
    log.warn(`telephony provider "${telephony.name}" is not configured — skipping run`);
    return { placed: 0, skipped: 0 };
  }

  // Never ring a stranger we can't talk to. Without this the call connects,
  // the prospect says "hello?", the bridge finds no credentials and drops the
  // line — the worst possible outcome for both them and the brand.
  //
  // This resolves a real bearer rather than checking that a key is non-empty,
  // so it also catches an OAuth token that refresh can no longer renew or that
  // would expire partway through the conversation.
  const voice = await realtimeAuthCheck();
  if (!voice.ready) {
    log.error(`voice credentials not usable — refusing to dial: ${voice.reason}`);
    return { placed: 0, skipped: 0 };
  }
  if (voice.warning) log.warn(voice.warning);

  // Release slots held by calls that can no longer be live. Without this a
  // single crashed bridge silently shrinks the concurrency budget, and enough
  // of them stop the dialer permanently.
  const staleBefore = staleCallCutoff();
  const reaped = await CallsRepo.reapStale(staleBefore);
  if (reaped) log.warn(`reaped ${reaped} stale in-flight call${reaped === 1 ? "" : "s"}`);

  const due = await CallsRepo.dueQueued(config.voice.dialing.maxConcurrent * 4);
  if (!due.length) return { placed: 0, skipped: 0 };

  let placed = 0;
  let skipped = 0;

  for (const call of due) {
    const lead = await LeadsRepo.getById(call.leadId);
    if (!lead) {
      await CallsRepo.setStatus(call._id, "skipped", { failureReason: "lead no longer exists" });
      skipped++;
      continue;
    }

    // A paused or archived campaign must not keep dialing, exactly as it must
    // not keep emailing — same disposition rule the dispatcher uses, so a
    // paused campaign holds its queued calls for the resume and a draft or
    // archived one drops them for good.
    if (call.campaignId) {
      const campaign = await CampaignsRepo.getById(call.campaignId);
      const disposition = dispositionForCampaignStatus(campaign?.status);
      if (disposition === "hold") continue;
      if (disposition === "drop") {
        await CallsRepo.setStatus(call._id, "skipped", {
          failureReason: `campaign ${campaign?.status ?? "missing"}`,
        });
        skipped++;
        continue;
      }
    }

    const gate = await canCall(lead);
    if (!gate.allowed) {
      // Out-of-hours isn't a failure — the prospect just isn't awake yet, so
      // the row stays queued for a later run instead of being burned.
      if (gate.reason === "outside_hours" || gate.reason === "weekend" || gate.reason === "max_concurrent") {
        log.debug(`holding call ${call._id}: ${gate.detail}`);
        continue;
      }
      await CallsRepo.setStatus(call._id, "skipped", { failureReason: `${gate.reason}: ${gate.detail}` });
      log.info(`skipped call ${call._id} — ${gate.reason}: ${gate.detail}`);
      skipped++;
      continue;
    }

    const to = normalizePhone(lead.phone);
    if (!to) {
      await CallsRepo.setStatus(call._id, "skipped", { failureReason: "unusable phone number" });
      skipped++;
      continue;
    }

    try {
      const result = await telephony.placeCall({
        to,
        from: call.fromNumber || config.voice.twilio.fromNumber,
        callId: call._id,
        answerUrl: answerUrl(call._id),
        statusUrl: statusUrl(call._id),
        record: config.voice.record,
      });
      await CallsRepo.setStatus(call._id, "dialing", {
        providerCallId: result.providerCallId,
        startedAt: new Date(),
      });
      await EventsRepo.record({
        leadId: lead._id,
        campaignId: call.campaignId,
        enrollmentId: call.enrollmentId,
        type: "call_placed",
        metadata: { callId: call._id, to, attempt: call.attempt, provider: telephony.name },
      });
      if (lead.status === "new") await LeadsRepo.setStatus(lead._id, "active");
      placed++;
      log.info(`dialing ${to} for lead ${lead.email} (attempt ${call.attempt})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await CallsRepo.setStatus(call._id, "failed", { failureReason: msg, endedAt: new Date() });
      log.error(`failed to place call ${call._id}`, err);
      skipped++;
    }

    // One live conversation per line: stop as soon as the concurrency ceiling
    // is reached rather than queueing calls the carrier will run in parallel.
    if ((await CallsRepo.countLive(staleBefore)) >= config.voice.dialing.maxConcurrent) break;
  }

  if (placed || skipped) log.info(`dialer: ${placed} placed, ${skipped} skipped`);
  return { placed, skipped };
}

/**
 * Queue a call. The single entry point used by the CLI, the agent tool, and any
 * campaign automation — so the phone-number normalization and the pre-flight
 * refusal reason live in exactly one place.
 */
export async function queueCall(input: {
  leadId: string;
  campaignId?: string;
  enrollmentId?: string;
  scheduledAt?: Date;
}): Promise<{ queued: boolean; callId?: string; reason?: string }> {
  const lead = await LeadsRepo.getById(input.leadId);
  if (!lead) return { queued: false, reason: "lead not found" };

  const phone = normalizePhone(lead.phone);
  if (!phone) return { queued: false, reason: "lead has no usable phone number" };

  // Cheap upfront rejection for the permanent blockers. Time-of-day and
  // concurrency are deliberately NOT checked here — those are dial-time
  // questions, and a call queued at midnight for 9am tomorrow is valid.
  const gate = await canCall(lead);
  const permanent = new Set(["dnc", "unsubscribed", "do_not_contact", "max_attempts", "no_phone", "voice_disabled"]);
  if (!gate.allowed && gate.reason && permanent.has(gate.reason)) {
    return { queued: false, reason: `${gate.reason}: ${gate.detail}` };
  }

  const attempts = await CallsRepo.countAttemptsForLead(input.leadId);
  const call = await CallsRepo.create({
    leadId: input.leadId,
    campaignId: input.campaignId,
    enrollmentId: input.enrollmentId,
    toNumber: phone,
    fromNumber: config.voice.twilio.fromNumber,
    provider: getTelephony().name,
    attempt: attempts + 1,
    scheduledAt: input.scheduledAt,
  });
  log.info(`queued call ${call._id} → ${phone} (${lead.email})`);
  return { queued: true, callId: call._id };
}
