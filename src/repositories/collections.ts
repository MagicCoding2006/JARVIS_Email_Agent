import type { Collection } from "mongodb";
import { getDb } from "../lib/mongo.js";
import { createLogger } from "../lib/logger.js";
import type {
  Lead,
  Campaign,
  Enrollment,
  Message,
  Event,
  Variant,
  Hypothesis,
  NotificationLog,
  VideoAsset,
  Approval,
  MailboxState,
  PlaybookNote,
  SendPaceOverride,
  Call,
  DncEntry,
} from "../models/types.js";

const log = createLogger("db");

export const COLLECTIONS = {
  leads: "leads",
  campaigns: "campaigns",
  enrollments: "enrollments",
  messages: "messages",
  events: "events",
  variants: "variants",
  hypotheses: "hypotheses",
  notifications: "notifications",
  videos: "videos",
  approvals: "approvals",
  mailboxStates: "mailbox_states",
  playbookNotes: "playbook_notes",
  sendPace: "send_pace",
  calls: "calls",
  dnc: "dnc",
} as const;

export interface Collections {
  leads: Collection<Lead>;
  campaigns: Collection<Campaign>;
  enrollments: Collection<Enrollment>;
  messages: Collection<Message>;
  events: Collection<Event>;
  variants: Collection<Variant>;
  hypotheses: Collection<Hypothesis>;
  notifications: Collection<NotificationLog>;
  videos: Collection<VideoAsset>;
  approvals: Collection<Approval>;
  mailboxStates: Collection<MailboxState>;
  playbookNotes: Collection<PlaybookNote>;
  sendPace: Collection<SendPaceOverride>;
  calls: Collection<Call>;
  dnc: Collection<DncEntry>;
}

export async function getCollections(): Promise<Collections> {
  const db = await getDb();
  return {
    leads: db.collection<Lead>(COLLECTIONS.leads),
    campaigns: db.collection<Campaign>(COLLECTIONS.campaigns),
    enrollments: db.collection<Enrollment>(COLLECTIONS.enrollments),
    messages: db.collection<Message>(COLLECTIONS.messages),
    events: db.collection<Event>(COLLECTIONS.events),
    variants: db.collection<Variant>(COLLECTIONS.variants),
    hypotheses: db.collection<Hypothesis>(COLLECTIONS.hypotheses),
    notifications: db.collection<NotificationLog>(COLLECTIONS.notifications),
    videos: db.collection<VideoAsset>(COLLECTIONS.videos),
    approvals: db.collection<Approval>(COLLECTIONS.approvals),
    mailboxStates: db.collection<MailboxState>(COLLECTIONS.mailboxStates),
    playbookNotes: db.collection<PlaybookNote>(COLLECTIONS.playbookNotes),
    sendPace: db.collection<SendPaceOverride>(COLLECTIONS.sendPace),
    calls: db.collection<Call>(COLLECTIONS.calls),
    dnc: db.collection<DncEntry>(COLLECTIONS.dnc),
  };
}

/** Create indexes. Safe to call repeatedly (createIndex is idempotent). */
export async function ensureIndexes(): Promise<void> {
  const c = await getCollections();
  await Promise.all([
    c.leads.createIndex({ email: 1 }, { unique: true }),
    c.leads.createIndex({ status: 1 }),
    c.leads.createIndex({ score: -1 }),
    c.leads.createIndex({ unsubscribeToken: 1 }),
    // Not unique: two contacts at one company legitimately share a main line.
    c.leads.createIndex({ phone: 1 }, { sparse: true }),

    c.campaigns.createIndex({ status: 1 }),

    c.enrollments.createIndex({ leadId: 1, campaignId: 1 }, { unique: true }),
    c.enrollments.createIndex({ status: 1 }),

    c.messages.createIndex({ status: 1, scheduledAt: 1 }),
    c.messages.createIndex({ leadId: 1 }),
    c.messages.createIndex({ enrollmentId: 1, step: 1 }),
    c.messages.createIndex({ "links.linkId": 1 }),
    c.messages.createIndex({ fromEmail: 1, status: 1, sentAt: 1 }),
    c.messages.createIndex({ toDomain: 1, status: 1, sentAt: 1 }),
    c.messages.createIndex({ messageIdHeader: 1 }, { sparse: true }),

    c.events.createIndex({ leadId: 1, timestamp: -1 }),
    c.events.createIndex({ type: 1, timestamp: -1 }),
    c.events.createIndex({ processed: 1 }),
    c.events.createIndex({ messageId: 1 }),

    c.variants.createIndex({ campaignId: 1, step: 1 }),
    c.variants.createIndex({ hypothesisId: 1 }, { sparse: true }),
    c.notifications.createIndex({ createdAt: -1 }),
    c.videos.createIndex({ leadId: 1 }),
    c.approvals.createIndex({ status: 1, createdAt: -1 }),
    c.playbookNotes.createIndex({ createdAt: -1 }),
    c.playbookNotes.createIndex({ tags: 1 }),

    // The dialer's hot path: due queued calls, oldest first.
    c.calls.createIndex({ status: 1, scheduledAt: 1 }),
    c.calls.createIndex({ leadId: 1, createdAt: -1 }),
    c.calls.createIndex({ providerCallId: 1 }, { sparse: true }),
    c.calls.createIndex({ campaignId: 1, status: 1 }),
    c.dnc.createIndex({ createdAt: -1 }),
  ]);
  log.info("indexes ensured");
}
