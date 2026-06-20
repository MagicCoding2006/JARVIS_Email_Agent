// ───────────────────────────────────────────────────────────────────────────
// Domain model. Document _id fields are UUID strings (matching the existing
// pixel app's convention). All timestamps are stored as native Date.
// ───────────────────────────────────────────────────────────────────────────

export type LeadStatus =
  | "new"
  | "active"
  | "engaged"
  | "replied"
  | "meeting"
  | "won"
  | "lost"
  | "unsubscribed"
  | "bounced"
  | "do_not_contact";

export interface Lead {
  _id: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  company?: string;
  industry?: string;
  website?: string;
  linkedin?: string;
  source?: string;
  status: LeadStatus;
  score: number;
  timezone?: string;
  /** Arbitrary extra columns from imports, usable as personalization variables. */
  customFields: Record<string, string>;
  unsubscribeToken: string;
  unsubscribed: boolean;
  bounced: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SequenceStep {
  /** 1-based position in the sequence. */
  step: number;
  /** Human label, e.g. "intro", "bump", "case-study", "breakup". */
  purpose: string;
  /** Days (business days) after enrollment this step should send. */
  businessDayOffset: number;
  /** The strategic angle, fed to the personalization model. */
  angle: string;
  /** Extra freeform guidance for the writer model. */
  instructions: string;
  /** If true this is a short follow-up that replies into the same thread. */
  followUp: boolean;
  /**
   * Optional hybrid template for the BODY. When set, the email is rendered from
   * this template instead of fully AI-written, mixing fixed copy with slots:
   *   {{firstName}} / {{company|your team}}  → merge fields (with optional default)
   *   {{ai: one line on their recent launch}} → AI fills just this fragment
   *   {{research: their latest funding round}} → web-research fills this fragment
   * Gives you fixed structure + AI/research personalization only where you want it.
   */
  bodyTemplate?: string;
  /** Optional template for the SUBJECT (same slot syntax as bodyTemplate). */
  subjectTemplate?: string;
}

export type CampaignStatus = "draft" | "active" | "paused" | "archived";

export interface Campaign {
  _id: string;
  name: string;
  offer: string;
  targetPersona: string;
  fromEmail?: string;
  status: CampaignStatus;
  sequence: SequenceStep[];
  /** Optional per-campaign overrides of the default scoring weights. */
  scoringOverrides?: Partial<Record<string, number>>;
  createdAt: Date;
  updatedAt: Date;
}

export type EnrollmentStatus =
  | "active"
  | "paused"
  | "completed"
  | "replied"
  | "stopped"
  | "converted";

export interface Enrollment {
  _id: string;
  leadId: string;
  campaignId: string;
  status: EnrollmentStatus;
  /** Highest step number already scheduled/sent (0 = none yet). */
  currentStep: number;
  enrolledAt: Date;
  /** Sticky sending mailbox for this prospect — every touch sends from it so the
   *  thread stays consistent. Assigned when the first step is scheduled. */
  assignedMailbox?: string;
  lastSentAt?: Date;
  stopReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** IMAP poll cursor per mailbox so we only ingest new replies (not the whole inbox). */
export interface MailboxState {
  /** Mailbox email address. */
  _id: string;
  /** Highest INBOX UID already processed. */
  lastUid: number;
  /** IMAP UIDVALIDITY when lastUid was recorded (reset to 0 if it changes). */
  uidValidity: number;
  updatedAt: Date;
}

export type MessageStatus =
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "skipped"
  | "canceled";

export interface TrackedLink {
  linkId: string;
  url: string;
  label: string;
}

export interface Message {
  _id: string;
  leadId: string;
  campaignId: string;
  enrollmentId: string;
  step: number;
  variantId?: string;
  subject: string;
  /** The raw drafted plain-text body (no footer/pixel). */
  body: string;
  /** Rendered HTML body sent to the prospect (links wrapped + pixel + footer). */
  bodyHtml: string;
  /** Rendered plain-text body sent to the prospect (with footer). */
  bodyText: string;
  fromEmail: string;
  toEmail: string;
  status: MessageStatus;
  scheduledAt: Date;
  sentAt?: Date;
  failedReason?: string;
  /** Pixel id == message _id; tracking server records opens against it. */
  trackingPixelId: string;
  /** RFC822 Message-ID header we set, for threading follow-ups. */
  messageIdHeader?: string;
  /** Message-ID this is a reply to (for follow-up threading). */
  inReplyTo?: string;
  links: TrackedLink[];
  createdAt: Date;
  updatedAt: Date;
}

export type EventType =
  | "sent"
  | "delivered"
  | "bounce"
  | "open"
  | "click"
  | "reply"
  | "positive_reply"
  | "negative_reply"
  | "neutral_reply"
  | "out_of_office"
  | "request_info"
  | "booked"
  | "showed"
  | "no_show"
  | "closed_won"
  | "closed_lost"
  | "unsubscribe"
  | "video_watched";

export interface Event {
  _id: string;
  leadId: string;
  campaignId?: string;
  enrollmentId?: string;
  messageId?: string;
  type: EventType;
  timestamp: Date;
  /** Free-form context: reply text, link clicked, user-agent, etc. */
  metadata: Record<string, unknown>;
  /** Score delta applied for this event (filled by the scoring engine). */
  scoreDelta?: number;
  /** Whether the batch processor has already acted on this event. */
  processed: boolean;
}

export interface VariantStats {
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  positiveReplies: number;
  meetings: number;
  closes: number;
  revenue: number;
}

export interface Variant {
  _id: string;
  campaignId: string;
  step: number;
  name: string;
  subjectLine?: string;
  cta?: string;
  offer?: string;
  tone?: string;
  industry?: string;
  hypothesisId?: string;
  stats: VariantStats;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type HypothesisStatus = "proposed" | "testing" | "keep" | "reject";

export interface Hypothesis {
  _id: string;
  idea: string;
  reason: string;
  status: HypothesisStatus;
  metric?: string;
  result?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type VideoStatus = "scripted" | "rendering" | "rendered" | "uploaded" | "failed";

export interface VideoAsset {
  _id: string;
  leadId: string;
  campaignId?: string;
  /** AI-generated personalized script. */
  script: string;
  /** Short hook used as the email's CTA text. */
  hook: string;
  status: VideoStatus;
  /** Final hosted video URL (set once rendered/uploaded). */
  videoUrl?: string;
  /** Public tracked URL that redirects to the video and logs watch events. */
  watchUrl: string;
  /** Max observed watch percentage (0–100). */
  watchPercent: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "executed" | "failed";

/** A high-risk action the agent proposed and is waiting on a human to confirm. */
export interface Approval {
  _id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: ApprovalStatus;
  result?: string;
  createdAt: Date;
  decidedAt?: Date;
}

export interface NotificationLog {
  _id: string;
  kind: string;
  level: "info" | "important" | "hot";
  title: string;
  body: string;
  leadId?: string;
  channels: string[];
  createdAt: Date;
}

/** The reply classification labels the worker model returns. */
export type ReplyClassification =
  | "positive"
  | "negative"
  | "neutral"
  | "out_of_office"
  | "not_interested"
  | "request_info";
