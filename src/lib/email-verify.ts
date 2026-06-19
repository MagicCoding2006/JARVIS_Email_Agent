import { promises as dns } from "node:dns";
import net from "node:net";
import { config } from "../config/index.js";
import { createLogger } from "./logger.js";

const log = createLogger("email-verify");

export type Verdict = "valid" | "guessed" | "invalid";

/** Common corporate email patterns, most→least likely. */
export function emailCandidates(first: string, last: string, domain: string): string[] {
  const f = sanitize(first);
  const l = sanitize(last);
  if (!domain) return [];
  const fi = f.slice(0, 1);
  const li = l.slice(0, 1);
  const out = new Set<string>();
  if (f && l) {
    out.add(`${f}.${l}@${domain}`);
    out.add(`${f}${l}@${domain}`);
    out.add(`${fi}${l}@${domain}`);
    out.add(`${f}@${domain}`);
    out.add(`${f}_${l}@${domain}`);
    out.add(`${fi}.${l}@${domain}`);
    out.add(`${l}${fi}@${domain}`);
  } else if (f) {
    out.add(`${f}@${domain}`);
  }
  return [...out];
}

function sanitize(s: string): string {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
}

/** MX hosts for a domain, sorted by priority. */
export async function resolveMx(domain: string): Promise<string[]> {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch {
    return [];
  }
}

/**
 * Best-effort email verification:
 *  - no MX            → invalid
 *  - SMTP RCPT 250    → valid
 *  - SMTP RCPT 550    → invalid
 *  - catch-all / port blocked / greylist → guessed
 * Returns the chosen email + verdict. Probes candidates in order, stops on a hit.
 */
export async function verifyBestEmail(
  candidates: string[],
): Promise<{ email: string | null; verdict: Verdict }> {
  if (candidates.length === 0) return { email: null, verdict: "invalid" };
  const domain = candidates[0].split("@")[1];
  const mx = await resolveMx(domain);
  if (mx.length === 0) return { email: null, verdict: "invalid" };

  if (!config.discovery.smtpProbe) {
    return { email: candidates[0], verdict: "guessed" };
  }

  const host = mx[0];
  // Detect catch-all domains (accept everything) — then we can't distinguish.
  const catchAll = await probeRcpt(host, `nope-${Date.now()}@${domain}`);
  if (catchAll === "ok") return { email: candidates[0], verdict: "guessed" };

  for (const email of candidates) {
    const r = await probeRcpt(host, email);
    if (r === "ok") return { email, verdict: "valid" };
    if (r === "unknown") return { email: candidates[0], verdict: "guessed" }; // port blocked/greylist
  }
  // All candidates returned a hard reject.
  return { email: null, verdict: "invalid" };
}

/** One SMTP RCPT TO probe. Never throws; returns ok/fail/unknown. */
function probeRcpt(mxHost: string, email: string): Promise<"ok" | "fail" | "unknown"> {
  const heloDomain = config.mail.fromEmail.split("@")[1] || "localhost";
  const from = `verify@${heloDomain}`;

  return new Promise((resolve) => {
    const socket = net.createConnection(25, mxHost);
    let stage = 0;
    let settled = false;
    const done = (v: "ok" | "fail" | "unknown") => {
      if (settled) return;
      settled = true;
      try {
        socket.write("QUIT\r\n");
        socket.end();
      } catch {
        /* ignore */
      }
      resolve(v);
    };

    socket.setTimeout(7000, () => done("unknown"));
    socket.on("error", () => done("unknown"));

    socket.on("data", (buf) => {
      const code = parseInt(buf.toString().slice(0, 3), 10);
      if (stage === 0) {
        if (code !== 220) return done("unknown");
        socket.write(`HELO ${heloDomain}\r\n`);
        stage = 1;
      } else if (stage === 1) {
        socket.write(`MAIL FROM:<${from}>\r\n`);
        stage = 2;
      } else if (stage === 2) {
        socket.write(`RCPT TO:<${email}>\r\n`);
        stage = 3;
      } else if (stage === 3) {
        if (code === 250 || code === 251) return done("ok");
        if (code === 550 || code === 551 || code === 553 || code === 554) return done("fail");
        return done("unknown"); // 450/451/452 greylist etc.
      }
    });
  });
}
