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
      baseURL: opt("WORKER_BASE_URL", "https://api.openai.com/v1"),
      apiKey: opt("WORKER_API_KEY"),
      model: opt("WORKER_MODEL", "gpt-5.4-mini"),
    },
    strategist: {
      baseURL: opt("STRATEGIST_BASE_URL", "https://api.z.ai/api/paas/v4"),
      apiKey: opt("STRATEGIST_API_KEY"),
      model: opt("STRATEGIST_MODEL", "glm-5.2"),
    },
  },
  smtp: {
    host: opt("SMTP_HOST", "smtp.gmail.com"),
    port: num("SMTP_PORT", 465),
    secure: bool("SMTP_SECURE", true),
    user: opt("SMTP_USER"),
    pass: opt("SMTP_PASS"),
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
  },
  tracking: {
    baseURL: opt("TRACKING_BASE_URL", "http://localhost:8787").replace(/\/$/, ""),
    port: num("TRACKING_PORT", 8787),
    replyWebhookSecret: opt("REPLY_WEBHOOK_SECRET", "change-me"),
  },
  notify: {
    webhookURL: opt("NOTIFY_WEBHOOK_URL"),
    email: opt("NOTIFY_EMAIL"),
  },
  compliance: {
    companyName: opt("COMPANY_NAME", "Your Company"),
    companyAddress: opt("COMPANY_ADDRESS", ""),
    unsubscribeFooter: bool("UNSUBSCRIBE_FOOTER", true),
  },
  agent: {
    // "semi" = low-risk auto, high-risk needs approval; "propose" = approve all;
    // "full" = act within hard caps. See src/agent/autonomy.ts.
    autonomy: (opt("AGENT_AUTONOMY", "semi") as "semi" | "propose" | "full"),
    maxSteps: num("AGENT_MAX_STEPS", 8),
    // Hard ceiling on paid lead-sourcing per agent action, regardless of autonomy.
    maxLeadsPerSource: num("AGENT_MAX_LEADS_PER_SOURCE", 25),
  },
  telegram: {
    botToken: opt("TELEGRAM_BOT_TOKEN"),
    chatId: opt("TELEGRAM_CHAT_ID"),
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
    ttsVoice: opt("GEMINI_TTS_VOICE", "Kore"),
  },
  video: {
    outputDir: opt("VIDEO_OUTPUT_DIR", "data/videos"),
    enableRemotion: bool("VIDEO_ENABLE_REMOTION", false),
  },
} as const;

export type AppConfig = typeof config;
