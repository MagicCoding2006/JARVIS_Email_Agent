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

const log = createLogger("scheduler");

/** Wire up the recurring jobs. Returns the scheduled tasks for shutdown. */
export function startScheduler(): cron.ScheduledTask[] {
  const tasks: cron.ScheduledTask[] = [];

  // Send due messages frequently; the dispatcher self-limits to the window + caps.
  tasks.push(
    cron.schedule("*/5 * * * *", () => {
      dispatchDue().catch((err) => log.error("dispatch job failed", err));
    }),
  );

  // Batch-process tracking events (scoring + escalation) — NOT on every event.
  tasks.push(
    cron.schedule("*/10 * * * *", () => {
      processEvents().catch((err) => log.error("event job failed", err));
    }),
  );

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

  // Monthly review (1st of the month, 09:30).
  tasks.push(
    cron.schedule("30 9 1 * *", () => {
      runMonthlyReview().catch((err) => log.error("monthly review failed", err));
    }),
  );

  log.info("scheduler started (dispatch /5m, events /10m, daily 08:30, weekly Mon 09:00, monthly 1st 09:30)");
  return tasks;
}
