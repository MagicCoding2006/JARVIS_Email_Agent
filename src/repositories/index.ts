import { getCollections } from "./collections.js";
import { uuid, token } from "../lib/ids.js";
import type {
  Lead,
  LeadStatus,
  Campaign,
  CampaignStatus,
  Enrollment,
  EnrollmentStatus,
  Message,
  MessageStatus,
  Event,
  EventType,
  Variant,
  VariantStats,
  Hypothesis,
  HypothesisStatus,
  NotificationLog,
  VideoAsset,
  VideoStatus,
  Approval,
  ApprovalStatus,
} from "../models/types.js";

const now = () => new Date();

// ── Leads ───────────────────────────────────────────────────────────────────
export const LeadsRepo = {
  async upsertByEmail(input: Partial<Lead> & { email: string }): Promise<Lead> {
    const c = await getCollections();
    const email = input.email.trim().toLowerCase();
    const existing = await c.leads.findOne({ email });
    if (existing) {
      const update = {
        ...stripUndefined(input),
        email,
        updatedAt: now(),
      } as Partial<Lead>;
      delete (update as { _id?: unknown })._id;
      const res = await c.leads.findOneAndUpdate(
        { _id: existing._id },
        { $set: update },
        { returnDocument: "after" },
      );
      return res as Lead;
    }
    const doc: Lead = {
      _id: uuid(),
      email,
      name: input.name,
      firstName: input.firstName,
      lastName: input.lastName,
      title: input.title,
      company: input.company,
      industry: input.industry,
      website: input.website,
      linkedin: input.linkedin,
      source: input.source ?? "manual",
      status: input.status ?? "new",
      score: input.score ?? 0,
      timezone: input.timezone,
      customFields: input.customFields ?? {},
      unsubscribeToken: token(),
      unsubscribed: false,
      bounced: false,
      createdAt: now(),
      updatedAt: now(),
    };
    await c.leads.insertOne(doc);
    return doc;
  },

  async getById(id: string): Promise<Lead | null> {
    const c = await getCollections();
    return c.leads.findOne({ _id: id });
  },

  async getByEmail(email: string): Promise<Lead | null> {
    const c = await getCollections();
    return c.leads.findOne({ email: email.trim().toLowerCase() });
  },

  async getMany(ids: string[]): Promise<Lead[]> {
    const c = await getCollections();
    return c.leads.find({ _id: { $in: ids } }).toArray();
  },

  async findByUnsubscribeToken(t: string): Promise<Lead | null> {
    const c = await getCollections();
    return c.leads.findOne({ unsubscribeToken: t });
  },

  async setStatus(id: string, status: LeadStatus): Promise<void> {
    const c = await getCollections();
    await c.leads.updateOne({ _id: id }, { $set: { status, updatedAt: now() } });
  },

  async addScore(id: string, delta: number): Promise<number> {
    const c = await getCollections();
    const res = await c.leads.findOneAndUpdate(
      { _id: id },
      { $inc: { score: delta }, $set: { updatedAt: now() } },
      { returnDocument: "after" },
    );
    return res?.score ?? 0;
  },

  async mergeCustomFields(id: string, fields: Record<string, string>): Promise<void> {
    const c = await getCollections();
    const set: Record<string, unknown> = { updatedAt: now() };
    for (const [k, v] of Object.entries(fields)) set[`customFields.${k}`] = v;
    await c.leads.updateOne({ _id: id }, { $set: set });
  },

  async setUnsubscribed(id: string): Promise<void> {
    const c = await getCollections();
    await c.leads.updateOne(
      { _id: id },
      { $set: { unsubscribed: true, status: "unsubscribed", updatedAt: now() } },
    );
  },

  async setBounced(id: string): Promise<void> {
    const c = await getCollections();
    await c.leads.updateOne(
      { _id: id },
      { $set: { bounced: true, status: "bounced", updatedAt: now() } },
    );
  },

  async list(filter: Partial<Pick<Lead, "status">> = {}, limit = 100): Promise<Lead[]> {
    const c = await getCollections();
    return c.leads.find(filter).sort({ score: -1 }).limit(limit).toArray();
  },

  async count(filter: Record<string, unknown> = {}): Promise<number> {
    const c = await getCollections();
    return c.leads.countDocuments(filter);
  },
};

// ── Campaigns ────────────────────────────────────────────────────────────────
export const CampaignsRepo = {
  async create(input: Omit<Campaign, "_id" | "createdAt" | "updatedAt" | "status"> & {
    status?: CampaignStatus;
  }): Promise<Campaign> {
    const c = await getCollections();
    const doc: Campaign = {
      _id: uuid(),
      status: input.status ?? "draft",
      createdAt: now(),
      updatedAt: now(),
      ...input,
    };
    await c.campaigns.insertOne(doc);
    return doc;
  },

  async getById(id: string): Promise<Campaign | null> {
    const c = await getCollections();
    return c.campaigns.findOne({ _id: id });
  },

  async getByName(name: string): Promise<Campaign | null> {
    const c = await getCollections();
    return c.campaigns.findOne({ name });
  },

  async listActive(): Promise<Campaign[]> {
    const c = await getCollections();
    return c.campaigns.find({ status: "active" }).toArray();
  },

  async list(): Promise<Campaign[]> {
    const c = await getCollections();
    return c.campaigns.find({}).sort({ createdAt: -1 }).toArray();
  },

  async setStatus(id: string, status: CampaignStatus): Promise<void> {
    const c = await getCollections();
    await c.campaigns.updateOne({ _id: id }, { $set: { status, updatedAt: now() } });
  },

  async update(id: string, patch: Partial<Pick<Campaign, "offer" | "targetPersona" | "fromEmail" | "name">>): Promise<void> {
    const c = await getCollections();
    await c.campaigns.updateOne({ _id: id }, { $set: { ...patch, updatedAt: now() } });
  },
};

// ── Enrollments ──────────────────────────────────────────────────────────────
export const EnrollmentsRepo = {
  /** Idempotent: returns existing enrollment if the lead is already in the campaign. */
  async enroll(leadId: string, campaignId: string): Promise<{ enrollment: Enrollment; created: boolean }> {
    const c = await getCollections();
    const existing = await c.enrollments.findOne({ leadId, campaignId });
    if (existing) return { enrollment: existing, created: false };
    const doc: Enrollment = {
      _id: uuid(),
      leadId,
      campaignId,
      status: "active",
      currentStep: 0,
      enrolledAt: now(),
      createdAt: now(),
      updatedAt: now(),
    };
    await c.enrollments.insertOne(doc);
    return { enrollment: doc, created: true };
  },

  async getById(id: string): Promise<Enrollment | null> {
    const c = await getCollections();
    return c.enrollments.findOne({ _id: id });
  },

  async listActive(): Promise<Enrollment[]> {
    const c = await getCollections();
    return c.enrollments.find({ status: "active" }).toArray();
  },

  async advanceStep(id: string, step: number): Promise<void> {
    const c = await getCollections();
    await c.enrollments.updateOne(
      { _id: id },
      { $set: { currentStep: step, lastSentAt: now(), updatedAt: now() } },
    );
  },

  async setStatus(id: string, status: EnrollmentStatus, stopReason?: string): Promise<void> {
    const c = await getCollections();
    await c.enrollments.updateOne(
      { _id: id },
      { $set: { status, stopReason, updatedAt: now() } },
    );
  },

  /** Stop all active enrollments for a lead (e.g. on reply or unsubscribe). */
  async stopAllForLead(leadId: string, status: EnrollmentStatus, reason: string): Promise<number> {
    const c = await getCollections();
    const res = await c.enrollments.updateMany(
      { leadId, status: "active" },
      { $set: { status, stopReason: reason, updatedAt: now() } },
    );
    return res.modifiedCount;
  },
};

// ── Messages ─────────────────────────────────────────────────────────────────
export const MessagesRepo = {
  async create(input: Omit<Message, "createdAt" | "updatedAt">): Promise<Message> {
    const c = await getCollections();
    const doc: Message = { ...input, createdAt: now(), updatedAt: now() };
    await c.messages.insertOne(doc);
    return doc;
  },

  async getById(id: string): Promise<Message | null> {
    const c = await getCollections();
    return c.messages.findOne({ _id: id });
  },

  /** Scheduled messages that are due to send now (ordered oldest first). */
  async getDue(limit: number): Promise<Message[]> {
    const c = await getCollections();
    return c.messages
      .find({ status: "scheduled", scheduledAt: { $lte: now() } })
      .sort({ scheduledAt: 1 })
      .limit(limit)
      .toArray();
  },

  async setStatus(
    id: string,
    status: MessageStatus,
    extra: Partial<Message> = {},
  ): Promise<void> {
    const c = await getCollections();
    await c.messages.updateOne(
      { _id: id },
      { $set: { status, ...extra, updatedAt: now() } },
    );
  },

  async findByLinkId(linkId: string): Promise<Message | null> {
    const c = await getCollections();
    return c.messages.findOne({ "links.linkId": linkId });
  },

  /** Most recent SENT message for an enrollment — used to thread follow-ups. */
  async lastSentForEnrollment(enrollmentId: string): Promise<Message | null> {
    const c = await getCollections();
    return c.messages
      .find({ enrollmentId, status: "sent" })
      .sort({ sentAt: -1 })
      .limit(1)
      .next();
  },

  async countSentSince(since: Date): Promise<number> {
    const c = await getCollections();
    return c.messages.countDocuments({ status: "sent", sentAt: { $gte: since } });
  },

  async listForLead(leadId: string): Promise<Message[]> {
    const c = await getCollections();
    return c.messages.find({ leadId }).sort({ scheduledAt: 1 }).toArray();
  },

  async cancelScheduledForEnrollment(enrollmentId: string): Promise<number> {
    const c = await getCollections();
    const res = await c.messages.updateMany(
      { enrollmentId, status: "scheduled" },
      { $set: { status: "canceled", updatedAt: now() } },
    );
    return res.modifiedCount;
  },
};

// ── Events ───────────────────────────────────────────────────────────────────
export const EventsRepo = {
  async record(input: {
    leadId: string;
    type: EventType;
    campaignId?: string;
    enrollmentId?: string;
    messageId?: string;
    metadata?: Record<string, unknown>;
    timestamp?: Date;
  }): Promise<Event> {
    const c = await getCollections();
    const doc: Event = {
      _id: uuid(),
      leadId: input.leadId,
      campaignId: input.campaignId,
      enrollmentId: input.enrollmentId,
      messageId: input.messageId,
      type: input.type,
      timestamp: input.timestamp ?? now(),
      metadata: input.metadata ?? {},
      processed: false,
    };
    await c.events.insertOne(doc);
    return doc;
  },

  async getUnprocessed(limit = 500): Promise<Event[]> {
    const c = await getCollections();
    return c.events.find({ processed: false }).sort({ timestamp: 1 }).limit(limit).toArray();
  },

  async markProcessed(id: string, scoreDelta: number): Promise<void> {
    const c = await getCollections();
    await c.events.updateOne({ _id: id }, { $set: { processed: true, scoreDelta } });
  },

  async recentForLead(leadId: string, limit = 50): Promise<Event[]> {
    const c = await getCollections();
    return c.events.find({ leadId }).sort({ timestamp: -1 }).limit(limit).toArray();
  },

  async countByTypeSince(since: Date): Promise<Record<string, number>> {
    const c = await getCollections();
    const rows = await c.events
      .aggregate<{ _id: EventType; n: number }>([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: "$type", n: { $sum: 1 } } },
      ])
      .toArray();
    const out: Record<string, number> = {};
    for (const r of rows) out[r._id] = r.n;
    return out;
  },
};

// ── Variants ─────────────────────────────────────────────────────────────────
const ZERO_STATS: VariantStats = {
  sent: 0,
  opens: 0,
  clicks: 0,
  replies: 0,
  positiveReplies: 0,
  meetings: 0,
  closes: 0,
  revenue: 0,
};

export const VariantsRepo = {
  async create(input: Omit<Variant, "_id" | "createdAt" | "updatedAt" | "stats" | "active"> & {
    active?: boolean;
  }): Promise<Variant> {
    const c = await getCollections();
    const doc: Variant = {
      _id: uuid(),
      stats: { ...ZERO_STATS },
      active: input.active ?? true,
      createdAt: now(),
      updatedAt: now(),
      ...input,
    };
    await c.variants.insertOne(doc);
    return doc;
  },

  async getById(id: string): Promise<Variant | null> {
    const c = await getCollections();
    return c.variants.findOne({ _id: id });
  },

  async listForCampaignStep(campaignId: string, step: number, activeOnly = true): Promise<Variant[]> {
    const c = await getCollections();
    const filter = activeOnly ? { campaignId, step, active: true } : { campaignId, step };
    return c.variants.find(filter).toArray();
  },

  async listForCampaign(campaignId: string): Promise<Variant[]> {
    const c = await getCollections();
    return c.variants.find({ campaignId }).sort({ step: 1 }).toArray();
  },

  async setActive(id: string, active: boolean): Promise<void> {
    const c = await getCollections();
    await c.variants.updateOne({ _id: id }, { $set: { active, updatedAt: now() } });
  },

  async incStat(id: string, field: keyof VariantStats, by = 1): Promise<void> {
    const c = await getCollections();
    await c.variants.updateOne(
      { _id: id },
      { $inc: { [`stats.${field}`]: by }, $set: { updatedAt: now() } },
    );
  },
};

// ── Hypotheses ───────────────────────────────────────────────────────────────
export const HypothesesRepo = {
  async create(idea: string, reason: string): Promise<Hypothesis> {
    const c = await getCollections();
    const doc: Hypothesis = {
      _id: uuid(),
      idea,
      reason,
      status: "proposed",
      createdAt: now(),
      updatedAt: now(),
    };
    await c.hypotheses.insertOne(doc);
    return doc;
  },

  async setStatus(id: string, status: HypothesisStatus, result?: string): Promise<void> {
    const c = await getCollections();
    await c.hypotheses.updateOne(
      { _id: id },
      { $set: { status, result, updatedAt: now() } },
    );
  },

  async list(): Promise<Hypothesis[]> {
    const c = await getCollections();
    return c.hypotheses.find({}).sort({ createdAt: -1 }).toArray();
  },
};

// ── Videos ───────────────────────────────────────────────────────────────────
export const VideosRepo = {
  async create(input: Omit<VideoAsset, "createdAt" | "updatedAt">): Promise<VideoAsset> {
    const c = await getCollections();
    const doc: VideoAsset = { ...input, createdAt: now(), updatedAt: now() };
    await c.videos.insertOne(doc);
    return doc;
  },

  async getById(id: string): Promise<VideoAsset | null> {
    const c = await getCollections();
    return c.videos.findOne({ _id: id });
  },

  async setStatus(id: string, status: VideoStatus, videoUrl?: string): Promise<void> {
    const c = await getCollections();
    await c.videos.updateOne(
      { _id: id },
      { $set: { status, ...(videoUrl ? { videoUrl } : {}), updatedAt: now() } },
    );
  },

  async recordWatch(id: string, percent: number): Promise<void> {
    const c = await getCollections();
    await c.videos.updateOne(
      { _id: id },
      { $max: { watchPercent: percent }, $set: { updatedAt: now() } },
    );
  },
};

// ── Approvals ────────────────────────────────────────────────────────────────
export const ApprovalsRepo = {
  async create(tool: string, args: Record<string, unknown>, summary: string): Promise<Approval> {
    const c = await getCollections();
    const doc: Approval = {
      _id: uuid(),
      tool,
      args,
      summary,
      status: "pending",
      createdAt: now(),
    };
    await c.approvals.insertOne(doc);
    return doc;
  },

  async getById(id: string): Promise<Approval | null> {
    const c = await getCollections();
    return c.approvals.findOne({ _id: id });
  },

  async listPending(): Promise<Approval[]> {
    const c = await getCollections();
    return c.approvals.find({ status: "pending" }).sort({ createdAt: 1 }).toArray();
  },

  async setStatus(id: string, status: ApprovalStatus, result?: string): Promise<void> {
    const c = await getCollections();
    await c.approvals.updateOne(
      { _id: id },
      { $set: { status, result, decidedAt: now() } },
    );
  },
};

// ── Notifications ────────────────────────────────────────────────────────────
export const NotificationsRepo = {
  async record(input: Omit<NotificationLog, "_id" | "createdAt">): Promise<NotificationLog> {
    const c = await getCollections();
    const doc: NotificationLog = { _id: uuid(), createdAt: now(), ...input };
    await c.notifications.insertOne(doc);
    return doc;
  },
};

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
