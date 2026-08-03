import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { startOpenAIOAuthServer, type RunningOpenAIOAuthServer } from "openai-oauth";
import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("openai-oauth-proxy");

let running: RunningOpenAIOAuthServer | undefined;

async function authFileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function ensureAuthFile(): Promise<void> {
  const path = config.oauthProxy.authFile;
  if (await authFileExists(path)) {
    await chmod(path, 0o600);
    return;
  }

  if (!config.oauthProxy.authJsonBase64) {
    throw new Error(
      `OpenAI OAuth credential file is missing at ${path}; set OPENAI_OAUTH_AUTH_JSON_BASE64 for the first boot`,
    );
  }

  const decoded = Buffer.from(config.oauthProxy.authJsonBase64, "base64").toString("utf8");
  const parsed: unknown = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENAI_OAUTH_AUTH_JSON_BASE64 did not decode to a JSON object");
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, decoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
  log.info(`bootstrapped OAuth credentials at ${path}`);
}

export async function startOAuthHarnessProxy(): Promise<RunningOpenAIOAuthServer | undefined> {
  if (!config.oauthProxy.enabled) return undefined;
  if (running) return running;

  if (config.oauthProxy.host !== "127.0.0.1" && config.oauthProxy.host !== "localhost") {
    throw new Error("OPENAI_OAUTH_PROXY_HOST must stay on loopback; do not expose ChatGPT OAuth credentials publicly");
  }

  await ensureAuthFile();
  running = await startOpenAIOAuthServer({
    host: config.oauthProxy.host,
    port: config.oauthProxy.port,
    authFilePath: config.oauthProxy.authFile,
  });
  log.info(`OAuth harness listening on ${running.url}`);
  return running;
}

export async function stopOAuthHarnessProxy(): Promise<void> {
  if (!running) return;
  await running.close();
  running = undefined;
  log.info("OAuth harness stopped");
}
