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
  MailboxState,
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

  /**
   * Set (or clear) the hybrid template on one sequence step. Pass an empty
   * string to revert a step to fully-AI-written. Returns false if the step
   * doesn't exist.
   */
  async setStepTemplate(
    campaignId: string,
    step: number,
    tpl: { bodyTemplate?: string; subjectTemplate?: string },
  ): Promise<boolean> {
    const c = await getCollections();
    const campaign = await c.campaigns.findOne({ _id: campaignId });
    if (!campaign || !campaign.sequence.some((s) => s.step === step)) return false;
    const sequence = campaign.sequence.map((s) => {
      if (s.step !== step) return s;
      const next = { ...s };
      if (tpl.bodyTemplate !== undefined) next.bodyTemplate = tpl.bodyTemplate || undefined;
      if (tpl.subjectTemplate !== undefined) next.subjectTemplate = tpl.subjectTemplate || undefined;
      return next;
    });
    await c.campaigns.updateOne({ _id: campaignId }, { $set: { sequence, updatedAt: now() } });
    return true;
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

  /** Pin the sticky sending mailbox for this enrollment (set once, on step 1). */
  async setMailbox(id: string, email: string): Promise<void> {
    const c = await getCollections();
    await c.enrollments.updateOne(
      { _id: id },
      { $set: { assignedMailbox: email, updatedAt: now() } },
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

  /** Find a sent message by its RFC822 Message-ID header — maps an inbound
   *  reply's In-Reply-To/References back to the touch it answers. */
  async findByMessageIdHeader(header: string): Promise<Message | null> {
    const c = await getCollections();
    return c.messages.findOne({ messageIdHeader: header });
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

  /** Count messages sent since `since` from a specific mailbox (warmup cap accounting). */
  async countSentSinceFrom(since: Date, fromEmail: string): Promise<number> {
    const c = await getCollections();
    return c.messages.countDocuments({ status: "sent", sentAt: { $gte: since }, fromEmail });
  },

  /** Timestamp of the first send ever from a mailbox — anchors the warmup ramp. */
  async firstSentAtFrom(fromEmail: string): Promise<Date | null> {
    const c = await getCollections();
    const m = await c.messages
      .find({ status: "sent", fromEmail })
      .sort({ sentAt: 1 })
      .limit(1)
      .next();
    return m?.sentAt ?? null;
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

// ── Mailbox IMAP cursors ─────────────────────────────────────────────────────
export const MailboxStateRepo = {
  async get(email: string): Promise<MailboxState | null> {
    const c = await getCollections();
    return c.mailboxStates.findOne({ _id: email.toLowerCase() });
  },

  async set(email: string, lastUid: number, uidValidity: number): Promise<void> {
    const c = await getCollections();
    await c.mailboxStates.updateOne(
      { _id: email.toLowerCase() },
      { $set: { lastUid, uidValidity, updatedAt: now() } },
      { upsert: true },
    );
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

  /** All variants spawned by a hypothesis — used to measure its outcome. */
  async listForHypothesis(hypothesisId: string): Promise<Variant[]> {
    const c = await getCollections();
    return c.variants.find({ hypothesisId }).toArray();
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

  async getById(id: string): Promise<Hypothesis | null> {
    const c = await getCollections();
    return c.hypotheses.findOne({ _id: id });
  },

  async setStatus(
    id: string,
    status: HypothesisStatus,
    result?: string,
    metric?: string,
  ): Promise<void> {
    const c = await getCollections();
    const set: Partial<Hypothesis> = { status, updatedAt: now() };
    if (result !== undefined) set.result = result;
    if (metric !== undefined) set.metric = metric;
    await c.hypotheses.updateOne({ _id: id }, { $set: set });
  },

  async list(): Promise<Hypothesis[]> {
    const c = await getCollections();
    return c.hypotheses.find({}).sort({ createdAt: -1 }).toArray();
  },

  async listByStatus(status: HypothesisStatus): Promise<Hypothesis[]> {
    const c = await getCollections();
    return c.hypotheses.find({ status }).sort({ updatedAt: -1 }).toArray();
  },

  /** Most recently decided experiments (kept/rejected) — fed back to the strategist. */
  async recentDecided(limit = 8): Promise<Hypothesis[]> {
    const c = await getCollections();
    return c.hypotheses
      .find({ status: { $in: ["keep", "reject"] } })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  },

  /** Counts by status for dashboards/digests. */
  async countsByStatus(): Promise<Record<HypothesisStatus, number>> {
    const c = await getCollections();
    const rows = await c.hypotheses
      .aggregate<{ _id: HypothesisStatus; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }])
      .toArray();
    const out: Record<HypothesisStatus, number> = { proposed: 0, testing: 0, keep: 0, reject: 0 };
    for (const r of rows) out[r._id] = r.n;
    return out;
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
