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

    c.campaigns.createIndex({ status: 1 }),

    c.enrollments.createIndex({ leadId: 1, campaignId: 1 }, { unique: true }),
    c.enrollments.createIndex({ status: 1 }),

    c.messages.createIndex({ status: 1, scheduledAt: 1 }),
    c.messages.createIndex({ leadId: 1 }),
    c.messages.createIndex({ enrollmentId: 1, step: 1 }),
    c.messages.createIndex({ "links.linkId": 1 }),

    c.events.createIndex({ leadId: 1, timestamp: -1 }),
    c.events.createIndex({ type: 1, timestamp: -1 }),
    c.events.createIndex({ processed: 1 }),
    c.events.createIndex({ messageId: 1 }),

    c.variants.createIndex({ campaignId: 1, step: 1 }),
    c.notifications.createIndex({ createdAt: -1 }),
    c.videos.createIndex({ leadId: 1 }),
    c.approvals.createIndex({ status: 1, createdAt: -1 }),
  ]);
  log.info("indexes ensured");
}
