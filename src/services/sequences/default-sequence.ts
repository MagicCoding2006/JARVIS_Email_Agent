import type { SequenceStep } from "../../models/types.js";

/**
 * Default 7-touch cold sequence. Research consistently shows most replies come
 * after multiple touches, so we pace 7 emails over ~5 weeks with WIDENING gaps
 * (business days from enrollment). Follow-ups thread into the first email.
 *
 * Tune per campaign by passing your own sequence to CampaignsRepo.create().
 */
export const DEFAULT_SEQUENCE: SequenceStep[] = [
  {
    step: 1,
    purpose: "intro",
    businessDayOffset: 0,
    angle: "Open with a specific observation about their company/role, then the core problem your offer solves. Soft CTA (open to learning more?).",
    instructions: "First impression. Earn the reply by being relevant, not salesy.",
    followUp: false,
  },
  {
    step: 2,
    purpose: "bump",
    businessDayOffset: 3,
    angle: "Short, friendly nudge on the first email. Add one new sentence of value or a question. Assume they're busy.",
    instructions: "2-3 sentences max. Reply into the same thread.",
    followUp: true,
  },
  {
    step: 3,
    purpose: "proof",
    businessDayOffset: 7,
    angle: "Share a concrete proof point or mini case study (result, number, or peer company) relevant to their persona.",
    instructions: "Lead with the result. One CTA to see how it applies to them.",
    followUp: true,
  },
  {
    step: 4,
    purpose: "new-angle",
    businessDayOffset: 12,
    angle: "Reframe around a DIFFERENT pain point than email 1. Fresh subject if not threading.",
    instructions: "Pretend the earlier angle didn't land; try a new one.",
    followUp: false,
  },
  {
    step: 5,
    purpose: "quick-question",
    businessDayOffset: 18,
    angle: "One easy yes/no or either/or question that's trivial to answer. Lower the reply friction to the floor.",
    instructions: "Under 40 words. Make replying take 5 seconds.",
    followUp: true,
  },
  {
    step: 6,
    purpose: "social-proof",
    businessDayOffset: 25,
    angle: "Name-drop a recognizable peer/competitor outcome or a relevant trend creating urgency now.",
    instructions: "Create a reason to act this quarter, honestly.",
    followUp: true,
  },
  {
    step: 7,
    purpose: "breakup",
    businessDayOffset: 33,
    angle: "Polite breakup email. Say you'll stop reaching out, leave the door open, make it easy to revive the conversation later.",
    instructions: "Breakup emails get surprisingly high reply rates. Keep it warm, no guilt.",
    followUp: true,
  },
];
