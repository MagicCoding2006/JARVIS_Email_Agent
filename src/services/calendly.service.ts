import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("calendly");

const BASE = "https://api.calendly.com";

export function calendlyEnabled(): boolean {
  return Boolean(config.calendly.apiToken);
}

async function api<T>(path: string): Promise<T> {
  if (!config.calendly.apiToken) throw new Error("CALENDLY_API_TOKEN not set");
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${config.calendly.apiToken}` },
  });
  if (!res.ok) throw new Error(`Calendly ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export interface CalendlyMeeting {
  /** Calendly scheduled_event URI — the stable id we dedupe on. */
  uri: string;
  name: string;
  status: "active" | "canceled";
  startTime: Date;
  endTime: Date;
}

export interface CalendlyInvitee {
  email: string;
  name?: string;
  status: "active" | "canceled";
  /** Set when the host marked this invitee a no-show in Calendly. */
  noShow: boolean;
  rescheduleUrl?: string;
}

let cachedUserUri: string | null = null;

async function userUri(): Promise<string> {
  if (cachedUserUri) return cachedUserUri;
  const me = await api<{ resource: { uri: string } }>("/users/me");
  cachedUserUri = me.resource.uri;
  return cachedUserUri;
}

/** Scheduled events in a window (past + upcoming), oldest first. */
export async function listMeetings(minStart: Date, maxStart: Date): Promise<CalendlyMeeting[]> {
  const user = await userUri();
  const out: CalendlyMeeting[] = [];
  let url =
    `/scheduled_events?user=${encodeURIComponent(user)}` +
    `&min_start_time=${minStart.toISOString()}&max_start_time=${maxStart.toISOString()}` +
    `&sort=start_time:asc&count=100`;
  // Follow pagination, bounded to a sane number of pages.
  for (let page = 0; url && page < 10; page++) {
    const res = await api<{
      collection: Array<{ uri: string; name: string; status: "active" | "canceled"; start_time: string; end_time: string }>;
      pagination: { next_page?: string | null };
    }>(url);
    for (const e of res.collection) {
      out.push({
        uri: e.uri,
        name: e.name,
        status: e.status,
        startTime: new Date(e.start_time),
        endTime: new Date(e.end_time),
      });
    }
    url = res.pagination.next_page ? res.pagination.next_page.replace(BASE, "") : "";
  }
  return out;
}

/** Invitees (usually one) for a scheduled event. */
export async function listInvitees(eventUri: string): Promise<CalendlyInvitee[]> {
  const uuid = eventUri.split("/").pop();
  const res = await api<{
    collection: Array<{
      email: string;
      name?: string;
      status: "active" | "canceled";
      no_show?: { uri: string } | null;
      reschedule_url?: string;
    }>;
  }>(`/scheduled_events/${uuid}/invitees?count=100`);
  return res.collection.map((i) => ({
    email: i.email,
    name: i.name,
    status: i.status,
    noShow: Boolean(i.no_show),
    rescheduleUrl: i.reschedule_url,
  }));
}

/** Meetings joined with their invitees, tolerant of per-event fetch failures. */
export async function listMeetingsWithInvitees(
  minStart: Date,
  maxStart: Date,
): Promise<Array<CalendlyMeeting & { invitees: CalendlyInvitee[] }>> {
  const meetings = await listMeetings(minStart, maxStart);
  const out: Array<CalendlyMeeting & { invitees: CalendlyInvitee[] }> = [];
  for (const m of meetings) {
    try {
      out.push({ ...m, invitees: await listInvitees(m.uri) });
    } catch (err) {
      log.error(`invitees fetch failed for ${m.uri}`, err);
      out.push({ ...m, invitees: [] });
    }
  }
  return out;
}
