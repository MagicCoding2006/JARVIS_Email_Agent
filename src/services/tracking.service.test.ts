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

test("video preview renders as one lightweight linked image", () => {
  const result = buildTrackedContent({
    messageId: "msg-3",
    body: "Hi Sam,\n\nI made this quick video for you.\n\nAlex",
    lead: { ...lead(), company: "Acme" },
    video: {
      _id: "video-1",
      hook: "45-sec walkthrough",
      previewUrl: "https://cdn.example.com/video-1-preview.gif",
      watchUrl: "https://track.example.com/v/video-1",
    },
  });

  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].url, "https://track.example.com/v/video-1");
  assert.match(result.html, /<img src="https:\/\/cdn\.example\.com\/video-1-preview\.gif"/);
  assert.match(result.html, new RegExp(`href="${trackingUrls.click(result.links[0].linkId)}"`));
  assert.match(result.html, /alt="45-sec walkthrough for Acme"/);
  assert.match(result.text, /45-sec walkthrough: https:\/\/track\.example\.com\/v\/video-1/);
});

test("video preview token controls placement", () => {
  const result = buildTrackedContent({
    messageId: "msg-4",
    body: "First line\n\n{{videoPreview}}\n\nLast line",
    lead: lead(),
    video: {
      _id: "video-2",
      hook: "quick video",
      previewUrl: "https://cdn.example.com/video-2-preview.gif",
      watchUrl: "https://track.example.com/v/video-2",
    },
  });

  assert(!result.html.includes("{{videoPreview}}"));
  assert(result.html.indexOf("First line") < result.html.indexOf("<img"));
  assert(result.html.indexOf("<img") < result.html.indexOf("Last line"));
});
