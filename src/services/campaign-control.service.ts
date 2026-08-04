import { createLogger } from "../lib/logger.js";
import { CampaignsRepo, EnrollmentsRepo, MessagesRepo } from "../repositories/index.js";
import type { CampaignStatus, EnrollmentStatus } from "../models/types.js";

const log = createLogger("campaign-control");

/**
 * Whether a campaign in this state may still put mail on the wire, and what to
 * do with a touch that is already queued for it. Pure — the dispatcher's guard
 * and the smoke test both read it.
 *
 *   active           → send
 *   paused           → hold: leave the message scheduled so resuming the
 *                      campaign resumes the sequence where it left off
 *   draft / archived → drop: these must never send, so the queued touch is
 *                      marked skipped permanently
 */
export type SendDisposition = "send" | "hold" | "drop";

export function dispositionForCampaignStatus(status: CampaignStatus | undefined): SendDisposition {
  if (status === "active") return "send";
  if (status === "paused") return "hold";
  return "drop"; // draft, archived, or a campaign that no longer exists
}

/** Enrollment states that can still generate sends, per `statusFilter`. */
const CANCELLABLE: Record<"active" | "all", EnrollmentStatus[]> = {
  active: ["active"],
  // "all" means everything still in flight — terminal states (completed,
  // replied, stopped, converted) are history and are never rewritten.
  all: ["active", "paused"],
};

export interface CancelCampaignEnrollmentsInput {
  /** Campaign name or id. */
  campaign: string;
  /** Which enrollments to cancel (default "active"). */
  statusFilter?: "active" | "all";
  /**
   * Also cancel the campaign's queued messages (default true — this is the
   * point). Campaign-wide, so touches orphaned under an already-stopped
   * enrollment get purged too.
   */
  cancelDueMessages?: boolean;
  /** Preview only: count what would change, write nothing. */
  dryRun?: boolean;
  /** Stored on each enrollment as `stopReason`. */
  reason?: string;
}

export interface CancelCampaignEnrollmentsResult {
  campaign: string;
  campaignId: string;
  campaignStatus: CampaignStatus;
  matchedEnrollments: number;
  cancelledEnrollments: number;
  cancelledScheduledMessages: number;
  dryRun: boolean;
}

/**
 * Stop a campaign from sending anything further: mark its in-flight enrollments
 * `stopped` and cancel every touch still queued for them. Idempotent — a second
 * run matches nothing. Use `dryRun` first to see the blast radius.
 */
export async function cancelCampaignEnrollments(
  input: CancelCampaignEnrollmentsInput,
): Promise<CancelCampaignEnrollmentsResult | { error: string; candidates?: string[] }> {
  const campaign =
    (await CampaignsRepo.getById(input.campaign)) ?? (await CampaignsRepo.getByName(input.campaign));
  if (!campaign) {
    const all = await CampaignsRepo.list();
    return {
      error: `campaign not found: ${input.campaign}`,
      candidates: all.map((c) => c.name).slice(0, 20),
    };
  }

  const statusFilter = input.statusFilter ?? "active";
  const cancelDueMessages = input.cancelDueMessages !== false;
  const dryRun = input.dryRun === true;

  const enrollments = await EnrollmentsRepo.listForCampaign(campaign._id, CANCELLABLE[statusFilter]);
  const ids = enrollments.map((e) => e._id);

  const base = {
    campaign: campaign.name,
    campaignId: campaign._id,
    campaignStatus: campaign.status,
    matchedEnrollments: ids.length,
    dryRun,
  };

  if (dryRun) {
    return {
      ...base,
      cancelledEnrollments: ids.length,
      cancelledScheduledMessages: cancelDueMessages
        ? await MessagesRepo.countScheduledForCampaign(campaign._id)
        : 0,
    };
  }

  // Cancel queued mail FIRST: if the second write fails, the worst case is a
  // campaign with no pending sends, not enrollments still spraying follow-ups.
  const cancelledScheduledMessages = cancelDueMessages
    ? await MessagesRepo.cancelScheduledForCampaign(campaign._id)
    : 0;
  const reason = input.reason ?? `campaign ${campaign.status} — enrollments cancelled`;
  const cancelledEnrollments = await EnrollmentsRepo.stopMany(ids, "stopped", reason);

  log.info(
    `cancelled ${cancelledEnrollments} enrollment(s) and ${cancelledScheduledMessages} queued message(s) for "${campaign.name}"`,
  );
  return { ...base, cancelledEnrollments, cancelledScheduledMessages };
}
