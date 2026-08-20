import "dotenv/config";

/** Read a required string env var, throwing a clear error if missing. */
function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return v.trim();
}

/** Read an optional string env var with a fallback. */
function opt(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export const config = {
  mongo: {
    uri: req("MONGODB_URI"),
    db: opt("MONGODB_DB", "email_db"),
  },
  llm: {
    worker: {
      auth: (opt("WORKER_AUTH", "api-key") as "api-key" | "openai-oauth" | "openai-oauth-proxy"),
      baseURL: opt("WORKER_BASE_URL", "https://api.openai.com/v1"),
      apiKey: opt("WORKER_API_KEY"),
      model: opt("WORKER_MODEL", "gpt-5.4-mini"),
      oauthFile: opt("WORKER_OAUTH_FILE") || opt("OPENAI_OAUTH_FILE"),
      disableOfficialOpenAI: bool("OPENAI_API_DISABLED", false),
    },
    strategist: {
      auth: (opt("STRATEGIST_AUTH", "api-key") as "api-key" | "openai-oauth" | "openai-oauth-proxy"),
      baseURL: opt("STRATEGIST_BASE_URL", "https://api.z.ai/api/paas/v4"),
      apiKey: opt("STRATEGIST_API_KEY"),
      model: opt("STRATEGIST_MODEL", "glm-5.2"),
      oauthFile: opt("STRATEGIST_OAUTH_FILE") || opt("OPENAI_OAUTH_FILE"),
      disableOfficialOpenAI: bool("OPENAI_API_DISABLED", false),
    },
  },
  oauthProxy: {
    enabled: bool("OPENAI_OAUTH_PROXY_ENABLED", false),
    host: opt("OPENAI_OAUTH_PROXY_HOST", "127.0.0.1"),
    port: num("OPENAI_OAUTH_PROXY_PORT", 10531),
    authFile: opt("OPENAI_OAUTH_FILE", "/app/data/openai-oauth/auth.json"),
    authJsonBase64: opt("OPENAI_OAUTH_AUTH_JSON_BASE64"),
    authSeedVersion: opt("OPENAI_OAUTH_AUTH_SEED_VERSION"),
  },
  smtp: {
    host: opt("SMTP_HOST", "smtp.gmail.com"),
    port: num("SMTP_PORT", 465),
    secure: bool("SMTP_SECURE", true),
    user: opt("SMTP_USER"),
    pass: opt("SMTP_PASS"),
  },
  emailTransport: opt("EMAIL_TRANSPORT", "smtp").toLowerCase(),
  microsoft: {
    tenantId: opt("MICROSOFT_TENANT_ID"),
    clientId: opt("MICROSOFT_CLIENT_ID"),
    clientSecret: opt("MICROSOFT_CLIENT_SECRET"),
  },
  mail: {
    fromName: opt("FROM_NAME", "Sales"),
    fromEmail: opt("FROM_EMAIL", "sales@example.com"),
    replyTo: opt("REPLY_TO_EMAIL") || opt("FROM_EMAIL", "sales@example.com"),
  },
  sending: {
    dailyLimit: num("DAILY_SEND_LIMIT", 40),
    maxPerRun: num("MAX_SENDS_PER_RUN", 20),
    minSecondsBetweenSends: num("MIN_SECONDS_BETWEEN_SENDS", 45),
    dryRun: bool("DRY_RUN", true),
    windowStartHour: num("SEND_WINDOW_START_HOUR", 8),
    windowEndHour: num("SEND_WINDOW_END_HOUR", 17),
    sendOnWeekends: bool("SEND_ON_WEEKENDS", false),
    // Hard cap on sends per day to any single recipient domain (protects a
    // target company's mail server / reputation with them). <=0 disables it.
    maxPerRecipientDomainPerDay: num("MAX_SENDS_PER_RECIPIENT_DOMAIN_PER_DAY", 30),
  },
  mailboxes: {
    // Pool of sending mailboxes for rotation. JSON array (or a file path) of:
    //   { "email","fromName"?,"replyTo"?,"host"?,"port"?,"secure"?,"user"?,"pass"?,"dailyCap"?,"warmup"? }
    // Empty → a single mailbox synthesized from smtp/mail above (back-compatible).
    roster: opt("MAILBOXES"),
    rosterFile: opt("MAILBOXES_FILE"),
    // Ceiling per mailbox once fully warmed (per-mailbox "dailyCap" overrides this).
    defaultDailyCap: num("MAILBOX_DAILY_CAP", num("DAILY_SEND_LIMIT", 40)),
    // Warmup ramp: start low and add `incrementPerDay` each day since a mailbox's
    // first send, until it reaches the mailbox cap (never exceeding maxPerDay).
    warmup: {
      enabled: bool("WARMUP_ENABLED", true),
      startPerDay: num("WARMUP_START_PER_DAY", 5),
      incrementPerDay: num("WARMUP_INCREMENT_PER_DAY", 5),
      maxPerDay: num("WARMUP_MAX_PER_DAY", 40),
    },
  },
  tracking: {
    baseURL: opt("TRACKING_BASE_URL", "http://localhost:8787").replace(/\/$/, ""),
    // Railway and similar hosts inject PORT. Prefer it so health checks hit the
    // listener they expect, while TRACKING_PORT still works for local dev.
    port: num("PORT", num("TRACKING_PORT", 8787)),
    replyWebhookSecret: opt("REPLY_WEBHOOK_SECRET", "change-me"),
  },
  imap: {
    // Poll sending mailboxes over IMAP to auto-capture replies (self-hosted SMTP).
    // Off by default — only needed if you don't have a provider POSTing /webhook/reply.
    enabled: bool("IMAP_ENABLED", false),
    // Default IMAP host/port for every mailbox (per-mailbox "imapHost" overrides).
    host: opt("IMAP_HOST", "imap.gmail.com"),
    port: num("IMAP_PORT", 993),
    secure: bool("IMAP_SECURE", true),
    // On a mailbox's first poll, only ingest mail from the last N days.
    lookbackDays: num("IMAP_LOOKBACK_DAYS", 14),
  },
  notify: {
    webhookURL: opt("NOTIFY_WEBHOOK_URL"),
    email: opt("NOTIFY_EMAIL"),
  },
  booking: {
    // Public scheduling link (Calendly/Cal.com). When set, the writer model can
    // close with it, reply drafts include it, and templates get a {{bookingUrl}}
    // merge field. Clicks are tracked like any other link.
    url: opt("BOOKING_URL"),
    // The meeting length every ask references (emails, video scripts, CTA).
    // MUST match your actual Calendly event length — asking for 5 and booking
    // 15 erodes trust before the call starts.
    meetingMinutes: num("MEETING_LENGTH_MIN", 15),
    // CTA button text on videos; empty → "Book a <N>-min demo".
    ctaLabel: opt("BOOKING_CTA_LABEL"),
  },
  calendly: {
    // Personal Access Token (Calendly → Integrations → API & webhooks). Powers
    // the meeting-lifecycle worker: booked-meeting backfill (webhook optional),
    // pre-meeting reminder emails, and no-show recovery drafts.
    apiToken: opt("CALENDLY_API_TOKEN"),
    // Auto-send a reminder email ~24h before each meeting (transactional-style,
    // to someone who booked — not cold outreach). Respects DRY_RUN.
    remindersEnabled: bool("MEETING_REMINDERS", true),
  },
  website: {
    // GitHub access to your marketing site so the agent can read the landing
    // page and PROPOSE copy changes as pull requests (never merges).
    githubToken: opt("GITHUB_TOKEN"),
    repo: opt("WEBSITE_REPO"), // "owner/name"
    branch: opt("WEBSITE_BRANCH"), // default branch auto-detected when empty
  },
  codeRepo: {
    // Optional self-improvement lane. When set, the agent can inspect this code
    // repo and propose multi-file pull requests, but never merges or deploys.
    repo: opt("AGENT_CODE_REPO"),
    branch: opt("AGENT_CODE_BRANCH"),
  },
  compliance: {
    companyName: opt("COMPANY_NAME", "Your Company"),
    companyAddress: opt("COMPANY_ADDRESS", ""),
    unsubscribeFooter: bool("UNSUBSCRIBE_FOOTER", true),
    // Reputation guard: pause ALL sending if the recent bounce rate (over
    // bounceWindowHours, once ≥ minSample sends) reaches this percentage.
    bouncePauseThresholdPct: num("BOUNCE_PAUSE_THRESHOLD_PCT", 8),
    bouncePauseMinSample: num("BOUNCE_PAUSE_MIN_SAMPLE", 20),
    bounceWindowHours: num("BOUNCE_WINDOW_HOURS", 24),
  },
  agent: {
    // "metrics" = cheapest daily Telegram numbers only; "review" = one
    // strategist review; "autonomous" = full tool-using agent loop.
    dailyMode: (opt("AGENT_DAILY_MODE", "metrics") as "metrics" | "review" | "autonomous"),
    // "semi" = low-risk auto, high-risk needs approval; "propose" = approve all;
    // "full" = act within hard caps. See src/agent/autonomy.ts.
    autonomy: (opt("AGENT_AUTONOMY", "semi") as "semi" | "propose" | "full"),
    maxSteps: num("AGENT_MAX_STEPS", 12),
    // Scheduled cycles normally cannot inspect or change their own code. Opt in
    // to let the brain prepare approval-gated PRs when a missing capability is
    // blocking growth; it still cannot merge or deploy them.
    autonomousCode: bool("AGENT_AUTONOMOUS_CODE", false),
    // Hard ceiling on paid lead-sourcing per agent action, regardless of autonomy.
    maxLeadsPerSource: num("AGENT_MAX_LEADS_PER_SOURCE", 25),
    // Hard ceilings the agent's set_send_pace tool can never exceed, however it
    // is configured (see services/send-pace.service.ts). Real sends are still
    // further bounded by per-mailbox warmup caps and maxPerRecipientDomainPerDay,
    // neither of which the agent can touch at all.
    maxPerRunCeiling: num("AGENT_MAX_PER_RUN_CEILING", 50),
    dailySendCeiling: num("AGENT_DAILY_SEND_CEILING", 200),
    // Hard daily cap on auto_enroll (enrollments/day across ALL sources) so the
    // agent can keep the funnel fed without a human, but never floods it.
    autoEnrollPerDay: num("AGENT_AUTO_ENROLL_PER_DAY", 200),
    // Hard daily cap on leads imported by FREE discovery (discover_leads etc.).
    // Free sourcing is low-risk (no money spent, sends are capped separately),
    // but this stops a runaway loop from stuffing the DB.
    autoDiscoverPerDay: num("AGENT_AUTO_DISCOVER_PER_DAY", 50),
  },
  telegram: {
    botToken: opt("TELEGRAM_BOT_TOKEN"),
    chatId: opt("TELEGRAM_CHAT_ID"),
    allowedUserIds: opt("TELEGRAM_ALLOWED_USER_IDS"),
    allowedChatIds: opt("TELEGRAM_ALLOWED_CHAT_IDS"),
  },
  search: {
    // "duckduckgo" (free, no key, default) | "searxng" (self-hosted) |
    // "serper" | "tavily" (paid APIs).
    provider: opt("SEARCH_PROVIDER", "duckduckgo"),
    apiKey: opt("SEARCH_API_KEY"),
    searxngUrl: opt("SEARXNG_URL"),
  },
  apollo: {
    apiKey: opt("APOLLO_API_KEY"),
  },
  apify: {
    apiToken: opt("APIFY_API_TOKEN"),
    actorId: opt("APIFY_LEADS_ACTOR_ID", "peakydev/leads-scraper-ppe"),
    maxResultsPerRun: num("APIFY_MAX_RESULTS_PER_RUN", 30000),
    maxCostPerRunUsd: num("APIFY_MAX_COST_PER_RUN_USD", 30),
    pollSeconds: num("APIFY_POLL_SECONDS", 10),
  },
  discovery: {
    // SMTP-probe verification: best-effort (many ISPs block port 25 outbound).
    smtpProbe: bool("DISCOVERY_SMTP_PROBE", true),
    // Import emails we could only guess (couldn't SMTP-verify). Bounces auto-stop them.
    importGuessed: bool("DISCOVERY_IMPORT_GUESSED", true),
  },
  gemini: {
    apiKey: opt("GEMINI_API_KEY"),
    ttsModel: opt("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts"),
    ttsVoice: opt("GEMINI_TTS_VOICE", "Achird"),
    // On a 429/overload, wait the server-suggested delay and retry this many
    // times. Clears the free tier's 3 req/min limit; the 15 req/day limit
    // can't be waited out (resets at midnight PT) → enable billing for volume.
    ttsMaxRetries: num("GEMINI_TTS_MAX_RETRIES", 4),
  },
  tts: {
    // Voice replies in Telegram. "kokoro" = free, local, CPU-only (no API key,
    // no system binary beyond ffmpeg); "off" hides the 🔊 button entirely.
    // Unrelated to gemini.* above, which is only used for video voiceover.
    provider: opt("TTS_PROVIDER", "kokoro"),
    model: opt("TTS_MODEL", "onnx-community/Kokoro-82M-v1.0-ONNX"),
    // Voice id from the Kokoro set (af_*/am_* US, bf_*/bm_* UK).
    voice: opt("TTS_VOICE", "af_heart"),
    // q8 keeps the weights ~90MB and RSS under ~500MB. fp32 sounds marginally
    // better and roughly triples both — not worth it on a small container.
    dtype: opt("TTS_DTYPE", "q8"),
    // Synthesis runs about 1.5x realtime on a shared vCPU, so cap input length:
    // this bounds one tap to well under a minute of compute.
    maxChars: num("TTS_MAX_CHARS", 900),
  },
  voice: {
    // Master switch for the outbound calling channel. Off → the dialer never
    // runs, the media bridge refuses connections, and the agent's call tools
    // report the channel as disabled.
    enabled: bool("VOICE_ENABLED", false),
    // "twilio" places real calls; "dry-run" logs what it would dial (and is
    // forced whenever DRY_RUN=true, exactly like the email sender).
    provider: opt("VOICE_PROVIDER", "twilio").toLowerCase(),
    // How the agent introduces itself. Used in the opener and the voicemail.
    agentName: opt("VOICE_AGENT_NAME", "Alex"),
    // Sales rep whose calendar/inbox the meeting lands on (used in confirmations).
    repName: opt("VOICE_REP_NAME") || opt("FROM_NAME", "Sales"),
    twilio: {
      // Account identifier ("AC…"). Always required — it is in every API path,
      // even when authenticating with a scoped API key.
      accountSid: opt("TWILIO_ACCOUNT_SID"),
      // Master password. Needed for REST calls when no API key is set, AND —
      // separately — to verify inbound webhook signatures, which Twilio always
      // signs with the account auth token, never with an API key secret.
      authToken: opt("TWILIO_AUTH_TOKEN"),
      // Optional scoped credential ("SK…" + its secret). Preferred for REST:
      // revocable on its own without rotating the account token.
      apiKeySid: opt("TWILIO_API_KEY_SID"),
      apiKeySecret: opt("TWILIO_API_KEY_SECRET"),
      // Verified caller ID to dial from (E.164).
      fromNumber: opt("TWILIO_FROM_NUMBER"),
      // Reject webhook posts that aren't signed by Twilio. Keep ON in production:
      // the media-stream URL is public, and an unsigned POST can start a call leg.
      validateSignature: bool("TWILIO_VALIDATE_SIGNATURE", true),
    },
    realtime: {
      // Speech-to-speech model endpoint (OpenAI Realtime or any wire-compatible
      // host). The bridge speaks G.711 μ-law both ways so no transcoding is
      // needed between the carrier and the model.
      //
      // This role — and ONLY this role — requires OpenAI. The worker and
      // strategist keep their own routing (OAuth harness, z.ai, whatever), so
      // metered OpenAI spend is confined to live calls.
      baseURL: opt("VOICE_REALTIME_URL", "wss://api.openai.com/v1/realtime"),
      model: opt("VOICE_REALTIME_MODEL", "gpt-realtime-2"),
      // "api-key" = a platform key (predictable, metered per audio minute).
      // "openai-oauth" = a ChatGPT/Codex token, billed against a subscription.
      // The OAuth token EXPIRES and must refresh; see services/voice/realtime-auth.ts
      // and check `voice-preflight` for the remaining runway before relying on it.
      auth: (opt("VOICE_REALTIME_AUTH", "api-key") as "api-key" | "openai-oauth"),
      // Credentials file for auth="openai-oauth". Defaults to ~/.codex/auth.json.
      oauthFile: opt("VOICE_REALTIME_OAUTH_FILE") || opt("WORKER_OAUTH_FILE") || opt("OPENAI_OAUTH_FILE"),
      // Falls back to the worker key ONLY when the worker is itself OpenAI;
      // realtimeReadiness() warns when that fallback can't work.
      apiKey: opt("VOICE_REALTIME_API_KEY") || opt("WORKER_API_KEY"),
      voice: opt("VOICE_REALTIME_VOICE", "marin"),
      // "ga" = current session schema (audio.input/audio.output); "beta" = the
      // older realtime=v1 shape. Inbound events are accepted in both shapes.
      schema: (opt("VOICE_REALTIME_SCHEMA", "ga") as "ga" | "beta"),
      // Model that transcribes the PROSPECT's audio for the transcript/analysis.
      transcriptionModel: opt("VOICE_TRANSCRIPTION_MODEL", "gpt-realtime-whisper"),
      // ── Turn-taking (server VAD) ──────────────────────────────────────────
      // These three decide whether the agent feels like a person or a walkie-
      // talkie, and they are tuned for a PHONE call, not a headset.
      //
      // threshold      how loud counts as speech (0–1). Higher ignores more
      //                background noise but misses a soft-spoken prospect.
      // prefixPadding  audio kept from BEFORE the trigger, so the first
      //                syllable isn't clipped off the transcript.
      // silenceMs      how long they must stop before the agent takes its turn.
      //                Short = responsive; too short = it interrupts a pause.
      // "semantic" lets the MODEL judge whether they have finished a thought —
      // it waits through "well… I mean…" but answers instantly on a clear stop.
      // "server_vad" is the raw silence timer below. Semantic is the better fit
      // for a phone conversation; server_vad is predictable and free of a
      // classifier's judgment calls.
      turnDetection: (opt("VOICE_TURN_DETECTION", "semantic") as "semantic" | "server_vad"),
      // low = let them ramble, auto = balanced, high = jump in fast.
      semanticEagerness: opt("VOICE_SEMANTIC_EAGERNESS", "high"),
      vadThreshold: num("VOICE_VAD_THRESHOLD", 0.23),
      prefixPaddingMs: num("VOICE_PREFIX_PADDING_MS", 180),
      silenceMs: num("VOICE_SILENCE_MS", 50),
      // Input denoising profile. "far_field" suits a prospect on speakerphone,
      // in a truck, or on a job site; "near_field" suits a handset held to the
      // ear; "none" disables it.
      noiseReduction: opt("VOICE_NOISE_REDUCTION", "far_field").toLowerCase(),
      // Cap on one spoken turn. 0 = uncapped ("inf"). The brevity rules in the
      // call script do the real work here; this is just a backstop against a
      // runaway monologue burning metered audio.
      maxOutputTokens: num("VOICE_MAX_OUTPUT_TOKENS", 0),
    },
    // Outbound audio treatment. Changes timbre only — pacing and turn-taking
    // are prompt/VAD concerns. See services/voice/audio-filter.ts.
    humanize: {
      enabled: bool("VOICE_HUMANIZE", false),
      // Noise floor that replaces mathematically dead silence. -55 is a quiet
      // room; -45 is a busy office. Below -70 is inaudible.
      comfortNoiseDb: num("VOICE_COMFORT_NOISE_DB", -58),
      // Drive into a soft limiter, in dB. Adds phone-line presence. Above ~6
      // starts to sound squashed on narrowband audio.
      driveDb: num("VOICE_DRIVE_DB", 0),
      // Gentle consonant/presence lift for clearer handset audio. 0 disables.
      clarityDb: num("VOICE_CLARITY_DB", 1.5),
      // Drop some low-energy frames after the first few dozen ms of silence.
      // This tightens punctuation gaps without speeding up voiced syllables.
      compressPauses: bool("VOICE_COMPRESS_PAUSES", true),
      pauseKeepMs: num("VOICE_PAUSE_KEEP_MS", 80),
      pauseThresholdDb: num("VOICE_PAUSE_THRESHOLD_DB", -48),
      // Speed up only the first few hundred ms of the first agent utterance.
      // Used for the "Hello" lead-in without making the whole call rushed.
      fastStart: bool("VOICE_FAST_START", true),
      fastStartMs: num("VOICE_FAST_START_MS", 260),
      fastStartRate: num("VOICE_FAST_START_RATE", 1.3),
    },
    // Warm-transfer target for "put me through to a human". Empty → the tool
    // reports itself unavailable instead of pretending to transfer.
    transferNumber: opt("VOICE_TRANSFER_NUMBER"),
    // Ask Twilio to record calls. Recording laws are two-party-consent in many
    // states/countries — leaving this on adds a spoken disclosure to the opener.
    record: bool("VOICE_RECORD", false),
    dialing: {
      // Local-to-the-prospect calling window (their timezone when the lead has
      // one, otherwise the server's). US telemarketing rules are 8am–9pm local;
      // the default is deliberately tighter than the legal maximum.
      windowStartHour: num("VOICE_WINDOW_START_HOUR", 9),
      windowEndHour: num("VOICE_WINDOW_END_HOUR", 17),
      callOnWeekends: bool("VOICE_CALL_ON_WEEKENDS", false),
      // Hard ceilings. Concurrency bounds simultaneous carrier legs (each one
      // costs a realtime session); the daily cap bounds spend and reputation.
      maxConcurrent: num("VOICE_MAX_CONCURRENT", 2),
      dailyLimit: num("VOICE_DAILY_CALL_LIMIT", 50),
      // Attempts per lead before the number is retired from the dialer.
      maxAttempts: num("VOICE_MAX_ATTEMPTS", 3),
      // Hours to wait before retrying a no-answer (jittered across the window).
      retryHours: num("VOICE_RETRY_HOURS", 24),
      // Hard hangup. Bounds the worst case: a stuck session burning realtime
      // minutes on an open line. A real cold call that works closes well inside this.
      maxCallSeconds: num("VOICE_MAX_CALL_SECONDS", 300),
    },
    close: {
      // How many times the agent may ask for the meeting before it must accept
      // "no" and fall back to email. Real objection handling needs more than one
      // ask; more than ~3 is harassment and burns the brand.
      maxAsks: num("VOICE_MAX_ASKS", 3),
      // Length of meeting the agent asks for (defaults to the email CTA's).
      meetingMinutes: num("VOICE_MEETING_MINUTES", num("MEETING_LENGTH_MIN", 15)),
    },
    // Say "I'm an AI assistant" in the opener, unprompted. Independent of this,
    // the agent ALWAYS admits it when asked — that rule is not configurable.
    discloseAiUpfront: bool("VOICE_DISCLOSE_AI_UPFRONT", true),
  },
  video: {
    outputDir: opt("VIDEO_OUTPUT_DIR", "data/videos"),
    // Days to keep rendered videos before the nightly prune removes them. These
    // files are streamed by prospects from the tracking server, so this window
    // must outlast how long a cold lead takes to open the email. 0 = keep forever.
    retentionDays: num("VIDEO_RETENTION_DAYS", 30),
    enableRemotion: bool("VIDEO_ENABLE_REMOTION", false),
    captureWebsite: bool("VIDEO_CAPTURE_WEBSITE", true),
    chromePath: opt("VIDEO_CHROME_PATH"),
    // Remotion render concurrency. Caps parallel Chrome tabs = caps peak RAM.
    // Keep low (1–2) on memory-limited hosts like Railway; 0 = let Remotion decide.
    renderConcurrency: num("VIDEO_RENDER_CONCURRENCY", 0),
  },
} as const;

export type AppConfig = typeof config;
