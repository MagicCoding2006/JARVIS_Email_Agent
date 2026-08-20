import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("voice:auth");

/**
 * Credentials for the realtime voice session.
 *
 * Two modes, and the second one is the reason this file exists:
 *
 *  - `api-key`      — a platform key. Static, boring, correct.
 *  - `openai-oauth` — a ChatGPT/Codex OAuth token. Works (verified against the
 *                     live API), and bills against a subscription instead of
 *                     metered realtime minutes.
 *
 * The OAuth path is **time-bombed by design**: the access token carries an `exp`
 * a few hours to days out and must be refreshed from a refresh token that can
 * itself be revoked. A static read of the auth file therefore produces a system
 * that works today and silently fails mid-campaign later — dropping live calls
 * on real prospects. So the token is resolved fresh for EVERY session, refresh
 * is attempted first, and the remaining lifetime is exposed so the dialer can
 * refuse to start a call that would outlive its own credentials.
 */

export interface RealtimeAuth {
  bearer: string;
  /** When the bearer stops working, if we can tell. */
  expiresAt?: Date;
  source: "api-key" | "oauth-refreshed" | "oauth-file";
  /** Set when we fell back to a raw stored token because refresh failed. */
  warning?: string;
}

/** Default location of the Codex CLI credentials. */
function defaultAuthFile(): string {
  return path.join(homedir(), ".codex", "auth.json");
}

function authFilePath(): string {
  return config.voice.realtime.oauthFile || defaultAuthFile();
}

/**
 * `exp` out of a JWT, without verifying the signature — we are reading our own
 * token to decide whether it is worth using, not authenticating anybody.
 */
export function jwtExpiry(token: string): Date | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: number };
    return typeof claims.exp === "number" ? new Date(claims.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export function minutesUntil(when: Date | undefined, now = Date.now()): number | undefined {
  if (!when) return undefined;
  return Math.round((when.getTime() - now) / 60_000);
}

/** Read the raw stored access token — the fallback when refresh is refused. */
function readStoredToken(): { token?: string; error?: string } {
  const file = authFilePath();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { tokens?: { access_token?: string } };
    const token = raw.tokens?.access_token;
    return token ? { token } : { error: `no tokens.access_token in ${file}` };
  } catch (err) {
    return { error: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Resolve a bearer for one session. Called per call, never cached, because the
 * whole point is to pick up a refreshed token without a redeploy.
 */
export async function resolveRealtimeAuth(): Promise<RealtimeAuth> {
  const rt = config.voice.realtime;

  if (rt.auth !== "openai-oauth") {
    if (!rt.apiKey) throw new Error("VOICE_REALTIME_API_KEY (or WORKER_API_KEY) is not set");
    return { bearer: rt.apiKey, source: "api-key" };
  }

  // Preferred: let the OAuth library refresh and hand back a current session.
  let refreshError = "";
  try {
    const { openaiCredentials } = await import("@openai-oauth/local");
    const creds = openaiCredentials({ authFilePath: authFilePath() }) as {
      getSession?: () => Promise<{ accessToken?: string; access_token?: string } | undefined>;
    };
    const session = await creds.getSession?.();
    const token = session?.accessToken ?? session?.access_token;
    if (token) {
      return { bearer: token, expiresAt: jwtExpiry(token), source: "oauth-refreshed" };
    }
    refreshError = "the OAuth session contained no access token";
  } catch (err) {
    refreshError = err instanceof Error ? err.message : String(err);
  }

  // Refresh was refused (commonly a revoked/expired refresh token → HTTP 401).
  // The stored access token often still has hours of life, so use it rather
  // than failing outright — but say so loudly, because this state does not heal
  // on its own and every call is now on a countdown.
  const stored = readStoredToken();
  if (!stored.token) {
    throw new Error(
      `realtime OAuth unavailable: refresh failed (${refreshError}) and ${stored.error}. ` +
        `Re-authenticate the Codex CLI to restore ${authFilePath()}.`,
    );
  }

  const expiresAt = jwtExpiry(stored.token);
  const mins = minutesUntil(expiresAt);
  if (mins !== undefined && mins <= 0) {
    throw new Error(
      `realtime OAuth token expired ${Math.abs(mins)} minutes ago and refresh failed (${refreshError}). ` +
        `Re-authenticate the Codex CLI.`,
    );
  }

  return {
    bearer: stored.token,
    expiresAt,
    source: "oauth-file",
    warning:
      `OAuth refresh failed (${refreshError}) — using the stored access token, which expires in ` +
      `${mins !== undefined ? `${mins} minutes` : "an unknown time"}. It will NOT renew itself; ` +
      `re-authenticate the Codex CLI to restore refresh.`,
  };
}

/**
 * Minutes of credential life a call needs before we are willing to dial.
 * A conversation runs up to `maxCallSeconds`; starting one with less runway
 * than that means hanging up on a real person mid-sentence.
 */
export function requiredRunwayMinutes(): number {
  return Math.ceil(config.voice.dialing.maxCallSeconds / 60) + 5;
}

export function logAuth(auth: RealtimeAuth): void {
  if (auth.warning) log.warn(auth.warning);
  else if (auth.source !== "api-key") {
    const mins = minutesUntil(auth.expiresAt);
    log.info(`realtime auth via ${auth.source}${mins !== undefined ? ` (expires in ${mins} min)` : ""}`);
  }
}
