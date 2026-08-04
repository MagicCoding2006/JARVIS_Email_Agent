import { createLogger } from "./lib/logger.js";
import { closeDb } from "./lib/mongo.js";
import { startTrackingServer } from "./server/tracking-server.js";
import { startScheduler } from "./workers/scheduler.js";
import { startTelegramBot, stopTelegramBot } from "./chat/telegram.js";
import { config } from "./config/index.js";
import { worker, strategist } from "./llm/roles.js";
import { getSender } from "./services/sender/index.js";
import { startOAuthHarnessProxy, stopOAuthHarnessProxy } from "./services/openai-oauth-proxy.service.js";

const log = createLogger("main");

async function main() {
  log.info("starting AI SDR system");
  log.info(
    `config: dryRun=${config.sending.dryRun} autonomy=${config.agent.autonomy} ` +
      `worker=${worker.configured ? worker.route : "OFF"} strategist=${strategist.configured ? strategist.route : "OFF"} ` +
      `sender=${getSender().name}`,
  );

  // Bind Railway's public PORT before slower Mongo/OAuth initialization so the
  // platform health check does not race cold-start dependency setup.
  await startTrackingServer();
  try {
    await startOAuthHarnessProxy();
  } catch (err) {
    log.error(
      "OpenAI OAuth harness unavailable; continuing without GPT until credentials are reseeded and the service is redeployed",
      err,
    );
  }
  await startTelegramBot();
  const tasks = startScheduler();

  const shutdown = async () => {
    log.info("shutting down…");
    stopTelegramBot();
    for (const t of tasks) t.stop();
    await stopOAuthHarnessProxy();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("system up. Press Ctrl+C to stop.");
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
