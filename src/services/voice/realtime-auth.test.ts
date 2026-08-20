import assert from "node:assert/strict";
import test from "node:test";

process.env.MONGODB_URI ??= "mongodb://localhost:27017/jarvis-test";
process.env.VOICE_MAX_CALL_SECONDS = "300";

const { jwtExpiry, minutesUntil, requiredRunwayMinutes } = await import("./realtime-auth.js");

/** Build an unsigned JWT with the given claims — we only ever read the payload. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.signature`;
}

test("jwtExpiry reads the exp claim", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(jwtExpiry(jwt({ exp }))?.getTime(), exp * 1000);
});

test("jwtExpiry survives tokens it cannot read instead of throwing", () => {
  // A malformed token must not take down a call — the caller degrades to
  // "unknown expiry", it does not crash the dialer.
  assert.equal(jwtExpiry("not-a-jwt"), undefined);
  assert.equal(jwtExpiry(""), undefined);
  assert.equal(jwtExpiry("a.b"), undefined);
  assert.equal(jwtExpiry(jwt({ sub: "no-exp-claim" })), undefined);
});

test("jwtExpiry handles base64url payloads needing padding", () => {
  // Real tokens are base64url and frequently unpadded; a naive decode breaks here.
  const exp = Math.floor(Date.now() / 1000) + 60;
  for (const filler of ["a", "ab", "abc", "abcd"]) {
    const token = jwt({ exp, pad: filler });
    assert.equal(jwtExpiry(token)?.getTime(), exp * 1000, `padding case "${filler}"`);
  }
});

test("minutesUntil reports remaining life, negative once expired", () => {
  const now = Date.now();
  assert.equal(minutesUntil(new Date(now + 30 * 60_000), now), 30);
  assert.equal(minutesUntil(new Date(now - 10 * 60_000), now), -10);
  assert.equal(minutesUntil(undefined, now), undefined);
});

test("required runway exceeds the longest possible call", () => {
  // The guard exists so a call can never outlive its own credentials: a token
  // with 3 minutes left must not start a conversation that may run 5.
  const runway = requiredRunwayMinutes();
  assert.ok(runway > 300 / 60, `runway ${runway}min must exceed the 5min call ceiling`);
  assert.equal(runway, 10);
});
