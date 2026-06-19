import type { EventType } from "../models/types.js";

/**
 * Per-event score weights (from the master plan, tuned). Positive signals raise
 * a lead's temperature; opt-outs/bounces drop it hard and stop the sequence.
 */
export const SCORE_WEIGHTS: Partial<Record<EventType, number>> = {
  open: 5,
  click: 20,
  reply: 50,
  positive_reply: 40, // applied IN ADDITION to the base reply score
  negative_reply: -30,
  neutral_reply: 0,
  out_of_office: 0,
  request_info: 25,
  video_watched: 25,
  booked: 100,
  showed: 50,
  no_show: -20,
  closed_won: 150,
  closed_lost: -10,
  unsubscribe: -100,
  bounce: -50,
};

/** A click whose link label/url matches one of these scores higher ("intent"). */
export const HIGH_INTENT_LINK_KEYWORDS = ["pricing", "demo", "book", "calendly", "cal.com", "buy"];
export const HIGH_INTENT_CLICK_SCORE = 30;

/**
 * Human-escalation bands (0–100+):
 *   < notify           → AI handles silently
 *   notify .. hot      → daily digest / FYI notification
 *   >= hot             → notify immediately, recommend calling
 */
export const ESCALATION = {
  notify: 40,
  hot: 70,
};
