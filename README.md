# AI SDR/BDR System

An autonomous-but-controlled outbound sales engine: it finds/manages leads, runs
multi-touch email campaigns, personalizes every email with an LLM, tracks
engagement, scores leads, notifies you on hot signals, and learns from results
through a daily strategist review.

This is **milestone 1: the core outbound engine**, built to extend toward the
full master plan (experimentation framework, Loom/video outreach, weekly/monthly
reviews — see [ARCHITECTURE.md](./ARCHITECTURE.md)).

> ⚠️ **Before anything:** your old MongoDB password was committed to a public
> repo. **Rotate it in Atlas** and put the new connection string only in `.env`
> (which is git-ignored). Never commit credentials.

---

## What it does today

```
Leads → Campaign (5–7 touch sequence) → AI personalization → SMTP send
   → open/click/reply tracking → lead scoring → human notification
   → batch event processing → daily strategist review/digest
```

- **5–7 email sequence** per prospect with widening business-day spacing
  (0, 3, 7, 12, 18, 25, 33 business days) — because most replies need multiple touches.
- **Two LLM roles** behind one OpenAI-compatible interface:
  - *worker* (GPT-5.4 mini) — writes/personalizes emails, classifies replies.
  - *strategist* (GLM-5.2 max) — once-daily performance review + experiment ideas.
- **Tracking server** (Express): open pixel, click redirects, unsubscribe, reply webhook.
- **Lead scoring** with hot-lead escalation (notify at ≥40, "call now" at ≥70).
- **Cost control**: events are batch-processed on a schedule, not per-event.
- **Safety**: dry-run mode, daily send caps, sending window, unsubscribe footer.

---

## Setup

```bash
npm install
cp .env.example .env      # then fill in real values (rotated DB password!)
npm run cli init          # create indexes
```

Fill in at minimum: `MONGODB_URI`, `WORKER_API_KEY` (+model/baseURL),
`STRATEGIST_API_KEY` (+model/baseURL), and SMTP creds. Keep `DRY_RUN=true`
until you've watched a few emails render correctly.

## Quick start (dry run)

```bash
# 1. Import leads (CSV needs an 'email' column; extra columns become personalization vars)
npm run cli import-leads data/sample-leads.csv

# 2. Create a campaign (uses the default 7-touch sequence)
npm run cli create-campaign \
  --name "Q3 Healthcare Ops" \
  --offer "we cut manual claims processing time by ~40% with an AI workflow layer" \
  --persona "VP/Director of Operations at mid-market healthcare companies" \
  --from "alex@yourdomain.com" --active

# 3. Enroll leads (schedules each lead's first touch)
npm run cli enroll --campaign "Q3 Healthcare Ops" --status new --limit 50

# 4. Send what's due (ignore the time window for testing)
npm run cli dispatch --ignore-window

# 5. Simulate engagement + scoring
npm run cli event --email jane.doe@acmehealth.com --type open
npm run cli ingest-reply --email jane.doe@acmehealth.com --text "Sure, how does Tuesday look?"
npm run cli process-events
npm run cli lead jane.doe@acmehealth.com
```

## Running for real

1. Set `DRY_RUN=false` and valid SMTP creds.
2. Deploy the **tracking server** somewhere public and set `TRACKING_BASE_URL`
   to that URL (opens/clicks only work if prospects can reach it). You can reuse
   your existing Cloud Run host.
3. Start the whole system (tracking server + cron jobs):

```bash
npm start
```

Jobs: dispatch every 5 min, event processing every 10 min, daily strategist
review at 08:30. All self-throttle to `DAILY_SEND_LIMIT` and the sending window.

## CLI reference

Run `npm run cli` with no args to see all commands (import-leads, add-lead,
create-campaign, list-campaigns, activate-campaign, enroll, dispatch,
process-events, daily-cycle, ingest-reply, event, status, lead).

## Deliverability checklist (do this or you'll land in spam)

- Set up **SPF, DKIM, DMARC** on your sending domain.
- **Warm up** new inboxes before volume (Instantly etc.) and keep daily volume low at first.
- Use a separate domain (e.g. `get-yourbrand.com`) for cold, not your primary.
- Keep the unsubscribe footer + physical address on (CAN-SPAM).
- Watch bounce/spam rates; the system stops sequencing on unsubscribe/bounce automatically.
