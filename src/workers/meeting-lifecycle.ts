import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { EventsRepo, LeadsRepo } from "../repositories/index.js";
import { calendlyEnabled, listMeetingsWithInvitees } from "../services/calendly.service.js";
import { sendDirectToLead } from "../services/direct-send.service.js";
import { requestApproval } from "../agent/approvals.js";
import type { Lead } from "../models/types.js";

const log = createLogger("meetings");

const DAY_MS = 86_400_000;

export interface MeetingSyncResult {
  meetings: number;
  bookedBackfilled: number;
  remindersSent: number;
  noShowsRecorded: number;
}

/**
 * Hourly Calendly sync — closes the loop between "booked" and "held":
 *  1. Backfill `booked` events for meetings we never saw (webhook optional now).
 *  2. Auto-send a reminder email ~24h before each upcoming meeting (transactional
 *     — the prospect booked it — so no approval; biggest lever on show-rate).
 *  3. Record `no_show` events for invitees the host marked in Calendly, and
 *     queue a rebooking draft for one-tap approval.
 * Everything dedupes on the Calendly event URI, so re-running is safe.
 */
export async function syncMeetings(): Promise<MeetingSyncResult> {
  const result: MeetingSyncResult = { meetings: 0, bookedBackfilled: 0, remindersSent: 0, noShowsRecorded: 0 };
  if (!calendlyEnabled()) return result;

  const now = Date.now();
  const meetings = await listMeetingsWithInvitees(new Date(now - 30 * DAY_MS), new Date(now + 30 * DAY_MS));
  result.meetings = meetings.length;

  for (const m of meetings) {
    if (m.status !== "active") continue;
    for (const inv of m.invitees) {
      if (inv.status !== "active") continue;
      try {
        // 1. Backfill booked (same metadata key the Calendly webhook writes).
        if (!(await EventsRepo.existsWithMetadata("booked", "calendar_id", m.uri))) {
          const lead = await LeadsRepo.upsertByEmail({ email: inv.email, source: "booking:calendly-sync" });
          await EventsRepo.record({
            leadId: lead._id,
            type: "booked",
            metadata: {
              provider: "calendly",
              meeting_time: m.startTime.toISOString(),
              meeting_type: m.name,
              calendar_id: m.uri,
            },
          });
          result.bookedBackfilled++;
        }

        const lead = await LeadsRepo.getByEmail(inv.email);
        if (!lead || lead.unsubscribed || lead.bounced || lead.status === "do_not_contact") continue;

        // 2. Reminder when the meeting starts within the next 25 hours.
        const msUntil = m.startTime.getTime() - now;
        if (config.calendly.remindersEnabled && msUntil > 0 && msUntil < 25 * 3600_000) {
          if (!(await EventsRepo.existsWithMetadata("sent", "reminder_for", m.uri))) {
            const sent = await sendReminder(lead, m.name, m.startTime, m.uri, inv.rescheduleUrl);
            if (sent) result.remindersSent++;
          }
        }

        // 3. No-show marked in Calendly → record + queue a rebooking draft.
        if (inv.noShow && m.startTime.getTime() < now) {
          if (!(await EventsRepo.existsWithMetadata("no_show", "calendar_id", m.uri))) {
            await EventsRepo.record({
              leadId: lead._id,
              type: "no_show",
              metadata: { provider: "calendly", meeting_type: m.name, calendar_id: m.uri },
            });
            await queueNoShowRecovery(lead, m.name);
            result.noShowsRecorded++;
          }
        }
      } catch (err) {
        log.error(`meeting sync failed for ${inv.email} (${m.uri})`, err);
      }
    }
  }

  if (result.bookedBackfilled || result.remindersSent || result.noShowsRecorded) {
    log.info(
      `meeting sync: ${result.bookedBackfilled} booked backfilled, ${result.remindersSent} reminders, ${result.noShowsRecorded} no-shows`,
    );
  }
  return result;
}

async function sendReminder(
  lead: Lead,
  meetingName: string,
  startTime: Date,
  meetingUri: string,
  rescheduleUrl?: string,
): Promise<boolean> {
  const when = startTime.toLocaleString("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const firstName = lead.firstName || lead.name?.split(" ")[0] || "there";
  const body =
    `Hi ${firstName},\n\n` +
    `Quick reminder — we're on for ${meetingName} ${when}. Looking forward to it.\n\n` +
    (rescheduleUrl ? `If the time no longer works you can reschedule here: ${rescheduleUrl}\n\n` : "") +
    `Talk soon`;

  const r = await sendDirectToLead(lead, {
    body,
    subject: `See you soon — ${meetingName}`,
    eventMetadata: { kind: "meeting_reminder", reminder_for: meetingUri },
  });
  if (!r.sent) log.error(`reminder send failed for ${lead.email}: ${r.error}`);
  return r.sent;
}

async function queueNoShowRecovery(lead: Lead, meetingName: string): Promise<void> {
  const firstName = lead.firstName || lead.name?.split(" ")[0] || "there";
  const body =
    `Hi ${firstName},\n\n` +
    `Sorry we missed each other for ${meetingName} — these things happen.\n\n` +
    (config.booking.url
      ? `Want to grab a new time? ${config.booking.url}\n\n`
      : `Want to grab a new time? Reply with a couple of windows that work.\n\n`) +
    `No worries either way.`;

  const summary =
    `📅 No-show recovery — ${lead.name || lead.email}${lead.company ? ` (${lead.company})` : ""}\n` +
    `Missed: ${meetingName}\n\n` +
    `Draft:\n${body}\n\n` +
    `Approve to send a rebooking nudge.`;
  await requestApproval("send_reply", { leadEmail: lead.email, body }, summary);
  log.info(`queued no-show recovery for ${lead.email}`);
}
