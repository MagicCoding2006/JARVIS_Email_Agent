import "dotenv/config";

const port = process.env.LINK_CHECK_PORT || "8791";
const baseURL = `http://127.0.0.1:${port}`;

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is required for check:links because redirects are looked up in Mongo.");
  process.exit(1);
}

process.env.PORT = port;
process.env.TRACKING_PORT = port;
process.env.TRACKING_BASE_URL = baseURL;

const [{ createApp }, { closeDb }, { getCollections, ensureIndexes }, { LeadsRepo, MessagesRepo }, { buildTrackedContent }] =
  await Promise.all([
    import("../dist/server/tracking-server.js"),
    import("../dist/lib/mongo.js"),
    import("../dist/repositories/collections.js"),
    import("../dist/repositories/index.js"),
    import("../dist/services/tracking.service.js"),
  ]);

const id = `smoke-${Date.now()}`;
const destination = "https://example.com/smoke";
let server;

try {
  await ensureIndexes();
  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(Number(port), "127.0.0.1", () => resolve(s));
  });

  const lead = await LeadsRepo.upsertByEmail({
    email: `${id}@example.com`,
    firstName: "Smoke",
    company: "Smoke Test",
    source: "smoke-test",
  });
  const tracked = buildTrackedContent({
    messageId: id,
    body: `Testing redirect ${destination}.`,
    lead,
  });

  await MessagesRepo.create({
    _id: id,
    leadId: lead._id,
    campaignId: "smoke-test",
    enrollmentId: "smoke-test",
    step: 1,
    subject: "Smoke test",
    body: `Testing redirect ${destination}.`,
    bodyHtml: tracked.html,
    bodyText: tracked.text,
    fromEmail: "smoke@example.com",
    toEmail: lead.email,
    status: "sent",
    scheduledAt: new Date(),
    sentAt: new Date(),
    trackingPixelId: id,
    links: tracked.links,
  });

  const linkId = tracked.links[0]?.linkId;
  if (!linkId) throw new Error("No tracked link was generated.");

  const res = await fetch(`${baseURL}/c/${linkId}`, { redirect: "manual" });
  const location = res.headers.get("location");
  if (res.status !== 302 || location !== destination) {
    throw new Error(`Expected 302 to ${destination}, got ${res.status} to ${location}`);
  }

  console.log(`Link smoke check passed: /c/${linkId} -> ${location}`);
} finally {
  const c = await getCollections().catch(() => null);
  if (c) {
    await Promise.all([
      c.messages.deleteMany({ _id: id }),
      c.leads.deleteMany({ email: `${id}@example.com` }),
      c.events.deleteMany({ messageId: id }),
    ]);
  }
  await new Promise((resolve) => server?.close(resolve));
  await closeDb();
}
