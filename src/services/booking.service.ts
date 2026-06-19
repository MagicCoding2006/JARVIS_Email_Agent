import { createLogger } from "../lib/logger.js";
import { EventsRepo, LeadsRepo } from "../repositories/index.js";

const log = createLogger("booking");

export type BookingProvider = "calendly" | "cal" | "generic";

interface NormalizedBooking {
  email?: string;
  meetingTime?: string;
  meetingType?: string;
  calendarId?: string;
}

/** Pull the fields we care about out of provider-specific webhook payloads. */
function normalize(provider: BookingProvider, body: any): NormalizedBooking {
  if (provider === "calendly") {
    // invitee.created
    const p = body?.payload ?? {};
    return {
      email: p?.email ?? p?.invitee?.email,
      meetingTime: p?.scheduled_event?.start_time ?? p?.event?.start_time,
      meetingType: p?.scheduled_event?.name ?? p?.event_type?.name,
      calendarId: p?.scheduled_event?.uri,
    };
  }
  if (provider === "cal") {
    // Cal.com BOOKING_CREATED
    const p = body?.payload ?? {};
    return {
      email: p?.attendees?.[0]?.email ?? p?.responses?.email?.value,
      meetingTime: p?.startTime,
      meetingType: p?.eventType?.title ?? p?.title,
      calendarId: p?.uid,
    };
  }
  // generic: { email, meetingTime, meetingType, calendarId }
  return {
    email: body?.email,
    meetingTime: body?.meetingTime ?? body?.start_time,
    meetingType: body?.meetingType ?? body?.type,
    calendarId: body?.calendarId,
  };
}

/**
 * Record a booked meeting. The batch event-processor then stops the sequence
 * (status=converted), sets the lead to "meeting", and fires a hot notification.
 */
export async function handleBookingWebhook(
  provider: BookingProvider,
  body: unknown,
): Promise<{ ok: boolean; leadId?: string }> {
  const b = normalize(provider, body as any);
  if (!b.email) {
    log.warn("booking webhook missing email", { provider });
    return { ok: false };
  }

  // Create the lead if this is an inbound booking from someone not yet tracked.
  const lead = await LeadsRepo.upsertByEmail({ email: b.email, source: `booking:${provider}` });

  await EventsRepo.record({
    leadId: lead._id,
    type: "booked",
    metadata: {
      provider,
      meeting_time: b.meetingTime ?? "",
      meeting_type: b.meetingType ?? "",
      calendar_id: b.calendarId ?? "",
    },
  });

  log.info(`meeting booked by ${lead.email} (${provider}) ${b.meetingTime ?? ""}`);
  return { ok: true, leadId: lead._id };
}
