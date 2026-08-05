import { createHash } from "node:crypto";
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

function decodeAuthJson(): string {
  if (!config.oauthProxy.authJsonBase64) {
    throw new Error(
      "OPENAI_OAUTH_AUTH_JSON_BASE64 is required to seed OAuth credentials",
    );
  }

  const decoded = Buffer.from(config.oauthProxy.authJsonBase64, "base64").toString("utf8");
  const parsed: unknown = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENAI_OAUTH_AUTH_JSON_BASE64 did not decode to a JSON object");
  }
  return decoded;
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function requestedSeedMarker(): string {
  if (!config.oauthProxy.authJsonBase64) return config.oauthProxy.authSeedVersion;
  const fingerprint = createHash("sha256").update(config.oauthProxy.authJsonBase64).digest("hex");
  return `${config.oauthProxy.authSeedVersion || "auto"}:sha256:${fingerprint}`;
}

async function ensureAuthFile(): Promise<void> {
  const path = config.oauthProxy.authFile;
  const markerPath = `${path}.seed-version`;
  const requestedMarker = requestedSeedMarker();

  // A changed credential fingerprint replaces a stale persisted token once.
  // The marker then prevents later deploys from overwriting refreshed tokens.
  if (requestedMarker && (await readOptionalText(markerPath)) !== requestedMarker) {
    const decoded = decodeAuthJson();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, decoded, { encoding: "utf8", mode: 0o600 });
    await writeFile(markerPath, `${requestedMarker}\n`, { encoding: "utf8", mode: 0o600 });
    log.info(`reseeded OAuth credentials at ${path} (credential fingerprint changed)`);
    return;
  }

  if (await authFileExists(path)) {
    await chmod(path, 0o600);
    return;
  }

  const decoded = decodeAuthJson();

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
