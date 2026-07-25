import assert from "node:assert/strict";
import { test } from "node:test";
import type { Lead } from "../models/types.js";
import { buildTrackedContent, trackingUrls } from "./tracking.service.js";

function lead(): Lead {
  return {
    _id: "lead-1",
    email: "test@example.com",
    status: "new",
    score: 0,
    customFields: {},
    unsubscribeToken: "unsub-token",
    unsubscribed: false,
    bounced: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

test("tracked HTML stores the exact redirect link it renders", () => {
  const result = buildTrackedContent({
    messageId: "msg-1",
    body: "Quick look: https://example.com/demo.",
    lead: lead(),
  });

  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].url, "https://example.com/demo");
  assert.match(result.html, new RegExp(`href="${trackingUrls.click(result.links[0].linkId)}"`));
  assert.match(result.html, /<\/a>\./);
  assert.match(result.text, /https:\/\/example\.com\/demo\./);
});

test("manual Gmail text links use the same tracked ID that is stored", () => {
  const result = buildTrackedContent({
    messageId: "msg-2",
    body: "Book here: https://calendly.com/acme/demo.",
    lead: lead(),
    trackTextLinks: true,
  });

  assert.equal(result.links.length, 1);
  assert.match(result.text, new RegExp(`${trackingUrls.click(result.links[0].linkId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
  assert.equal(result.links[0].url, "https://calendly.com/acme/demo");
});
