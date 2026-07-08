import type { SequenceStep } from "../../models/types.js";

/**
 * Education-led nurture sequence: lead with value and build the case over
 * ~3 weeks before making the direct ask. Adapted from the classic 8-email
 * nurture arc (deliver → expand → problem → framework → case study →
 * differentiation → objections → offer) with the CASE-STUDY step intentionally
 * omitted — we have no real customer results yet, and the writer is forbidden
 * from inventing social proof. Re-insert a proof step here once real, named
 * results exist.
 *
 * Offsets are business days from enrollment.
 */
export const NURTURE_SEQUENCE: SequenceStep[] = [
  {
    step: 1,
    purpose: "intro-value",
    businessDayOffset: 0,
    angle:
      "Introduce yourself in one line, then immediately deliver one genuinely useful, specific insight tied to their company/role — the email should be worth reading even if they never reply. Close by previewing that you'll share more, with a soft CTA.",
    instructions:
      "Value first, credentials second. No pitch. The goal is 'huh, that was actually useful'.",
    followUp: false,
  },
  {
    step: 2,
    purpose: "expand-topic",
    businessDayOffset: 2,
    angle:
      "Expand on the first email's insight with a related, deeper point. Establish expertise by being specific, not by claiming it. Light CTA (a question or 'worth a look?').",
    instructions: "Threads into email 1. Educational tone, zero selling.",
    followUp: true,
  },
  {
    step: 3,
    purpose: "problem-deep-dive",
    businessDayOffset: 4,
    angle:
      "Articulate THEIR problem better than they would themselves — the cost, the daily friction, why common fixes fall short. Show you understand their world. Hint that a better way exists without pitching it yet.",
    instructions:
      "The reader should think 'this person gets it'. Empathy and precision over cleverness.",
    followUp: true,
  },
  {
    step: 4,
    purpose: "solution-framework",
    businessDayOffset: 6,
    angle:
      "Lay out your approach/methodology for solving the problem from email 3 — the how, in plain steps. Educational, not salesy; it should stand alone as useful thinking that naturally points toward the offer.",
    instructions: "Fresh subject line, new thread. Teach the framework; let it sell itself.",
    followUp: false,
  },
  {
    step: 5,
    purpose: "differentiation",
    businessDayOffset: 9,
    angle:
      "Why this approach beats the alternatives they're probably considering (status quo, DIY, the usual vendors). Contrast honestly on mechanism, not on invented claims about competitors or customers.",
    instructions: "Respect the alternatives — dismissing them reads as insecure. Build preference.",
    followUp: true,
  },
  {
    step: 6,
    purpose: "objection-handler",
    businessDayOffset: 12,
    angle:
      "Address the single most common concern or myth head-on ('too early for us', 'we'd build it ourselves', 'sounds like a lot of change'). Reduce friction with a candid, specific answer.",
    instructions: "Pick ONE objection and kill it. Candor over polish.",
    followUp: true,
  },
  {
    step: 7,
    purpose: "direct-offer",
    businessDayOffset: 15,
    angle:
      "The clear, direct pitch: what you do, the value proposition in one or two lines, and a specific CTA to book a call. Add urgency only if a real, honest reason exists — otherwise skip urgency entirely.",
    instructions:
      "Fresh subject, new thread. Confident and plain — they've had three weeks of value; now ask.",
    followUp: false,
  },
];
