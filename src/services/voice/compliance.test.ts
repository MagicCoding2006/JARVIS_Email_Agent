import assert from "node:assert/strict";
import test from "node:test";

process.env.MONGODB_URI ??= "mongodb://localhost:27017/jarvis-test";
// Pin the calling window so these assertions don't depend on a local .env.
process.env.VOICE_WINDOW_START_HOUR = "9";
process.env.VOICE_WINDOW_END_HOUR = "17";
process.env.VOICE_CALL_ON_WEEKENDS = "false";

const { normalizePhone, withinCallingHours, localHourFor, nextAttemptAt } = await import("./compliance.service.js");

test("normalizePhone accepts the shapes a real lead list contains", () => {
  assert.equal(normalizePhone("(555) 213-4567"), "+15552134567");
  assert.equal(normalizePhone("555-213-4567"), "+15552134567");
  assert.equal(normalizePhone("15552134567"), "+15552134567");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("+1 (555) 213-4567"), "+15552134567");
});

test("normalizePhone refuses anything it can't place, rather than misdialing", () => {
  assert.equal(normalizePhone(undefined), undefined);
  assert.equal(normalizePhone(""), undefined);
  assert.equal(normalizePhone("ext. 400"), undefined);
  // 7 digits — a local number with no area code. Dialing it would reach someone,
  // just not the person on the lead record.
  assert.equal(normalizePhone("213-4567"), undefined);
});

test("calling hours follow the PROSPECT's timezone, not the server's", () => {
  // 19:00 UTC = 15:00 in New York (EDT) and 12:00 in Los Angeles — both inside 9–17.
  const at = new Date("2026-08-12T19:00:00Z"); // a Wednesday
  assert.equal(withinCallingHours({ timezone: "America/New_York" }, at).allowed, true);
  assert.equal(withinCallingHours({ timezone: "America/Los_Angeles" }, at).allowed, true);

  // The same instant is 17:00 in New York — the window end is exclusive, so a
  // prospect whose local clock has hit 5pm is already off limits.
  const fivePm = new Date("2026-08-12T21:00:00Z");
  assert.equal(withinCallingHours({ timezone: "America/New_York" }, fivePm).allowed, false);
  assert.equal(withinCallingHours({ timezone: "America/Los_Angeles" }, fivePm).allowed, true);

  // 01:00 UTC Thursday = 21:00 Wednesday in New York — well outside the window.
  const late = new Date("2026-08-13T01:00:00Z");
  const blocked = withinCallingHours({ timezone: "America/New_York" }, late);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "outside_hours");
});

test("weekends are blocked in the prospect's local calendar", () => {
  // Saturday afternoon in New York.
  const sat = new Date("2026-08-15T16:00:00Z");
  const res = withinCallingHours({ timezone: "America/New_York" }, sat);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "weekend");
});

test("an unknown timezone degrades to server time instead of throwing", () => {
  const at = new Date("2026-08-12T21:00:00Z");
  const { hour } = localHourFor({ timezone: "Mars/Olympus_Mons" }, at);
  assert.equal(hour, at.getHours());
});

test("retries land inside the calling window and move across the day", () => {
  const from = new Date("2026-08-12T15:00:00Z");
  const hours = new Set<number>();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const next = nextAttemptAt(attempt, from);
    assert.ok(next.getHours() >= 9 && next.getHours() < 17, `attempt ${attempt} hour ${next.getHours()} in window`);
    assert.ok(next.getDay() !== 0 && next.getDay() !== 6, `attempt ${attempt} is on a weekday`);
    assert.ok(next.getTime() > from.getTime(), `attempt ${attempt} is in the future`);
    hours.add(next.getHours());
  }
  // The point of the ladder: don't call at the same hour every time.
  assert.ok(hours.size > 1, "retry hours vary across attempts");
});
