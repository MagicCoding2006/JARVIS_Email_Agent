# Architecture

## Layers (master-plan mapping)

| Master-plan layer        | Where it lives                                              | Status |
|--------------------------|------------------------------------------------------------|--------|
| Leads database           | `models/types.ts`, `repositories/` (`leads`)               | ✅ done |
| Campaign engine          | `repositories` (`campaigns`), `services/sequences/`        | ✅ done |
| AI personalization       | `services/personalization.service.ts`, `llm/`              | ✅ done |
| Email sending            | `services/sender/` (SMTP; OAuth/Instantly = drop-in)       | ✅ done |
| Tracking layer           | `server/tracking-server.ts`, `services/tracking.service.ts`| ✅ done |
| Lead scoring             | `services/scoring.*`                                        | ✅ done |
| Meeting booking          | `services/booking.service.ts` + `/webhook/booking/:provider` | ✅ done (Calendly/Cal.com/generic → `booked`) |
| Human notification       | `services/notifications.service.ts`                        | ✅ done |
| Outcome tracking         | `events` collection + `event` CLI                          | ✅ done |
| Experiment analysis      | `services/variants.service.ts` (bandit) + `analytics.service.ts` | ✅ done (epsilon-greedy selection + stats rollup + leaderboards) |
| Campaign optimization    | `workers/daily-cycle.ts` → auto-generates + tests variants | ✅ done (closed loop: strategist → worker → bandit → prune) |
| Gmail manual send (pixel)| `services/compose.service.ts` + `/api/createPixel`         | ✅ done (ported from Pixel-Injectable, unified tracking) |
| Loom / video outreach    | `services/video.service.ts` + `/v/:id`                     | ✅ done (script + tracked link + watch%; TTS/avatar render = pluggable) |
| Weekly / monthly review  | `workers/weekly-review.ts`, `workers/monthly-review.ts`    | ✅ done |

## Data model (MongoDB, `email_db`)

- **leads** — person + company + status + score + unsubscribe token.
- **campaigns** — offer, persona, and an embedded `sequence: SequenceStep[]`.
- **enrollments** — one lead↔campaign; tracks `currentStep` (last sent) + status.
- **messages** — one email (scheduled→sent), with rendered html/text, tracked links, pixel id.
- **events** — sent/open/click/reply/booked/… ; `processed` flag for batch scoring.
- **variants** / **hypotheses** — experimentation substrate (the long-term asset).
- **videos** — Loom/video assets: AI script, render status, tracked watch URL, watch %.
- **notifications** — audit log of alerts.

The existing pixel app's `emails` collection is left untouched; this system uses
its own collections in the same database.

## Control flow

```
enroll → scheduleNextStep (draft + render + schedule step 1)
            │
   cron /5m │ dispatcher: send due messages within window + caps
            ▼
        send ok → record `sent` → advance enrollment → scheduleNextStep (step N+1)
            │
prospect    │ open pixel / click redirect / reply webhook  →  events
            ▼
   cron /10m  event-processor: score events → escalate hot leads → stop on reply/unsub/bounce
            │
   cron 1/day strategist: daily review → hypotheses + digest
```

Replies, unsubscribes, and bounces **stop** the sequence automatically; out-of-office does not.

## The learning loop (closed)

```
daily-cycle:  strategist reviews metrics → hypotheses
                 → worker generates NEW variants (subjects/CTAs/tones) → activated
sequencer:    selectVariant() picks an arm (epsilon-greedy) per send
event-proc:   rolls open/click/reply/booked into variant.stats
weekly-review: pruneVariants() retires arms scoring <60% of the best (winners kept)
```

This is the compounding asset: every send feeds `variants`/`hypotheses`, and the
system biases toward what actually books meetings — not just new copy.

## Remaining / pluggable

1. **Reply intake** — point Instantly/SES/Mailgun inbound (or an IMAP poller) at
   `POST /webhook/reply`. Webhook + manual `ingest-reply` CLI exist today.
2. **Video render** — implement the `VideoRenderer` interface (HeyGen/ElevenLabs/
   Synthesia) and call `renderVideo()`; script + tracking already work.
3. **Thompson sampling** — swap the epsilon-greedy in `variants.service.ts` for a
   Beta-Bernoulli sampler once volume justifies it.
4. **Revenue/CRM sync** — push `closed_won`/`closed_lost` + amounts from your CRM
   via the `event` path so monthly revenue rollups are real.

## Swapping providers

- **LLM**: change `WORKER_*` / `STRATEGIST_*` env vars (any OpenAI-compatible API).
- **Sender**: implement `EmailSender` (see `sender.interface.ts`) for Gmail OAuth
  or Instantly and wire it in `services/sender/index.ts`.
