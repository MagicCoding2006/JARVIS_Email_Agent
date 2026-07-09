import cron from "node-cron";
import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { strategist } from "../llm/roles.js";
import { dispatchDue } from "./dispatcher.js";
import { processEvents } from "./event-processor.js";
import { runDailyCycle } from "./daily-cycle.js";
import { runAutonomousCycle } from "./autonomous-cycle.js";
import { runWeeklyReview } from "./weekly-review.js";
import { runMonthlyReview } from "./monthly-review.js";
import { processReplyDrafts } from "./reply-drafts.js";
import { runHumanDigest } from "./human-digest.js";
import { syncMeetings } from "./meeting-lifecycle.js";
import { calendlyEnabled } from "../services/calendly.service.js";
import { imapEnabled, pollReplies } from "../services/imap-poller.service.js";

const log = createLogger("scheduler");
let dispatchRunning = false;

/** Wire up the recurring jobs. Returns the scheduled tasks for shutdown. */
export function startScheduler(): cron.ScheduledTask[] {
  const tasks: cron.ScheduledTask[] = [];

  // Send due messages frequently; the dispatcher self-limits to the window + caps.
  tasks.push(
    cron.schedule("*/5 * * * *", async () => {
      if (dispatchRunning) {
        log.warn("dispatch job still running — skipping overlapping run");
        return;
      }
      dispatchRunning = true;
      try {
        await dispatchDue();
      } catch (err) {
        log.error("dispatch job failed", err);
      } finally {
        dispatchRunning = false;
      }
    }),
  );

  // Batch-process tracking events (scoring + escalation) — NOT on every event.
  tasks.push(
    cron.schedule("*/10 * * * *", () => {
      processEvents().catch((err) => log.error("event job failed", err));
    }),
  );

  // Draft responses to fresh positive replies (worker LLM, batch). A hot reply
  // gets a one-tap-approve draft in Telegram within ~15 minutes; costs nothing
  // when there are no new replies.
  tasks.push(
    cron.schedule("*/15 * * * *", () => {
      processReplyDrafts().catch((err) => log.error("reply-draft job failed", err));
    }),
  );

  // Calendly meeting lifecycle (hourly): backfill booked meetings, send ~24h
  // reminders, record marked no-shows + queue rebooking drafts.
  if (calendlyEnabled()) {
    tasks.push(
      cron.schedule("10 * * * *", () => {
        syncMeetings().catch((err) => log.error("meeting sync failed", err));
      }),
    );
  }

  // Poll mailboxes for replies over IMAP (every minute) when enabled. The
  // poller guards against overlapping runs and no-ops without credentials.
  if (imapEnabled()) {
    tasks.push(
      cron.schedule("* * * * *", () => {
        pollReplies().catch((err) => log.error("imap poll failed", err));
      }),
    );
  }

  // Once-daily brain (cost-controlled). If the strategist (GLM) is configured we
  // run the agentic cycle where it reviews + acts via tools; otherwise we fall
  // back to the deterministic daily cycle (metrics + variant gen + digest).
  tasks.push(
    cron.schedule("30 8 * * *", () => {
      const job = strategist.configured ? runAutonomousCycle() : runDailyCycle();
      Promise.resolve(job).catch((err) => log.error("daily brain failed", err));
    }),
  );

  // Weekly strategic review + variant pruning (Mondays 09:00).
  tasks.push(
    cron.schedule("0 9 * * 1", () => {
      runWeeklyReview().catch((err) => log.error("weekly review failed", err));
    }),
  );

  // Monday operator digest (08:00) — the "what needs a human this week" ping.
  tasks.push(
    cron.schedule("0 8 * * 1", () => {
      runHumanDigest().catch((err) => log.error("human digest failed", err));
    }),
  );

  // Monthly review (1st of the month, 09:30).
  tasks.push(
    cron.schedule("30 9 1 * *", () => {
      runMonthlyReview().catch((err) => log.error("monthly review failed", err));
    }),
  );

  log.info(
    `scheduler started (dispatch /5m, events /10m, reply-drafts /15m${imapEnabled() ? ", imap /1m" : ""}${calendlyEnabled() ? ", meetings /1h" : ""}, daily 08:30, digest Mon 08:00, weekly Mon 09:00, monthly 1st 09:30)`,
  );
  return tasks;
}
