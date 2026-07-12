# JARVIS Email Agent

An autonomous-but-controlled outbound sales system. It can source/import leads,
manage campaigns, write personalized cold emails, rotate sending inboxes, track
opens/clicks/replies/video watches, score leads, run experiments, produce custom
video outreach, and let you control high-risk actions from Telegram.

The system is built around one rule: the AI can help operate the funnel, but
dangerous actions such as launching campaigns, enrolling leads, sourcing paid
leads, applying live templates, and rendering videos can require approval.

> Important: never commit `.env` or API keys. If any database/API credentials
> were ever committed publicly, rotate them before running this system.

## What It Does

```text
Leads -> Campaigns -> AI or hybrid-template emails -> mailbox rotation + SMTP
   -> open/click/reply/video tracking -> scoring + CRM dashboard
   -> strategist reviews, experiments, Telegram approvals, and follow-up actions
```

Core capabilities:

- Multi-touch campaigns with scheduled follow-ups.
- AI-written emails through a worker LLM.
- Hybrid email templates where fixed copy stays fixed and only selected slots are AI/research-filled.
- Telegram bot for chat, status checks, pending approvals, and trusted user/group access.
- Dashboard at `/dashboard/` with CRM, stats, source breakdowns, charts, mailbox status, and actions.
- Mailbox rotation with sticky inbox assignment per prospect.
- Warmup-aware send caps, sending windows, dry-run mode, and bounce-rate pause protection.
- Open pixel, click redirects, unsubscribe, reply webhook, booking webhook, and video-watch tracking.
- IMAP reply polling if you do not have an inbound webhook provider.
- Lead sourcing from CSV, public web discovery, contractor discovery, Apollo API, and Apify actors.
- Serper/Tavily/SearXNG/DuckDuckGo-backed web search for research and lead discovery.
- Apify lead import with cost cap and Mongo import.
- AI experiment loop with variants, hypothesis scoring, pruning, daily/weekly/monthly reviews.
- Custom video outreach: script generation, website screenshot background, Gemini TTS voiceover, captions, Remotion MP4 render.

Current production limitation:

- Rendered videos are saved locally as `data/videos/<videoId>.mp4` and stored as
  `file://...` URLs. For real prospect links, add public hosting, such as serving
  `/videos` from the app for testing or uploading MP4s to S3/Cloudflare R2 for production.

## Requirements

- Node.js 20+
- MongoDB
- SMTP inbox credentials or a mailbox pool
- Worker LLM API key
- Strategist LLM API key
- Optional: Telegram bot token
- Optional: search API key such as Serper or Tavily
- Optional: Apify API token
- Optional: Gemini API key and Remotion dependencies for video rendering

## Setup

```bash
npm install
cp .env.example .env
npm run cli -- init
```

Fill in at minimum:

```env
MONGODB_URI=
WORKER_API_KEY=
STRATEGIST_API_KEY=
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
FROM_EMAIL=
FROM_NAME=
```

Keep this on while testing:

```env
DRY_RUN=true
```

Only set `DRY_RUN=false` after you have reviewed generated emails and confirmed
your SMTP/domain setup is correct.

## Running The App

Start the full system:

```bash
npm start
```

This starts:

- Tracking server
- Dashboard
- Telegram bot if configured
- Scheduler jobs
- Dispatch loop
- Event processing
- Daily/weekly/monthly review jobs

Start only the tracking server/dashboard:

```bash
npm run tracking-server
```

Open:

```text
http://localhost:8787/dashboard/
```

Health check:

```text
http://localhost:8787/health
```

For production, set:

```env
TRACKING_BASE_URL=https://your-public-app-url
```

Open/click/unsubscribe/video links only work for prospects if this URL is public.

## Quick Start

Import leads:

```bash
npm run cli -- import-leads data/sample-leads.csv
```

Create a campaign:

```bash
npm run cli -- create-campaign \
  --name "Missed Call AI - Roofers" \
  --offer "AI calls missed leads back in 30 seconds, qualifies them, books jobs to the calendar, and texts the details" \
  --persona "owner/operators at local roofing companies"
```

Review campaigns:

```bash
npm run cli -- list-campaigns
```

Activate when ready:

```bash
npm run cli -- activate-campaign "Missed Call AI - Roofers"
```

Enroll leads:

```bash
npm run cli -- enroll --campaign "Missed Call AI - Roofers" --status new --limit 25
```

Dispatch due emails in a test run:

```bash
npm run cli -- dispatch --ignore-window
```

Inspect a lead:

```bash
npm run cli -- lead info@example.com
```

Pipeline status:

```bash
npm run cli -- status
```

## Telegram Bot

Configure:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ALLOWED_USER_IDS=
TELEGRAM_ALLOWED_CHAT_IDS=
AGENT_AUTONOMY=semi
```

Behavior:

- `TELEGRAM_CHAT_ID` is the default owner chat for startup messages and notifications.
- `TELEGRAM_ALLOWED_USER_IDS` lets trusted Telegram users talk to the bot from private chats or groups.
- `TELEGRAM_ALLOWED_CHAT_IDS` authorizes everyone in a specific group/chat.
- Under `AGENT_AUTONOMY=semi`, low-risk tools run automatically and high-risk actions require approval.

Useful commands in Telegram:

```text
/start
/pending
/reset
```

Example prompts:

```text
How are campaigns doing this week?
Find 20 roofing contractor leads in Austin.
Draft a hybrid template for step 1 of the missed-call campaign.
Create a video script for info@prosperityroofs.com.
Render video <videoId>.
```

If a group message is ignored, check BotFather privacy mode and the logs. The log
prints unauthorized chat/user IDs so you can add them to `.env`.

## Dashboard

The dashboard is mounted on the same Express server:

```text
/dashboard/
```

It includes:

- KPI cards
- CRM table
- Lead status/source/score charts
- Email activity over time
- Conversion funnel
- Campaign performance
- Industry performance
- Experiment status
- Mailbox warmup/capacity status
- Basic actions for discovery, enrollment, dispatch, and export

## Email Generation

There are two writing modes.

### Fully AI-written

If a campaign step has no template, the worker model writes the full email from:

- Lead fields
- Campaign offer/persona
- Step angle/instructions
- Prior thread context for follow-ups
- Variant hints when an experiment arm is selected

### Hybrid templates

Use templates when you want fixed structure with AI only in selected areas.

Supported slots:

```text
{{firstName|there}}
{{company|your team}}
{{ai: one sharp opener about this prospect}}
{{research: one recent company-specific fact}}
```

Example sequence file:

```text
examples/templated-sequence.json
```

Create a campaign from it:

```bash
npm run cli -- create-campaign \
  --name "Templated Test" \
  --offer "..." \
  --persona "..." \
  --sequence-file examples/templated-sequence.json
```

The Telegram agent can also call:

- `draft_step_template`
- `set_step_template`

Applying a template is high-risk because it changes live campaign copy.

## Lead Sourcing

CSV import:

```bash
npm run cli -- import-leads data/leads.csv --source manual
```

Add one lead:

```bash
npm run cli -- add-lead \
  --email info@prosperityroofs.com \
  --company "Prosperity Roofing" \
  --industry "roofing" \
  --website "https://prosperityroofs.com"
```

Public web discovery:

```bash
npm run cli -- discover-businesses \
  --industry "HVAC contractors" \
  --location "Indianapolis, IN" \
  --limit 25 \
  --allow-unverified
```

Contractor-targeted discovery:

```bash
npm run cli -- discover-contractors \
  --trade "roofing" \
  --location "Austin, TX" \
  --limit 25 \
  --allow-unverified
```

Apify lead sourcing:

```bash
npm run cli -- source-leads-apify --limit 5000
```

Important:

- Use `--` after `npm run cli` so flags reach the CLI.
- Apify cost caps are best-effort while polling. They can overshoot between polls.
- Imported leads are deduped by email in Mongo.

Email verification:

```bash
npm run cli -- verify-email --email someone@example.com
npm run cli -- verify-email --first Jane --last Doe --domain example.com
```

## Mailboxes And Sending

Single SMTP mailbox:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
FROM_EMAIL=
FROM_NAME=
```

Mailbox pool:

```env
MAILBOXES='[
  {"email":"sales1@example.com","user":"sales1@example.com","pass":"app-password-1"},
  {"email":"sales2@example.com","user":"sales2@example.com","pass":"app-password-2"}
]'
```

Warmup/caps:

```env
MAILBOX_DAILY_CAP=40
WARMUP_ENABLED=true
WARMUP_START_PER_DAY=5
WARMUP_INCREMENT_PER_DAY=5
WARMUP_MAX_PER_DAY=40
```

Dispatch behavior:

- Each prospect gets a sticky mailbox for the whole thread.
- The dispatcher respects warmup capacity and daily caps.
- If a mailbox is capped, due messages are deferred.
- If bounce rate spikes, sending pauses automatically.

## Tracking And Replies

Tracking server routes:

```text
/o/:messageId.gif        open pixel
/c/:linkId               click redirect
/u/:token                unsubscribe
/v/:id                   video watch redirect/page
/webhook/reply           inbound reply webhook
/webhook/booking/:provider
/api/createPixel         Gmail compose pixel helper
```

Manual events:

```bash
npm run cli -- event --email jane@example.com --type open
npm run cli -- event --email jane@example.com --type booked
```

Simulate a reply:

```bash
npm run cli -- ingest-reply --email jane@example.com --text "Sure, send times."
```

Poll IMAP replies:

```bash
npm run cli -- poll-replies
```

Enable IMAP:

```env
IMAP_ENABLED=true
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_SECURE=true
```

## Video Outreach

One-command local video creation:

```bash
npm run cli -- create-video --email info@prosperityroofs.com
```

This will:

- Create a personalized script
- Use a real first name when available, otherwise greet the company team
- Use a missed-call AI offer by default
- Avoid em dashes in the script
- Capture the prospect website if `lead.website` exists
- Use website/brand context in scenes
- Generate Gemini TTS voiceover
- Generate captions from the script
- Render an MP4 with Remotion

Script only:

```bash
npm run cli -- video-script --email info@prosperityroofs.com
```

Render an existing scripted video:

```bash
npm run cli -- produce-video <videoId>
```

Video purpose options:

```bash
--purpose cold
--purpose follow_up
--purpose appointment
--purpose proposal
```

Video setup:

```bash
cd remotion
npm install
cd ..
```

Then in `.env`:

```env
GEMINI_API_KEY=
GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts
GEMINI_TTS_VOICE=Achird
VIDEO_ENABLE_REMOTION=true
VIDEO_OUTPUT_DIR=data/videos
VIDEO_CAPTURE_WEBSITE=true
```

Rendered files land in:

```text
data/videos/<videoId>.mp4
```

When the tracking server is running, rendered videos are served publicly from:

```text
<TRACKING_BASE_URL>/videos/<videoId>.mp4
```

Open a local video:

```bash
open data/videos/<videoId>.mp4
```

Production note: if you host on Railway, mount a Railway Volume at the directory
used by `VIDEO_OUTPUT_DIR` so generated videos survive redeploys. For higher
volume, move video files to S3/Cloudflare R2 and store those public URLs.

## Experiments And Reviews

Generate variants:

```bash
npm run cli -- gen-variants --campaign "Campaign Name" --step 1 --count 3
```

Leaderboard:

```bash
npm run cli -- list-variants --campaign "Campaign Name"
```

Prune weak variants:

```bash
npm run cli -- prune-variants --campaign "Campaign Name"
```

Run reviews:

```bash
npm run cli -- daily-cycle
npm run cli -- weekly-review
npm run cli -- monthly-review
```

The scheduled 08:30 daily update is controlled by `AGENT_DAILY_MODE`:

```text
metrics    # default: Telegram campaign numbers only, no LLM/tool loop
review     # one strategist review + experiment generation
autonomous # full tool-using agent cycle, highest token usage
```

Hypotheses:

```bash
npm run cli -- hypotheses
npm run cli -- eval-hypotheses
```

## CLI Reference

Run:

```bash
npm run cli
```

Current commands include:

```text
init
import-leads
add-lead
create-campaign
list-campaigns
activate-campaign
enroll
dispatch
process-events
daily-cycle
weekly-review
monthly-review
gen-variants
list-variants
prune-variants
make-pixel
create-video
video-script
produce-video
chat
agent-cycle
discover-leads
discover-businesses
discover-contractors
crm
crm-export
verify-email
source-leads
source-leads-apify
research
approvals
approve
deny
ingest-reply
poll-replies
hypotheses
eval-hypotheses
event
status
lead
```

## Deployment

Railway/Render/VPS shape:

```bash
npm install
npm start
```

Set all production environment variables in the host dashboard, not in Git.

For Railway:

- Add `MONGODB_URI`, LLM keys, SMTP/mailbox settings, Telegram settings, search keys, and tracking URL as Variables.
- Set `TRACKING_BASE_URL` to the Railway public URL.
- Keep only one running Telegram poller for a bot token. If local and Railway both run, one can consume updates before the other.
- Do not commit `.env`.

If video rendering on the server:

- Ensure the `remotion/` dependencies are installed during deployment.
- Ensure Chrome/Chromium is available or set `VIDEO_CHROME_PATH`.
- Add persistent video hosting or object storage for production.

## Deliverability Checklist

- Use separate cold-outbound domains, not your primary company domain.
- Set SPF, DKIM, and DMARC for every sending domain.
- Warm up new inboxes slowly.
- Keep per-inbox volume low at first.
- Use real Google/Microsoft/Zoho-style mailboxes when deliverability matters.
- Keep unsubscribe footer and physical address enabled.
- Monitor bounces and replies daily.
- Do not blast raw scraped lists without cleanup.
- Avoid spammy copy, fake personalization, and misleading claims.

## Data And Security Notes

- `.env` is git-ignored and must stay local/private.
- Raw lead lists can contain personal data. Be careful before committing `data/`.
- The system stores leads, messages, events, approvals, hypotheses, and videos in MongoDB.
- Approval records are persisted, so `/pending` works across restarts.
- Chat history for the Telegram agent is in-memory and resets on restart.
