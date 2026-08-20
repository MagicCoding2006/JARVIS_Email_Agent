/**
 * The objection playbook.
 *
 * Cold calls are won or lost in the four seconds after the prospect pushes
 * back. A speech-to-speech model left to improvise either caves ("no problem,
 * I'll email you") or bulldozes — both lose the meeting. So the handling is
 * specified here as data, compiled into the call instructions, and reused as
 * the label set for post-call analysis. One vocabulary, three jobs:
 *
 *   1. teaching the live agent what to say,
 *   2. tagging what actually came up on each call,
 *   3. telling the strategist which objection is killing the campaign.
 *
 * The structure of every response is the same and is deliberate:
 *   ACKNOWLEDGE (never argue) → REFRAME (new information, not repetition)
 *   → RE-ASK (a specific, small, time-boxed commitment).
 */

export interface Objection {
  /** Stable code — also the analysis label and the metric key. */
  code: string;
  /** What it sounds like, so the model can recognize it mid-sentence. */
  cue: string;
  /** The handling line(s). Written to be spoken, not read. */
  response: string;
}

export const OBJECTIONS: Objection[] = [
  {
    code: "not_interested",
    cue: '"Not interested." Usually reflex, fired before they know what you do.',
    response:
      "Expect this on almost every call — it is a reflex, not a decision. Do not accept it the first time and do not argue with it. " +
      "Say you'd be surprised if they were interested since you haven't told them anything yet, give ONE concrete sentence about the " +
      "problem you fix for people in their seat, and ask if that problem is real for them. If they say no a second time, accept it.",
  },
  {
    code: "no_time",
    cue: '"I\'m busy / in the middle of something / on a job site."',
    response:
      "Believe them. Two options only: 30 seconds now, or you call back at a specific time. Offer both, let them pick, and if they " +
      "pick the callback get a day and rough time before you hang up. Never just say 'I'll try you later'.",
  },
  {
    code: "send_info",
    cue: '"Just send me an email / some information."',
    response:
      "This is a polite brush-off most of the time, but it is also a small yes. Agree to send it, then trade: say you'll send it " +
      "right now and ask the one question you need answered to send something relevant rather than a brochure. Their answer restarts " +
      "the conversation. Then ask for the meeting once more. If they still want only email, take the email address and end warmly.",
  },
  {
    code: "already_have_solution",
    cue: '"We already use someone / we have a guy / we have that covered."',
    response:
      "Never rubbish the incumbent. Assume it's working and ask what it does well, then ask about the specific gap your offer covers. " +
      "You are looking for the one thing their current setup does not do. If there is no gap, disqualify honestly and get off the phone.",
  },
  {
    code: "too_expensive",
    cue: '"That\'s too expensive / we can\'t afford that."',
    response:
      "Price is only expensive relative to a number they haven't calculated yet. Do not discount. Ask what one lost customer is worth " +
      "to them, then frame the cost against that number. Cost belongs on the meeting agenda, not on a cold call.",
  },
  {
    code: "no_budget",
    cue: '"There\'s no budget / not this quarter."',
    response:
      "Budget objections on a first call are timing objections. Agree that nobody budgets for something they haven't evaluated, and ask " +
      "for the meeting as an evaluation with no commitment, or ask when the next budget cycle opens and book the follow-up now.",
  },
  {
    code: "not_decision_maker",
    cue: '"That\'s not my call / you need to talk to someone else."',
    response:
      "Great outcome — treat it as one. Thank them, ask who owns it, ask for the best way to reach that person, and ask whether they'd " +
      "be on the call too. Get a name before you hang up. Do not pitch further.",
  },
  {
    code: "gatekeeper_screen",
    cue: '"What is this regarding? / Are they expecting your call?"',
    response:
      "Be straight and brief with the gatekeeper; never pretend to be expected or to have called before. Give your name, your company, " +
      "and a one-line reason in plain language, then ask for the person by name or ask when is a better time to catch them.",
  },
  {
    code: "how_did_you_get_my_number",
    cue: '"Where did you get this number? / How do you know me?"',
    response:
      "Answer honestly and immediately — public listing, their website, a business directory, whichever it actually was. Any hedging here " +
      "ends the call. Then apologize for the cold approach, give the reason for the call in one sentence, and ask permission to continue.",
  },
  {
    code: "is_this_ai",
    cue: '"Is this a robot? / Am I talking to a real person? / Is this AI?"',
    response:
      "Tell the truth in the first sentence: yes, you're an AI assistant calling on behalf of the company, and a human handles the meeting. " +
      "Never dodge, joke, or change the subject. Then keep going naturally — many people are fine with it once you're straight with them, " +
      "and offer to have a person call them instead if they'd prefer.",
  },
  {
    code: "call_me_later",
    cue: '"Call me next week / try me in a couple months."',
    response:
      "Pin it down. Ask for a specific day and time, repeat it back, and tell them you'll send a calendar note so it isn't a surprise. " +
      "A vague 'later' is a no; a specific time is a meeting.",
  },
  {
    code: "we_tried_before",
    cue: '"We tried something like that and it didn\'t work."',
    response:
      "This is the most valuable thing they can tell you. Ask what they tried and what specifically failed. Only then say — briefly and " +
      "concretely — what is different here. If it isn't meaningfully different, say so and end the call honestly.",
  },
  {
    code: "bad_timing",
    cue: '"Now\'s not a good time for us / we\'re slammed / ask me after the season."',
    response:
      "Separate the meeting from the project. They are not committing to buy or to start — they're spending fifteen minutes to know " +
      "whether it's worth revisiting when things calm down. Book it out at the timeframe they name.",
  },
  {
    code: "remove_me",
    cue: '"Take me off your list / do not call me again / stop calling."',
    response:
      "STOP SELLING IMMEDIATELY. Apologize once, briefly, confirm they will not be contacted again, call mark_do_not_call, and end the " +
      "call politely. Do not ask why, do not re-ask, do not offer email instead. This is not an objection to handle — it is an instruction.",
  },
];

const BY_CODE = new Map(OBJECTIONS.map((o) => [o.code, o]));

export function objectionCodes(): string[] {
  return OBJECTIONS.map((o) => o.code);
}

export function getObjection(code: string): Objection | undefined {
  return BY_CODE.get(code);
}

/** Render the playbook into the block that goes in the call instructions. */
export function renderObjectionPlaybook(): string {
  return OBJECTIONS.map((o) => `[${o.code}] ${o.cue}\n   → ${o.response}`).join("\n\n");
}
