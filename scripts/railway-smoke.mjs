import { spawn } from "node:child_process";
import http from "node:http";
import "dotenv/config";

const port = process.env.PORT || process.env.TRACKING_PORT || "8787";
const timeoutMs = 25000;

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is required for railway:check because startup initializes Mongo indexes.");
  process.exit(1);
}

const child = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    PORT: port,
    TRACKING_PORT: process.env.TRACKING_PORT || port,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";
child.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});

const startedAt = Date.now();

try {
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }

    const health = await request("/health").catch(() => null);
    if (health?.status === 200 && health.body.includes('"ok":true')) {
      const dashboard = await request("/dashboard/");
      if (dashboard.status !== 200 || !/<!doctype html>/i.test(dashboard.body)) {
        throw new Error(`dashboard check failed with ${dashboard.status}`);
      }
      console.log(`Railway smoke check passed: http://127.0.0.1:${port}/health and /dashboard/`);
      process.exitCode = 0;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (process.exitCode !== 0) {
    throw new Error(`timed out waiting for http://127.0.0.1:${port}/health`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  if (logs.trim()) console.error(logs.trim());
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        timeout: 2000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}
