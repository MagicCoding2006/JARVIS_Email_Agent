// Smoke test for pure logic (no DB/network). Run: tsx scripts/smoke.ts
import { DEFAULT_SEQUENCE } from "../src/services/sequences/default-sequence.js";
import { scheduleFromAnchor } from "../src/lib/time.js";
import { buildTrackedContent } from "../src/services/tracking.service.js";
import { parseJSONLoose } from "../src/llm/provider.js";
import { variantScore } from "../src/services/variants.service.js";
import type { Lead } from "../src/models/types.js";

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) failures++;
};

// 1) Sequence spacing — widening gaps, all on weekdays.
const anchor = new Date("2026-06-15T09:00:00"); // a Monday
console.log("\n— 7-touch schedule (anchor Mon 2026-06-15) —");
let prev = 0;
for (const step of DEFAULT_SEQUENCE) {
  const when = scheduleFromAnchor(anchor, step.businessDayOffset);
  const dow = when.toLocaleDateString("en-US", { weekday: "short" });
  console.log(`  step ${step.step} (${step.purpose}) +${step.businessDayOffset}bd → ${when.toDateString()} ${dow}`);
  assert(dow !== "Sat" && dow !== "Sun", `step ${step.step} lands on a weekday`);
  assert(when.getTime() >= prev, `step ${step.step} is after the previous step`);
  prev = when.getTime();
}

// 2) Tracked content — pixel, unsubscribe, wrapped link.
const lead: Lead = {
  _id: "lead1", email: "jane@acme.com", firstName: "Jane", status: "new", score: 0,
  customFields: {}, unsubscribeToken: "tok123", unsubscribed: false, bounced: false,
  createdAt: new Date(), updatedAt: new Date(),
};
const { html, text, links } = buildTrackedContent({
  messageId: "msg1",
  body: "Hi Jane,\nThought you'd like this: https://acme.com/pricing\nBest, Alex",
  lead,
});
console.log("\n— tracked content —");
assert(html.includes('/o/msg1.gif'), "open pixel injected");
assert(links.length === 1 && links[0].url === "https://acme.com/pricing", "1 link extracted");
assert(html.includes(`/c/${links[0].linkId}`), "link rewritten through click tracker");
assert(html.includes("/u/tok123") && text.includes("/u/tok123"), "unsubscribe link present in html+text");

// 3) Loose JSON parsing (model wrapped in prose/fences).
console.log("\n— json parsing —");
const parsed = parseJSONLoose<{ subject: string }>('```json\n{"subject":"hi"}\n```');
assert(parsed.subject === "hi", "parses fenced JSON");
const parsed2 = parseJSONLoose<{ a: number }>('Sure! {"a": 5} hope that helps');
assert(parsed2.a === 5, "extracts JSON embedded in prose");

// 4) Bandit reward — positive replies/meetings beat opens.
console.log("\n— variant scoring —");
const zero = { sent: 0, opens: 0, clicks: 0, replies: 0, positiveReplies: 0, meetings: 0, closes: 0, revenue: 0 };
const opener = { ...zero, sent: 100, opens: 60 };
const replier = { ...zero, sent: 100, opens: 40, replies: 8, positiveReplies: 4, meetings: 2 };
assert(variantScore(replier) > variantScore(opener), "variant with replies+meetings outscores opens-only");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
