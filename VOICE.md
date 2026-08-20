# Voice — the AI cold-calling channel

A speech-to-speech SDR that dials a lead, opens like a human, handles objections,
pushes for a close, and books the meeting — then feeds what happened back into
the same events/scoring/CRM machinery the email side already uses.

Status: **beta, fully wired**. Every path below is implemented. What it has not
had is volume on a real carrier — see [What beta means](#what-beta-means).

---

## 1. The shape of it

```
                    ┌─────────────────────────────────────────┐
   agent / CLI ────▶│  calls collection  (status: queued)      │
   queue_calls      └───────────────┬─────────────────────────┘
                                    │
                        dialer worker (cron /2m)
                                    │
                    ┌───────────────▼──────────────┐
                    │  COMPLIANCE GATE             │  ← the model never sees this
                    │  DNC · local hours · attempts│
                    │  concurrency · daily cap     │
                    └───────────────┬──────────────┘
                                    │ allowed
                         Twilio REST (originate)
                                    │
                          ☎ prospect's phone rings
                                    │ answered
                    POST /voice/answer/:callId  ──▶ machine? ─▶ voicemail TwiML ─▶ done
                                    │ human
                      <Connect><Stream wss://…/voice/media/:callId>
                                    │
   ┌────────────────────────────────▼─────────────────────────────────┐
   │                         MEDIA BRIDGE                             │
   │   Twilio μ-law 8k  ⇄  OpenAI Realtime (gpt-realtime-2, μ-law 8k) │
   │                                                                  │
   │   enforced in code, not by the prompt:                           │
   │     · barge-in      (clear the carrier buffer on speech_started) │
   │     · ask ceiling   (count asks, nudge, then cut off)            │
   │     · wall clock    (warn, then hard hangup)                     │
   │                                                                  │
   │   in-call tools: check_availability · book_meeting               │
   │                  send_followup_email · log_objection             │
   │                  mark_not_interested · mark_do_not_call          │
   │                  transfer_to_human · end_call                    │
   └────────────────────────────────┬─────────────────────────────────┘
                                    │ hangup
                    post-call analysis (worker LLM, 1 call)
                                    │
              outcome · objections · askCount · summary · grade
                                    │
                    ┌───────────────▼──────────────┐
                    │  events  →  scoring  →  CRM  │  (the existing pipeline)
                    │  booked → stops sequences,   │
                    │           notifies the human │
                    └──────────────────────────────┘
```

Two seams keep vendors out of the business logic, mirroring `EmailSender`:

| Interface | Who does it today | Swap cost |
|---|---|---|
| `TelephonyProvider` | Twilio (raw REST, no SDK) | one file |
| `RealtimeVoice` | OpenAI Realtime over WS | one file |

A Deepgram → LLM → ElevenLabs pipeline would implement `RealtimeVoice` and change
nothing else. Neither the dialer, the script, the gate, nor the analysis knows a
vendor name.

---

## 2. Why speech-to-speech rather than STT → LLM → TTS

The classic pipeline costs three sequential hops per turn (transcribe, think,
synthesize), each with its own buffering. Real cold-call turn-taking lives or
dies under about 700ms, and a prospect who hears a beat of silence after "hello?"
has already decided you're a robot.

A speech-to-speech model collapses the hops and — the part that actually matters
for selling — hears *how* they said it. "Yeah, I guess" and "Yeah!" are the same
transcript and opposite calls.

The cost is that you cannot inspect the text between hearing and speaking, which
is exactly where you'd want to enforce rules. That is why every guardrail in this
design sits either **before** the model (the compliance gate) or **around** it
(bridge-enforced ask ceiling and wall clock), never inside a prompt that hopes
for compliance.

**μ-law end to end.** Twilio's media stream carries G.711 μ-law at 8kHz, and the
realtime session is configured for the same, so audio crosses this process as
opaque base64 with zero resampling. Transcoding is the usual source of both added
latency and that thin robotic timbre.

---

## 3. The sales brain

`services/voice/script.ts` compiles one instruction block from the campaign's
offer, the lead's record, the objection playbook, and the strategist's accumulated
playbook notes. The same text drives the live session, the offline simulator, and
the standard the post-call analyzer grades against — so they cannot drift.

**Flow.** Opener with an admitted cold call → permission → one-sentence reason →
listen → bridge → **specific** ask (two named times, never "when are you free?")
→ handle → re-ask → confirm → exit. The agent is told to earn each stage.

**Objections** (`services/voice/objections.ts`) are data, not prose, because the
same vocabulary does three jobs: teaching the live agent, tagging each call, and
telling the strategist which objection is killing the campaign. Every response
follows ACKNOWLEDGE → REFRAME → RE-ASK, and each re-ask must carry *new*
information — otherwise it's nagging.

Fourteen codes ship: `not_interested`, `no_time`, `send_info`,
`already_have_solution`, `too_expensive`, `no_budget`, `not_decision_maker`,
`gatekeeper_screen`, `how_did_you_get_my_number`, `is_this_ai`, `call_me_later`,
`we_tried_before`, `bad_timing`, `remove_me`.

**The close ladder.** The agent may ask up to `VOICE_MAX_ASKS` (default 3) times.
One ask leaves meetings on the table; five is harassment. The prompt states the
limit, and the **bridge counts it independently** — nudging at the ceiling and
cutting the agent off past it, because a model told "ask at most three times"
will cheerfully ask five.

---

## 4. Guardrails, and where each one lives

| Guardrail | Enforced in | Why there |
|---|---|---|
| Do-not-call list | `compliance.service.ts`, at dial time | A lead can go on the list between queueing and dialing |
| Calling hours in the **prospect's** timezone | same | 9pm calls are how you get complained about |
| Attempts per lead, daily cap, concurrency | same | Bounds spend, carrier reputation, and nuisance |
| Campaign paused/archived | dialer, via `dispositionForCampaignStatus` | Same rule the email dispatcher uses |
| Ask ceiling | media bridge | Counted in code; prompts don't count reliably |
| Hard hangup | media bridge | A wedged session must not hold a metered line |
| Never deny being an AI | script, non-configurable | See below |
| Webhook authenticity | `validateTwilioSignature` | Public URLs that start phone calls |

### The AI-disclosure rule

Two separate things:

- **Proactive disclosure in the opener** — `VOICE_DISCLOSE_AI_UPFRONT`, default
  on. You can turn it off.
- **Never denying it when asked** — hardcoded into the instructions, ranked above
  the instruction to book the meeting, and reinforced by the `is_this_ai`
  objection entry. There is no env var for this.

That split is deliberate. Several jurisdictions require bot disclosure outright,
disclosure laws are moving fast, and a system that lies about being human when a
person directly asks is one recording away from being the story. Making it
configurable would mean shipping the switch that turns this into a deception tool.

### What is *not* approval-gated, and why

In-call tools bypass the Telegram approval queue for an unavoidable reason: a live
call cannot wait for a human to tap ✅. Rather than gate at run time, the toolset
itself is kept to actions that are safe unattended — none spends money, changes a
campaign, sends bulk anything, or touches another lead.

The gate sits one level up: **`queue_calls` is high-risk**, so under the default
`semi` autonomy the agent must get your approval before any AI voice dials anyone.

---

## 5. Data model

New collections: `calls`, `dnc`. New field: `Lead.phone` (E.164, normalized at
import). New event types: `call_placed`, `call_connected`, `call_positive`,
`call_negative`, `call_no_answer`, `call_voicemail`, `call_dnc` — all weighted in
`scoring.config.ts`, so a live conversation outscores every email engagement short
of a reply.

A meeting booked on the phone records the **existing** `booked` event rather than
a voice-specific one, so sequence-stopping, lead status, and the hot notification
all fire through machinery that already works. The metadata carries
`verbal_commitment: true` — the prospect agreed on the call, the calendar invite
follows by email, and the CRM shouldn't claim a calendar write that didn't happen.

**Retries.** No-answer and voicemail requeue up to `VOICE_MAX_ATTEMPTS`, each at a
*different* hour of the window — a prospect who never answers at 9am may always
answer at 4pm, and calling the same slot three days running just looks like spam.

---

## 6. Preflight — prove the voice works before anyone's phone rings

```bash
npm run cli -- voice-preflight                          # configured model
npm run cli -- voice-preflight --model gpt-realtime-2.1 # try another
npm run cli -- voice-preflight --lead dana@acme.com --campaign "Roofers Q3"
```

Opens a **real** realtime session with the real instructions and tool schema,
lets the agent deliver its opener, prints the transcript, and writes the returned
μ-law to a playable WAV at `data/voice/preflight-<model>.wav`. One round trip
exercises credentials, model availability, session schema, tool-definition
validity, and audio format — everything a live call needs except the carrier.

If the configured schema fails it automatically retries the other one, because a
GA/beta mismatch presents as a session that connects and then says nothing — the
hardest failure to diagnose from an actual phone call.

Preflight also prints the session the **server echoed back**, which is the only
reliable confirmation: an unsupported audio setting is dropped silently rather
than rejected, so "I sent it" and "it is in force" are different claims.

**Verified on this account** (2026-08-12), every value confirmed applied:

```
model=gpt-realtime-2  schema=ga  voice=ash
audio=audio/pcmu→audio/pcmu   transcribe=gpt-realtime-whisper   noise=far_field
turn-taking: server_vad  threshold=0.5  prefixPadding=140ms  silence=260ms
```

`gpt-realtime` and `gpt-realtime-2.1` also work. The full family is available,
including the cheaper `gpt-realtime-mini` / `gpt-realtime-2.1-mini` — the mini
tier is the cost lever once the pitch is settled.

### Tuning turn-taking

The three VAD numbers decide whether the agent feels human or like a
walkie-talkie, and phone audio is nothing like a headset:

| Setting | Default | Raise it when | Lower it when |
|---|---|---|---|
| `VOICE_VAD_THRESHOLD` | `0.5` | background noise keeps triggering the agent | soft-spoken prospects get missed |
| `VOICE_PREFIX_PADDING_MS` | `140` | first syllables are clipped from transcripts | the agent picks up stray room noise |
| `VOICE_SILENCE_MS` | `260` | the agent cuts people off mid-thought | it feels sluggish to answer |

`VOICE_NOISE_REDUCTION=far_field` suits the reality of this channel — prospects
on speakerphone, in a truck, on a job site. Use `near_field` for handset-to-ear.

## 7. Try the whole conversation without a phone number

The expensive, risky part of a calling bot isn't the audio plumbing — it's whether
it can take "not interested" and still get to a close. You don't need Twilio to
find that out:

```bash
# rehearse against an LLM playing a hostile prospect
npm run cli -- call-sim dana@example.com --persona "skeptical roofing owner, mid-job, hates salespeople"

# or type the prospect's replies yourself
npm run cli -- call-sim dana@example.com

# see the exact instructions the voice agent receives
npm run cli -- call-script dana@example.com --campaign "Roofers Q3"
```

The simulator runs the **same** instructions, **same** tool definitions, and
**same** post-call analysis through the cheap worker model. It does not test
audio quality, latency, barge-in, VAD turn-taking, or answering-machine
detection — those only show up on a real line.

---

## 8. Going live

### Which model powers what

Three independent roles. Only one of them is picky:

| Role | Used for | Accepts |
|---|---|---|
| `worker` | personalization, reply classification, **post-call analysis, the simulator** | any OpenAI-compatible endpoint — API key, ChatGPT/Codex OAuth, or GLM/z.ai |
| `strategist` | daily/weekly/monthly reviews | same |
| **voice realtime** | **the live conversation** | **OpenAI only** — API key *or* ChatGPT/Codex OAuth |

The Realtime API is an OpenAI WebSocket endpoint; GLM/z.ai has no wire-compatible
speech-to-speech equivalent, so this role cannot move off OpenAI the way the other
two can.

### Two ways to authenticate it (`VOICE_REALTIME_AUTH`)

**`api-key`** (default) — a `platform.openai.com` key. Metered per audio minute in
both directions, which is the dominant cost of the channel and the reason
`VOICE_MAX_CONCURRENT` and `VOICE_DAILY_CALL_LIMIT` exist.

**`openai-oauth`** — a ChatGPT/Codex token from `~/.codex/auth.json`, billed
against a subscription instead. **Verified working** against the live API: full
session lifecycle, identical audio settings, real speech returned. Two strings
attached, and neither is theoretical:

1. **The token expires.** It carries an `exp` typically hours to days out and
   must be renewed from a refresh token that can itself be revoked — at which
   point `getSession()` returns HTTP 401 and the credential is on a countdown
   with no way to renew itself. `realtime-auth.ts` therefore resolves a bearer
   **per session** (never cached, so a re-authentication is picked up without a
   redeploy), falls back to the stored token with a loud warning when refresh is
   refused, and **the dialer refuses to place a call whose credentials could
   expire before the call ends** — `requiredRunwayMinutes()` is the call ceiling
   plus five. A call must never outlive its own token, because the failure lands
   on a real prospect mid-sentence.
2. **Terms of service.** Driving a commercial outbound calling system from
   subscription credentials is a business question, not a technical one. The
   downside isn't a failed call — it's the account.

Check remaining runway any time with `npm run cli voice-preflight`, which prints
the auth source and minutes left.

`call-sim` needs only the **worker**, which is why you can rehearse the entire
pitch, objection handling, and close for free before spending a cent on voice.

Under `api-key`, `VOICE_REALTIME_API_KEY` falls back to `WORKER_API_KEY` for the
common case where the worker already is OpenAI. When it isn't, the readiness check
says so rather than letting you find out mid-call.

### Steps

1. `VOICE_ENABLED=true`, keep `DRY_RUN=true` at first (the dialer logs instead of dialing).
2. Twilio: voice-capable number → `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
3. Credentials: either `VOICE_REALTIME_API_KEY` (a real `platform.openai.com` key
   with billing on) or `VOICE_REALTIME_AUTH="openai-oauth"` — see above for the
   expiry and ToS caveats. The dialer refuses to place calls with unusable or
   soon-to-expire credentials, rather than connecting a prospect to silence.
4. **`TRACKING_BASE_URL` must be public and HTTPS** — Twilio fetches the TwiML
   from it and opens the `wss://` media stream against it. Same requirement as
   open tracking, same host.
5. Put phone numbers *and* `timezone` on leads (`import-leads` normalizes both).
6. `npm run cli -- call-check <email>` — dry-run the gate.
7. `npm run cli -- call-sim <email> --persona "…"` — rehearse the pitch.
8. Flip `DRY_RUN=false`, call yourself first: `call-lead <your own lead> && dial`.
9. Start at `VOICE_DAILY_CALL_LIMIT=10` and read every transcript before scaling.

### Call your own phone

```bash
npm run cli -- call-me --phone "+15551234567" --name "Alex"
```

One command: refuses with a checklist unless every precondition is met, then
upserts a test lead, queues, dials, waits, and prints the transcript, outcome,
objection tags and ask count. It checks `TRACKING_BASE_URL/voice/health` first,
because the media bridge runs in the **tracking server**, not the CLI — if that
host isn't running this build, Twilio connects your call to silence, which looks
exactly like a broken agent.

Needs, in order: a Twilio number, `VOICE_ENABLED=true`, `DRY_RUN=false`, and a
publicly reachable tracking server (deploy, or a tunnel with `TRACKING_BASE_URL`
pointed at it). Outside calling hours, prepend
`VOICE_WINDOW_START_HOUR=0 VOICE_WINDOW_END_HOUR=24`.

### Operator commands

```
call-me --phone "+1555..."                         call YOUR phone, end to end
call-lead <email> [--campaign <id>] [--at <iso>]   queue a call
dial                                               place due calls now
call-sim <email> [--persona "..."] [--turns 14]    rehearse, no phone needed
calls [--status <s>] [--limit 25]                  recent calls + outcomes
call-transcript <callId>                           full turn-by-turn
voice-preflight [--model <m>]                      prove the live voice model works
call-check <email>                                 dry-run the compliance gate
call-script <email> [--campaign <c>]               print the agent's instructions
dnc [--add <phone> --reason "..."]                 view/extend do-not-call
```

### Agent tools

`queue_calls` (**high risk**, approval-gated) · `get_call_metrics` ·
`list_calls` · `get_call_transcript` · `check_call_eligibility` ·
`get_objection_playbook` · `add_to_dnc` (low risk — it can only stop contact).

---

## 9. What beta means

Implemented and verified by typecheck, unit tests, and rendered output:
the full queue → gate → dial → bridge → tools → analysis → events path, the
simulator, the CLI, and the agent tools.

Not yet proven, and what to watch on your first real calls:

- **Realtime API schema drift.** The session shape changed between the beta and
  GA releases. Outbound config follows `VOICE_REALTIME_SCHEMA` (default `ga`) and
  inbound events are accepted in both spellings — but if you get a connected call
  with silence, flip it to `beta` first.
- **Answering-machine detection** is Twilio's, and it is good, not perfect. A
  misdetection either talks to a beep or voicemails a human.
- **Barge-in tuning.** `VOICE_SILENCE_MS` (620ms) is a starting point, not a
  tuned value. Too low and it interrupts a thinking prospect; too high and it
  feels sluggish.
- **The 3-second hangup grace** lets the closing line finish playing. If goodbyes
  clip, raise `HANGUP_GRACE_MS` in `media-bridge.ts`.
- **Ask detection** (`ASK_PATTERN`) is a regex over agent transcripts. It will
  miss unusually-phrased asks; the post-call analyzer recounts them properly, so
  the metric is right even when the live ceiling fires late.
- **Cost.** Every connected call is a metered realtime session *and* carrier
  minutes. `VOICE_MAX_CONCURRENT` and `VOICE_DAILY_CALL_LIMIT` are your spend
  ceiling — set them before you set the pitch.

## 10. Before you dial anyone

This channel calls people who did not ask to be called, with a synthetic voice.
That is legal in many places and regulated in most of them, and the rules differ
by country and by US state. Your obligations — not this system's — include
consent and registry rules (TCPA and state equivalents), the national and state
do-not-call registries, two-party recording consent, and AI-disclosure statutes.

The gate here enforces *your* configured window, *your* caps, and an internal DNC
list. It does not scrub against national DNC registries, and it does not know
your jurisdiction. Wire in a registry scrub before dialing a purchased list.
