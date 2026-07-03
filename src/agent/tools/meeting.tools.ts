import { schema, type Tool } from "./types.js";
import { LeadsRepo } from "../../repositories/index.js";
import { calendlyEnabled, listMeetingsWithInvitees } from "../../services/calendly.service.js";

const DAY_MS = 86_400_000;

export const getMeetings: Tool = {
  name: "get_meetings",
  description:
    "Calendar reality check (Calendly): upcoming meetings, recent past meetings with no-show flags, and the overall show-rate. " +
    "Use to judge whether campaigns produce meetings that actually HOLD, not just bookings.",
  risk: "low",
  parameters: schema({
    pastDays: { type: "number", description: "Lookback window (default 30)" },
    futureDays: { type: "number", description: "Lookahead window (default 14)" },
  }),
  async run(args: { pastDays?: number; futureDays?: number }) {
    if (!calendlyEnabled()) {
      return { error: "Calendly not connected — ask the operator to set CALENDLY_API_TOKEN" };
    }
    const now = Date.now();
    const meetings = await listMeetingsWithInvitees(
      new Date(now - (args.pastDays ?? 30) * DAY_MS),
      new Date(now + (args.futureDays ?? 14) * DAY_MS),
    );

    const upcoming: unknown[] = [];
    const past: unknown[] = [];
    let held = 0;
    let noShows = 0;

    for (const m of meetings) {
      if (m.status !== "active") continue;
      const inv = m.invitees.find((i) => i.status === "active");
      const lead = inv ? await LeadsRepo.getByEmail(inv.email) : null;
      const row = {
        name: m.name,
        startTime: m.startTime,
        invitee: inv?.email,
        leadStatus: lead?.status,
        leadScore: lead?.score,
        noShow: inv?.noShow ?? false,
      };
      if (m.startTime.getTime() > now) {
        upcoming.push(row);
      } else {
        past.push(row);
        if (inv?.noShow) noShows++;
        else held++;
      }
    }

    return {
      upcoming,
      past,
      stats: {
        pastMeetings: held + noShows,
        held,
        noShows,
        showRatePct: held + noShows > 0 ? Math.round((held / (held + noShows)) * 100) : null,
        note: "no-shows only count when marked in Calendly; unmarked past meetings count as held",
      },
    };
  },
};
