import { spawn } from "node:child_process";
import "dotenv/config";

const port = process.env.PORT || process.env.TRACKING_PORT || "8787";
const url = `http://127.0.0.1:${port}/health`;
const timeoutMs = 25000;

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is required for railway:check because startup initializes Mongo indexes.");
  process.exit(1);
}

const child = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, PORT: port, TRACKING_PORT: process.env.TRACKING_PORT || port },
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

    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`Railway smoke check passed: ${url}`);
        process.exitCode = 0;
        break;
      }
    } catch {
      // Server may still be booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (process.exitCode !== 0) {
    throw new Error(`timed out waiting for ${url}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  if (logs.trim()) console.error(logs.trim());
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
