import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import type {
  PlaceCallRequest,
  PlaceCallResult,
  TelephonyProvider,
} from "./voice.interface.js";

const log = createLogger("voice:twilio");
const API = "https://api.twilio.com/2010-04-01";

/**
 * Twilio over plain REST — no SDK, matching how Calendly and GitHub are wired.
 * Three calls is the whole surface: create a call, redirect a live one, hang up.
 */
export class TwilioTelephony implements TelephonyProvider {
  readonly name = "twilio";

  configured(): boolean {
    const t = config.voice.twilio;
    const canAuthenticate = Boolean(t.authToken) || Boolean(t.apiKeySid && t.apiKeySecret);
    return Boolean(t.accountSid && t.fromNumber && canAuthenticate);
  }

  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResult> {
    const body = new URLSearchParams({
      To: req.to,
      From: req.from,
      Url: req.answerUrl,
      StatusCallback: req.statusUrl,
      // "completed" is what closes the row out; the rest drive live status.
      StatusCallbackMethod: "POST",
      // Let a ringing phone go ~24s before we give up and retry another day.
      Timeout: "24",
      // Twilio's answering-machine detection routes voicemail to the same TwiML,
      // which reads AnsweredBy and plays the voicemail script instead of talking.
      MachineDetection: "DetectMessageEnd",
      MachineDetectionTimeout: "8",
    });
    for (const ev of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", ev);
    if (req.record) body.set("Record", "true");

    const res = await this.post(`/Accounts/${config.voice.twilio.accountSid}/Calls.json`, body);
    const sid = String(res.sid ?? "");
    if (!sid) throw new Error("Twilio returned no CallSid");
    log.info(`placed call ${sid} → ${req.to}`);
    return { providerCallId: sid, detail: String(res.status ?? "") };
  }

  async hangup(providerCallId: string): Promise<void> {
    await this.post(
      `/Accounts/${config.voice.twilio.accountSid}/Calls/${providerCallId}.json`,
      new URLSearchParams({ Status: "completed" }),
    );
  }

  /**
   * Warm transfer: redirect the live leg to TwiML that dials a human. The AI
   * leg drops as soon as the redirect lands, so the prospect is never left
   * listening to two voices.
   */
  async transfer(providerCallId: string, toNumber: string): Promise<void> {
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Say>Sure — connecting you now, one moment.</Say>` +
      `<Dial>${escapeXml(toNumber)}</Dial></Response>`;
    await this.post(
      `/Accounts/${config.voice.twilio.accountSid}/Calls/${providerCallId}.json`,
      new URLSearchParams({ Twiml: twiml }),
    );
    log.info(`transferred ${providerCallId} → ${toNumber}`);
  }

  /**
   * Basic-auth pair for the REST API.
   *
   * An API key authenticates as `SK…:secret` while the account SID stays in the
   * URL path — the key identifies the credential, not the account. Falls back to
   * the master `AC…:authToken` pair when no key is configured.
   */
  private credentials(): { user: string; pass: string; accountSid: string } {
    const { accountSid, authToken, apiKeySid, apiKeySecret } = config.voice.twilio;
    if (!accountSid) throw new Error("TWILIO_ACCOUNT_SID is not set (it is required even when using an API key)");
    if (apiKeySid && apiKeySecret) return { user: apiKeySid, pass: apiKeySecret, accountSid };
    if (authToken) return { user: accountSid, pass: authToken, accountSid };
    throw new Error("set TWILIO_AUTH_TOKEN, or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET");
  }

  private async post(path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
    const { user, pass } = this.credentials();
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Twilio ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
}

/** Logs what it would dial. Used when DRY_RUN=true, mirroring DryRunSender. */
export class DryRunTelephony implements TelephonyProvider {
  readonly name = "dry-run";
  private log = createLogger("voice:dryrun");

  configured(): boolean {
    return true;
  }

  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResult> {
    this.log.info(`[DRY RUN] would call ${req.to} from ${req.from}`, { answerUrl: req.answerUrl });
    return { providerCallId: `dryrun-${req.callId}`, detail: "dry-run" };
  }

  async hangup(): Promise<void> {
    /* nothing to hang up */
  }

  async transfer(): Promise<void> {
    throw new Error("transfer is not available in dry-run mode");
  }
}

let cached: TelephonyProvider | null = null;

/** The active telephony provider, honoring DRY_RUN. */
export function getTelephony(): TelephonyProvider {
  if (cached) return cached;
  cached = config.sending.dryRun || config.voice.provider === "dry-run"
    ? new DryRunTelephony()
    : new TwilioTelephony();
  return cached;
}

/**
 * Validate `X-Twilio-Signature`: HMAC-SHA1 over the full URL with every POST
 * parameter appended in sorted order, keyed by the auth token.
 *
 * This matters more here than on the email webhooks. The media-stream and TwiML
 * URLs are public, and an unsigned POST to them can start a call leg or hand an
 * attacker the conversation — so an unverifiable request is refused outright.
 */
/**
 * Can we verify inbound webhooks at all?
 *
 * Twilio signs them with the **account auth token** — an API key secret cannot
 * substitute. So an API-key-only setup places calls fine and then rejects every
 * TwiML request, which from the handset is just a call that rings and dies.
 * Callers surface this as configuration advice rather than a security event.
 */
export function signatureValidationReady(): { ready: boolean; reason?: string } {
  if (!config.voice.twilio.validateSignature) return { ready: true };
  if (config.voice.twilio.authToken) return { ready: true };
  return {
    ready: false,
    reason:
      "TWILIO_VALIDATE_SIGNATURE is on but TWILIO_AUTH_TOKEN is empty — Twilio signs webhooks with the " +
      "account auth token, not an API key secret. Set TWILIO_AUTH_TOKEN, or set TWILIO_VALIDATE_SIGNATURE=false " +
      "(only acceptable for a local tunnel test).",
  };
}

export function validateTwilioSignature(
  signature: string | undefined,
  url: string,
  params: Record<string, unknown>,
): boolean {
  const token = config.voice.twilio.authToken;
  if (!token) return false;
  if (!signature) return false;

  let data = url;
  for (const key of Object.keys(params).sort()) data += key + String(params[key] ?? "");

  const expected = createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
