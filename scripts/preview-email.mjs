import "dotenv/config";
import { readdirSync } from "node:fs";
import path from "node:path";

const port = process.env.EMAIL_PREVIEW_PORT || "8794";
const baseURL = `http://127.0.0.1:${port}`;

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is required because tracked links are looked up in Mongo.");
  process.exit(1);
}

process.env.PORT = port;
process.env.TRACKING_PORT = port;
process.env.TRACKING_BASE_URL = baseURL;

const sampleVideoUrl = findSampleVideoUrl();

const [{ createApp }, { closeDb }, { getCollections, ensureIndexes }, { LeadsRepo, MessagesRepo }, { buildTrackedContent }] =
  await Promise.all([
    import("../dist/server/tracking-server.js"),
    import("../dist/lib/mongo.js"),
    import("../dist/repositories/collections.js"),
    import("../dist/repositories/index.js"),
    import("../dist/services/tracking.service.js"),
  ]);

const id = `preview-${Date.now()}`;
const body = `Hey Mike,

I made this quick video because missed roofing calls can turn into booked inspections for whoever answers first.

Here is the sample video link:
${sampleVideoUrl}

If it is useful, grab a time here:
https://calendly.com/example/intro

Worth a look?`;

let server;

try {
  await ensureIndexes();

  const lead = await LeadsRepo.upsertByEmail({
    email: `${id}@example.com`,
    firstName: "Mike",
    company: "Acme Roofing",
    industry: "roofing",
    source: "email-preview",
  });
  const tracked = buildTrackedContent({ messageId: id, body, lead });

  await MessagesRepo.create({
    _id: id,
    leadId: lead._id,
    campaignId: "email-preview",
    enrollmentId: "email-preview",
    step: 1,
    subject: "quick video for Acme Roofing",
    body,
    bodyHtml: tracked.html,
    bodyText: tracked.text,
    fromEmail: "sales@example.com",
    toEmail: lead.email,
    status: "sent",
    scheduledAt: new Date(),
    sentAt: new Date(),
    trackingPixelId: id,
    links: tracked.links,
  });

  const app = createApp();
  app.get("/__preview/email", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderPreviewPage({ subject: "quick video for Acme Roofing", html: tracked.html, links: tracked.links }));
  });

  server = await new Promise((resolve) => {
    const s = app.listen(Number(port), "127.0.0.1", () => resolve(s));
  });

  console.log("");
  console.log("Email preview is running.");
  console.log(`Open: ${baseURL}/__preview/email`);
  console.log("");
  console.log("Click the links inside the preview. They should route through /c/... and then redirect.");
  console.log("Press Ctrl+C here when finished.");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  await cleanup();
  process.exit(1);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  await cleanup();
  process.exit(0);
}

async function cleanup() {
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

function renderPreviewPage({ subject, html, links }) {
  const rows = links
    .map((link) => {
      const trackedUrl = `${baseURL}/c/${link.linkId}`;
      return `<tr><td><code>${escapeHtml(trackedUrl)}</code></td><td><a href="${trackedUrl}" target="_blank" rel="noreferrer">${escapeHtml(link.url)}</a></td></tr>`;
    })
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Email Preview</title>
    <style>
      body { margin: 0; background: #eef2f7; color: #111827; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      main { max-width: 960px; margin: 32px auto; padding: 0 20px 40px; }
      .meta, .email, table { background: white; border: 1px solid #d6dce6; border-radius: 8px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); }
      .meta { padding: 18px 22px; margin-bottom: 18px; }
      .email { padding: 26px; min-height: 280px; }
      h1 { font-size: 22px; margin: 0 0 8px; }
      h2 { font-size: 16px; margin: 24px 0 10px; }
      table { width: 100%; border-collapse: collapse; overflow: hidden; }
      th, td { padding: 12px 14px; border-bottom: 1px solid #e5e7eb; text-align: left; font-size: 14px; }
      th { color: #475569; background: #f8fafc; }
      code { font-size: 12px; color: #1d4ed8; }
      a { color: #2563eb; }
    </style>
  </head>
  <body>
    <main>
      <section class="meta">
        <h1>${escapeHtml(subject)}</h1>
        <div>Rendered exactly through <code>buildTrackedContent()</code>. Links below are real local tracking redirects.</div>
      </section>
      <section class="email">${html}</section>
      <h2>Tracked Links</h2>
      <table>
        <thead><tr><th>Tracked URL</th><th>Destination</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findSampleVideoUrl() {
  const videoDir = path.resolve(process.cwd(), process.env.VIDEO_OUTPUT_DIR || "data/videos");
  try {
    const fileName = readdirSync(videoDir)
      .filter((name) => name.toLowerCase().endsWith(".mp4"))
      .sort()[0];
    if (fileName) {
      return `${baseURL}/videos/${encodeURIComponent(fileName)}`;
    }
  } catch {
    // The preview still works without a generated video; the tracked redirect is what matters here.
  }
  return `${baseURL}/videos/sample-preview.mp4`;
}
