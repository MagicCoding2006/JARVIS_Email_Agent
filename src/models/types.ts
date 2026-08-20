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
  /** E.164 phone number (+15551234567) — required for voice outreach. */
  phone?: string;
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
  /** Lowercased domain of toEmail, derived at creation — powers per-domain send caps. */
  toDomain: string;
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
  | "video_watched"
  // ── voice / cold calling ──────────────────────────────────────────────────
  /** An outbound call was actually placed to the carrier. */
  | "call_placed"
  /** A human answered and stayed on long enough to have a conversation. */
  | "call_connected"
  /** Interested / asked for a callback / agreed to next step (short of booking). */
  | "call_positive"
  /** Explicit brush-off, not a fit, or hostile. */
  | "call_negative"
  | "call_no_answer"
  | "call_voicemail"
  /** Prospect asked not to be called again — hard stop across every channel. */
  | "call_dnc";

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

/**
 * Where in the funnel a video is used. Cold videos are first-touch; the rest are
 * "warm" follow-ups (appointment confirmations, proposal walkthroughs) that play
 * off established trust and tend to convert better.
 */
export type VideoPurpose = "cold" | "follow_up" | "appointment" | "proposal";

export interface VideoAsset {
  _id: string;
  leadId: string;
  campaignId?: string;
  /** Funnel stage this video is for (defaults to cold first-touch). */
  purpose?: VideoPurpose;
  /** AI-generated personalized script. */
  script: string;
  /** Short hook used as the email's CTA text. */
  hook: string;
  /** Supporting email line giving the video context ("I made this to address X"). */
  context?: string;
  status: VideoStatus;
  /** Final hosted video URL (set once rendered/uploaded). */
  videoUrl?: string;
  /** Lightweight animated preview for email embeds, usually a short GIF. */
  previewUrl?: string;
  /** Public tracked URL that redirects to the video and logs watch events. */
  watchUrl: string;
  /** Max observed watch percentage (0–100). */
  watchPercent: number;
  /** Last render error (set when status="failed") — the reason a link never got a video. */
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Voice / cold calling ────────────────────────────────────────────────────

export type CallStatus =
  /** Waiting for the dialer to pick it up. */
  | "queued"
  /** Handed to the carrier; ringing. */
  | "dialing"
  /** Answered — the media bridge is live. */
  | "in_progress"
  /** Hung up normally (see `outcome` for what actually happened). */
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  /** Compliance gate refused it (DNC, outside hours, capped) — see failureReason. */
  | "skipped"
  | "canceled";

/** What the conversation actually produced. Set by post-call analysis. */
export type CallOutcome =
  | "meeting_booked"
  | "callback_requested"
  | "interested"
  | "not_interested"
  | "not_a_fit"
  | "wrong_person"
  | "gatekeeper"
  | "voicemail"
  | "no_answer"
  | "do_not_call"
  | "hung_up"
  | "unknown";

export interface CallTurn {
  role: "agent" | "prospect";
  text: string;
  at: Date;
}

/**
 * One outbound call attempt. Mirrors `Message` for the voice channel: the
 * dialer selects `queued` rows the way the dispatcher selects `scheduled`
 * messages, and the same events/scoring/CRM machinery consumes the results.
 */
export interface Call {
  _id: string;
  leadId: string;
  campaignId?: string;
  enrollmentId?: string;
  /** E.164 destination, snapshotted at queue time. */
  toNumber: string;
  fromNumber: string;
  /** Telephony provider that carried it ("twilio", "dry-run", "simulator"). */
  provider: string;
  /** Carrier-side id (Twilio CallSid) — how status callbacks find this row. */
  providerCallId?: string;
  status: CallStatus;
  /** 1-based attempt number for this lead+campaign (retry ladder). */
  attempt: number;
  /** A/B script variant used, so call scripts learn like email variants do. */
  scriptId?: string;
  outcome?: CallOutcome;
  /** Objection codes raised by the prospect (see voice/objections.ts). */
  objections: string[];
  /** How many times the agent asked for the meeting — the close-ladder counter. */
  askCount: number;
  transcript: CallTurn[];
  summary?: string;
  nextAction?: string;
  recordingUrl?: string;
  /** ISO time the prospect verbally committed to, when one was agreed. */
  meetingTime?: string;
  durationSec: number;
  scheduledAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Do-not-call list. Keyed by normalized E.164 number so it blocks the number
 * even if it later shows up on a different lead record.
 */
export interface DncEntry {
  /** Normalized E.164 number. */
  _id: string;
  reason: string;
  leadId?: string;
  source: "prospect" | "operator" | "agent";
  createdAt: Date;
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

/**
 * A durable conclusion the strategist (or a human) records so it survives past
 * a single chat session — read back at the start of every agent cycle.
 */
export interface PlaybookNote {
  _id: string;
  text: string;
  /** Free-form labels for filtering, e.g. a campaign name or segment. */
  tags: string[];
  createdBy: "agent" | "human";
  createdAt: Date;
}

/**
 * Single-doc override of the sending pace, set via the agent's set_send_pace
 * tool (or by a human). Values are clamped to config.agent.maxPerRunCeiling /
 * dailySendCeiling on write, and composed with — never replace — per-mailbox
 * warmup caps and the per-recipient-domain cap.
 */
export interface SendPaceOverride {
  _id: "send_pace";
  maxPerRun?: number;
  dailyCeiling?: number;
  reason: string;
  updatedBy: string;
  updatedAt: Date;
}
