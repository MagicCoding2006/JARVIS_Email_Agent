# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

An **autonomous-but-controlled AI SDR/BDR system**. It manages leads, runs
multi-touch cold-email campaigns, personalizes every email with an LLM, tracks
engagement, scores leads, books meetings, generates video outreach, notifies a
human on hot signals, and **learns from results** via daily/weekly/monthly
strategist reviews that auto-generate and A/B-test new email variants.

Node 20 + TypeScript (ESM, run via `tsx`) + MongoDB Atlas (`email_db`).

## The "OpenClaw" orchestration model

Per the master plan, an orchestrator handles workflows/memory/tools/scheduling/
automation and does **no model inference** — all intelligence comes from the LLM
APIs. **This codebase IS that orchestrator.** The split:

- **Orchestrator (this repo):** scheduler/cron (`workers/scheduler.ts`), batch
  workers, repositories, tracking server, sender. Deterministic glue.
- **Worker LLM (`gpt-5.4-mini`):** high-volume writing — personalization, reply
  classification, subject lines, variant generation. `llm/roles.ts → worker`.
- **Strategist LLM (`glm-5.2`, Z.AI):** low-frequency strategy — daily/weekly/
  monthly reviews, hypotheses, experiment planning. `llm/roles.ts → strategist`.

Cost control is a hard rule: **never call a model per event.** Events are
batch-processed on a schedule; the strategist runs ≤ once/day.

### The agent (GLM as an operator with tools)

The strategist isn't just a reviewer — it's an **agent** with tools (`src/agent/`).
It can read metrics, manage campaigns, generate/prune A/B variants, research
leads (web search), and source leads (Apollo). The loop is in `agent/agent.ts`;
tools are in `agent/tools/`. You talk to it over **Telegram** (`src/chat/`).

**Autonomy** (`AGENT_AUTONOMY`, enforced in `agent/autonomy.ts`):
- `semi` (default) — low-risk tools run automatically; **high-risk** tools
  (create/launch/pause campaign, change offer, enroll, source paid leads) are
  queued as an **Approval** and pinged to Telegram with ✅/❌ buttons.
- `propose` — everything needs approval. `full` — acts within hard caps.

High-risk actions never execute inline; they persist to the `approvals`
collection and only run via `agent/approvals.ts → executeApproval` after you tap
Approve. Hard caps (send limits, `AGENT_MAX_LEADS_PER_SOURCE`, `DRY_RUN`) bind
regardless of autonomy.

## Commands

```bash
npm install
npm run typecheck                 # tsc --noEmit (run after any change)
npm start                         # tracking server + all cron jobs
npm run tracking-server           # just the Express tracking server
npm run cli <command> [flags]     # operator CLI (see `npm run cli` for full list)

# pure-logic smoke test (no DB/network):
MONGODB_URI=mongodb://dummy TRACKING_BASE_URL=http://localhost:8787 npx tsx scripts/smoke.ts
```

Key CLI verbs: `import-leads`, `create-campaign`, `enroll`, `dispatch`,
`process-events`, `daily-cycle`, `weekly-review`, `monthly-review`,
`gen-variants`, `list-variants`, `make-pixel`, `video-script`, `produce-video`,
`chat`, `agent-cycle`, `discover-leads`, `discover-businesses`,
`discover-contractors`, `verify-email`, `source-leads`, `research`,
`crm`, `crm-export`, `approvals`, `approve`/`deny`, `ingest-reply`,
`event`, `status`, `lead`.

Chat with the brain from the terminal: `npm run cli chat --text "how are we doing?"`.
Run the autonomous daily brain on demand: `npm run cli agent-cycle`.

## Architecture (where things live)

```
src/
  config/        env loading/validation (config.* is the single source)
  lib/           logger, mongo connection, ids, business-day time math
  models/        all domain types (one file: types.ts)
  repositories/  Mongo data access — collections.ts (typed + indexes) + index.ts (repos)
  llm/           provider (OpenAI-compatible adapter + tool-calling), roles, prompts
  agent/         the GLM brain: agent.ts (loop), autonomy.ts, approvals.ts, tools/
  chat/          Telegram client + two-way bot (long-poll, inline approvals)
  services/      business logic:
                   personalization, sequencer, tracking, scoring, replies,
                   notifications, reporting, analytics, variants (bandit),
                   booking, compose (Gmail pixel), search, apollo, research,
                   video.service + video/ (gemini-tts, scene-spec, remotion), sender/
  workers/       scheduled jobs: dispatcher, event-processor, autonomous-cycle,
                   daily/weekly/monthly, scheduler
  server/        tracking-server.ts (pixel, click, unsub, reply/booking webhooks, video, createPixel)
  cli/           operator CLI
remotion/        separate Remotion project (install only if rendering video)
```

Full layer-by-layer status and the data model are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Core control flow

1. `enroll` → `sequencer.scheduleNextStep` drafts step 1 (worker LLM, optionally
   a selected A/B variant), renders tracked HTML/text, schedules a `Message`.
2. `dispatcher` (cron /5m) sends due messages within the window + caps, records
   `sent`, advances the enrollment, schedules the next step.
3. Prospect opens/clicks/replies/books → the **tracking server** writes `events`.
4. `event-processor` (cron /10m) scores events, rolls stats into A/B `variants`,
   escalates hot leads, and stops the sequence on reply/unsubscribe/bounce/booked.
5. Daily brain (08:30): if GLM is configured, `autonomous-cycle` runs the agent
   (reviews + acts via tools; high-risk → approvals); otherwise the deterministic
   `daily-cycle` runs. `weekly-review` prunes losers + breakdowns. `monthly-review`
   summarizes outcomes. You can also drive everything live by chatting on Telegram.

## Conventions

- **Document `_id` is a UUID string** (matches the original pixel app). Use `uuid()`.
- All timestamps are native `Date`.
- New collection? Add it in `repositories/collections.ts` (typed + index) and a
  repo in `repositories/index.ts`. Don't access `getDb()` from services directly.
- New LLM call? Add a prompt builder in `llm/prompts.ts`, call via `worker`/
  `strategist`, and always have a non-LLM fallback (see `personalization.service`).
- Email sending goes through the `EmailSender` interface — never call nodemailer
  from business logic. Add providers in `services/sender/`.
- Respect `config.sending.dryRun`; the dispatcher and DryRunSender already do.
- **New agent tool?** Add a `Tool` in `agent/tools/*.tools.ts`, register it in
  `agent/tools/index.ts`, and set `risk` honestly (`high` if it spends money,
  sends, or changes live campaigns). The autonomy/approval gating is automatic.
- External/paid integrations (Apollo, search, Gemini) live in `services/` and
  must **no-op or throw clearly when their key is missing** — never assume a key.

## Lead sourcing (free vs paid)

- **Free, default path**: `discover_leads` / CLI `discover-leads` — web search →
  LLM extracts people → derive company domain → `lib/email-verify.ts` generates
  email patterns + MX/SMTP-verifies → import deliverable leads. No Apollo needed.
- **Contractor/business sourcing**: `discover-businesses` and `discover-contractors`
  (`services/business-discovery.service.ts`) — SERP queries → crawl official
  contractor websites (contact/about/team/service pages) → extract emails via
  `mailto:` hrefs (highest confidence), JSON-LD structured data, and full-text
  regex → MX/SMTP verify → import. The `discover-contractors` command is a
  pre-tuned wrapper for trades (HVAC, roofing, plumbing, electrical, etc.) that
  adds "owner operated local" qualifier terms and uses trade as the industry tag.
- **Search backends** (`services/search.service.ts`, `SEARCH_PROVIDER`):
  `duckduckgo` (free, no key, but rate-limits under bursts — fine for light use),
  `searxng` (free, self-hosted, **recommended** for discovery's multi-query load),
  `serper`/`tavily` (paid, most reliable).
- We do **not** scrape Apollo's gated app (ToS + anti-bot). The `source_leads_apollo`
  tool only works with a real Apollo API key; otherwise use `discover_leads`.
- SMTP verification uses port 25, which many ISPs block → emails come back
  "guessed"; those import only if `DISCOVERY_IMPORT_GUESSED=true` and bounces
  auto-stop bad ones.

## CRM view and export

Leads are the CRM — stored in MongoDB with status, score, and a full event log.
The CRM service (`services/crm.service.ts`) joins leads with their lifetime email
stats (sent, opens, clicks, replies, meetings) in one aggregation:

- `npm run cli crm [--status active|replied|meeting]` — ASCII table view of all
  leads with engagement stats; filter by status with `--status`.
- `npm run cli crm-export [--file leads.csv]` — export everything to CSV
  (default `crm-export.csv`), openable in Excel / Google Sheets.

The CRM auto-updates as emails flow: the dispatcher marks leads `active` on first
send; the event-processor transitions them to `replied`, `meeting`, `won`, `lost`,
`bounced`, or `unsubscribed` as signals come in. Scores accumulate per event and
the CRM table shows the running total.

## Gotchas / guardrails

- **Secrets:** real creds live only in `.env` (git-ignored). The old Atlas
  password was leaked in the public `Pixel-Injectable` repo — it must stay
  rotated. Do not put real secrets in `.env.example`.
- **Opens need a public tracking URL.** `TRACKING_BASE_URL` must be reachable by
  prospects (deploy the tracking server or reuse the Cloud Run host).
- **Deliverability:** SPF/DKIM/DMARC + inbox warmup (Instantly) before volume.
  Keep `DAILY_SEND_LIMIT` low at first. Sequences auto-stop on opt-out/bounce.
- Default to the latest Claude models if you ever add a third LLM role.
