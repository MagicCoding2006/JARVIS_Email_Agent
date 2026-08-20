import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { closeDb } from "../lib/mongo.js";
import { ensureIndexes, getCollections } from "../repositories/collections.js";
import {
  CampaignsRepo,
  EnrollmentsRepo,
  EventsRepo,
  LeadsRepo,
  MessagesRepo,
} from "../repositories/index.js";
import { DEFAULT_SEQUENCE } from "../services/sequences/default-sequence.js";
import { NURTURE_SEQUENCE } from "../services/sequences/nurture-sequence.js";
import { enrollLead } from "../services/sequencer.service.js";
import { cancelCampaignEnrollments } from "../services/campaign-control.service.js";
import { dispatchDue } from "../workers/dispatcher.js";
import { processEvents } from "../workers/event-processor.js";
import { runDailyCycle } from "../workers/daily-cycle.js";
import { runWeeklyReview } from "../workers/weekly-review.js";
import { runMonthlyReview } from "../workers/monthly-review.js";
import { handleInboundReply } from "../services/replies.service.js";
import { imapEnabled, pollReplies } from "../services/imap-poller.service.js";
import { getMailboxByEmail } from "../services/sender/mailbox.js";
import { createGmailPixel } from "../services/compose.service.js";
import { generateVariants, variantLeaderboard, pruneVariants, ensureCampaign } from "../services/variants.service.js";
import { createVideoForLead, produceVideo } from "../services/video.service.js";
import { pruneOldVideos } from "../services/video/retention.js";
import { researchLead } from "../services/research.service.js";
import { sourceLeadsFromApollo } from "../services/apollo.service.js";
import { sourceLeadsFromApify } from "../services/apify.service.js";
import { discoverLeads } from "../services/discovery.service.js";
import { discoverBusinessContacts, discoverContractors } from "../services/business-discovery.service.js";
import { buildCrmSnapshot, toCsv, printCrmTable } from "../services/crm.service.js";
import { emailCandidates, verifyBestEmail } from "../lib/email-verify.js";
import { dialDue, queueCall } from "../workers/dialer.js";
import { simulateCall } from "../services/voice/simulator.js";
import { voicePreflightAutodetect } from "../services/voice/preflight.js";
import { canCall, addToDnc, normalizePhone } from "../services/voice/compliance.service.js";
import { getTelephony, signatureValidationReady } from "../services/voice/twilio.telephony.js";
import { realtimeAuthCheck } from "../services/voice/openai-realtime.js";
import { buildCallInstructions } from "../services/voice/script.js";
import { CallsRepo, DncRepo } from "../repositories/index.js";
import { handleChat } from "../agent/agent.js";
import { runAutonomousCycle } from "../workers/autonomous-cycle.js";
import { executeApproval, denyApproval } from "../agent/approvals.js";
import { ApprovalsRepo, HypothesesRepo } from "../repositories/index.js";
import { evaluateHypotheses } from "../services/experiments.service.js";
import { strategist, worker } from "../llm/roles.js";
import type { EventType, LeadStatus, VideoPurpose } from "../models/types.js";

const csv = (v: string | boolean | undefined) =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

const log = createLogger("cli");
const DEFAULT_VIDEO_OFFER =
  "When you can't get to the phone, our AI calls the lead back within 30 seconds, figures out what they need, and books the job straight to your calendar, then texts you the details, so the calls you used to lose to voicemail and your competitor turn into booked work on autopilot. You keep your number with nothing changing on Google or your website, we build and train the whole thing on your business in 48 hours, and in week one we even reactivate your old missed-call list to start booking jobs immediately. All for $197/month locked for life, no setup fee for founding operators, month-to-month. You don't pay a cent until it books your first job, and your phone rings exactly like it does today if our system is ever down.";

// ── tiny flag parser ──────────────────────────────────────────────────────────
interface Parsed {
  _: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Parsed {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(a);
  }
  return { _, flags };
}
const str = (v: string | boolean | undefined, d = "") => (typeof v === "string" ? v : d);
const int = (v: string | boolean | undefined, d: number) =>
  typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : d;

// ── commands ────────────────────────────────────────────────────────────────
async function cmdImportLeads(p: Parsed) {
  const file = p._[0] || str(p.flags.file);
  if (!file) throw new Error("usage: cli import-leads <path.csv> [--source <name>]");
  const raw = readFileSync(file, "utf-8");
  const rows: Record<string, string>[] = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const known = new Set([
    "email", "phone", "name", "firstname", "lastname", "title", "company",
    "industry", "website", "linkedin", "source", "timezone",
  ]);
  let imported = 0;
  for (const row of rows) {
    const get = (k: string) => row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()] ?? "";
    const email = get("email").trim();
    if (!email) continue;
    const customFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!known.has(k.toLowerCase()) && v) customFields[k] = v;
    }
    await LeadsRepo.upsertByEmail({
      email,
      // Normalized at import so the dialer never has to guess at a raw string.
      phone: normalizePhone(get("phone")),
      name: get("name") || undefined,
      firstName: get("firstName") || get("firstname") || undefined,
      lastName: get("lastName") || get("lastname") || undefined,
      title: get("title") || undefined,
      company: get("company") || undefined,
      industry: get("industry") || undefined,
      website: get("website") || undefined,
      linkedin: get("linkedin") || undefined,
      source: get("source") || str(p.flags.source, "import"),
      timezone: get("timezone") || undefined,
      customFields,
    });
    imported++;
  }
  log.info(`imported/updated ${imported} leads from ${file}`);
}

async function cmdAddLead(p: Parsed) {
  const email = str(p.flags.email);
  if (!email) throw new Error("usage: cli add-lead --email <e> [--name --company --title --industry --phone --timezone]");
  const lead = await LeadsRepo.upsertByEmail({
    email,
    phone: normalizePhone(str(p.flags.phone)),
    timezone: str(p.flags.timezone) || undefined,
    name: str(p.flags.name) || undefined,
    company: str(p.flags.company) || undefined,
    title: str(p.flags.title) || undefined,
    industry: str(p.flags.industry) || undefined,
    website: str(p.flags.website) || undefined,
    source: str(p.flags.source, "manual"),
  });
  log.info(`lead ${lead.email} (${lead._id})`);
}

async function cmdCreateCampaign(p: Parsed) {
  const name = str(p.flags.name);
  const offer = str(p.flags.offer);
  const persona = str(p.flags.persona);
  if (!name || !offer || !persona) {
    throw new Error('usage: cli create-campaign --name "X" --offer "..." --persona "..." [--from email] [--sequence cold|nurture] [--sequence-file seq.json] [--active]');
  }
  const existing = await CampaignsRepo.getByName(name);
  if (existing) {
    log.warn(`campaign "${name}" already exists (${existing._id})`);
    return;
  }

  // Built-in sequence style, or a custom file (e.g. with bodyTemplate slots).
  const style = str(p.flags.sequence, "cold");
  if (style !== "cold" && style !== "nurture") throw new Error('--sequence must be "cold" or "nurture"');
  let sequence = style === "nurture" ? NURTURE_SEQUENCE : DEFAULT_SEQUENCE;
  const seqFile = str(p.flags["sequence-file"]);
  if (seqFile) {
    const raw = readFileSync(seqFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("sequence file must be a non-empty JSON array of steps");
    sequence = parsed as typeof DEFAULT_SEQUENCE;
    log.info(`loaded ${sequence.length}-step sequence from ${seqFile}`);
  }

  const c = await CampaignsRepo.create({
    name,
    offer,
    targetPersona: persona,
    fromEmail: str(p.flags.from) || undefined,
    sequence,
    status: p.flags.active ? "active" : "draft",
  });
  log.info(`created campaign "${c.name}" (${c._id}) status=${c.status}, ${c.sequence.length} steps`);
}

async function cmdListCampaigns() {
  const list = await CampaignsRepo.list();
  for (const c of list) {
    log.info(`${c.status.padEnd(8)} ${c.name}  (${c._id})  steps=${c.sequence.length}`);
  }
  if (!list.length) log.info("no campaigns yet");
}

async function resolveCampaign(idOrName: string) {
  return (await CampaignsRepo.getById(idOrName)) ?? (await CampaignsRepo.getByName(idOrName));
}

async function cmdActivateCampaign(p: Parsed) {
  const ref = p._[0] || str(p.flags.campaign);
  const c = await resolveCampaign(ref);
  if (!c) throw new Error(`campaign not found: ${ref}`);
  await CampaignsRepo.setStatus(c._id, "active");
  log.info(`activated "${c.name}"`);
}

async function cmdCancelEnrollments(p: Parsed) {
  const ref = p._[0] || str(p.flags.campaign);
  if (!ref) throw new Error("usage: cli cancel-enrollments <name|id> [--yes] [--all] [--keep-messages]");
  // Preview unless --yes is explicit. `npm run cli` swallows a trailing
  // --dry-run as npm's own flag, so a safe default is the only reliable guard.
  const dryRun = !p.flags.yes;
  const res = await cancelCampaignEnrollments({
    campaign: ref,
    statusFilter: p.flags.all ? "all" : "active",
    cancelDueMessages: !p.flags["keep-messages"],
    dryRun,
  });
  if ("error" in res) {
    throw new Error(
      `${res.error}${res.candidates?.length ? `\nknown campaigns:\n  ${res.candidates.join("\n  ")}` : ""}`,
    );
  }
  log.info(
    `${res.dryRun ? "[dry run] would cancel" : "cancelled"} ${res.cancelledEnrollments}/${res.matchedEnrollments} enrollment(s) ` +
      `and ${res.cancelledScheduledMessages} queued message(s) for "${res.campaign}" (campaign is ${res.campaignStatus})`,
  );
  if (res.dryRun) log.info("nothing was written — re-run with --yes to apply");
}

async function cmdEnroll(p: Parsed) {
  const ref = str(p.flags.campaign);
  const c = await resolveCampaign(ref);
  if (!c) throw new Error(`campaign not found: ${ref} (use --campaign <name|id>)`);

  let leadIds: string[] = [];
  if (p.flags.lead) {
    const lead = await LeadsRepo.getByEmail(str(p.flags.lead));
    if (!lead) throw new Error(`lead not found: ${str(p.flags.lead)}`);
    leadIds = [lead._id];
  } else {
    const status = (str(p.flags.status, "new") as LeadStatus) || "new";
    const leads = await LeadsRepo.list({ status }, int(p.flags.limit, 50));
    leadIds = leads.map((l) => l._id);
  }

  let created = 0;
  for (const id of leadIds) {
    const r = await enrollLead(id, c._id);
    if (r.created) created++;
  }
  log.info(`enrolled ${created}/${leadIds.length} lead(s) into "${c.name}" (first touch scheduled)`);
}

async function cmdDispatch(p: Parsed) {
  const r = await dispatchDue({ ignoreWindow: Boolean(p.flags["ignore-window"]) });
  log.info(`dispatch: ${JSON.stringify(r)}`);
}

async function cmdRebalanceMailbox(p: Parsed) {
  const target = str(p.flags.to).trim().toLowerCase();
  const from = str(p.flags.from).trim().toLowerCase();
  const limit = int(p.flags.limit, 5);
  const dryRun = Boolean(p.flags["dry-run"]);
  if (!target || limit <= 0) {
    throw new Error("usage: cli rebalance-mailbox --to <mailbox> [--from <mailbox>] [--limit 5] [--dry-run]");
  }
  if (!getMailboxByEmail(target)) throw new Error(`target mailbox is not in MAILBOXES: ${target}`);
  if (from && !getMailboxByEmail(from)) throw new Error(`source mailbox is not in MAILBOXES: ${from}`);

  const c = await getCollections();
  const match: Record<string, unknown> = { status: "scheduled" };
  if (from) match.fromEmail = from;
  else match.fromEmail = { $ne: target };

  const rows = await c.messages
    .aggregate<{ _id: string; enrollmentId: string; fromEmail: string; toEmail: string; scheduledAt: Date }>([
      { $match: match },
      {
        $lookup: {
          from: "enrollments",
          localField: "enrollmentId",
          foreignField: "_id",
          as: "enrollment",
        },
      },
      { $unwind: "$enrollment" },
      { $match: { "enrollment.status": "active" } },
      {
        $lookup: {
          from: "messages",
          let: { enrollmentId: "$enrollmentId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$enrollmentId", "$$enrollmentId"] },
                    { $eq: ["$status", "sent"] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "priorSent",
        },
      },
      { $match: { priorSent: { $size: 0 } } },
      { $sort: { scheduledAt: 1 } },
      { $limit: limit },
      { $project: { _id: 1, enrollmentId: 1, fromEmail: 1, toEmail: 1, scheduledAt: 1 } },
    ])
    .toArray();

  if (!rows.length) {
    log.info("no safe scheduled messages found to rebalance");
    return;
  }
  const ids = rows.map((r) => r._id);
  const enrollmentIds = [...new Set(rows.map((r) => r.enrollmentId))];
  if (dryRun) {
    log.info(`would move ${ids.length} scheduled message(s) to ${target}`);
    for (const r of rows) log.info(`  ${r._id} ${r.fromEmail} -> ${target} ${r.toEmail}`);
    return;
  }

  await c.messages.updateMany(
    { _id: { $in: ids } },
    { $set: { fromEmail: target, updatedAt: new Date() }, $unset: { inReplyTo: "" } },
  );
  await c.enrollments.updateMany(
    { _id: { $in: enrollmentIds } },
    { $set: { assignedMailbox: target, updatedAt: new Date() } },
  );
  log.info(`moved ${ids.length} scheduled message(s) / ${enrollmentIds.length} enrollment(s) to ${target}`);
}

async function cmdProcessEvents() {
  const r = await processEvents();
  log.info(`processed ${r.processed} events`);
}

async function cmdLlmSmoke(p: Parsed) {
  const roleName = str(p.flags.role, "worker");
  const prompt = str(p.flags.prompt, "Reply with exactly: ok");
  const client = roleName === "strategist" ? strategist : worker;
  if (!client.configured) throw new Error(`${roleName} LLM is not configured`);
  const text = await client.complete(prompt, { maxTokens: 50, temperature: 0 });
  log.info(`${roleName}: ${text}`);
}

async function cmdDailyCycle() {
  await runDailyCycle();
}

async function cmdIngestReply(p: Parsed) {
  const email = str(p.flags.email);
  const text = str(p.flags.text);
  if (!email || !text) throw new Error('usage: cli ingest-reply --email <e> --text "reply text" [--message <id>]');
  const r = await handleInboundReply({ fromEmail: email, text, messageId: str(p.flags.message) || undefined });
  log.info(`classified: ${r.classification}`);
}

async function cmdPollReplies() {
  if (!imapEnabled()) {
    log.warn("IMAP polling is disabled — set IMAP_ENABLED=true and configure mailbox credentials");
    return;
  }
  const r = await pollReplies();
  log.info(`polled ${r.mailboxes} mailbox(es), ingested ${r.replies} reply(ies)`);
}

async function cmdHypotheses(p: Parsed) {
  const status = str(p.flags.status);
  const rows = status
    ? await HypothesesRepo.listByStatus(status as never)
    : await HypothesesRepo.list();
  if (!rows.length) {
    log.info("no hypotheses yet (run daily-cycle with the strategist configured)");
    return;
  }
  const icon: Record<string, string> = { proposed: "•", testing: "🧪", keep: "✅", reject: "❌" };
  for (const h of rows.slice(0, 50)) {
    // eslint-disable-next-line no-console
    console.log(`${icon[h.status] ?? "•"} [${h.status}] ${h.idea}${h.result ? `\n     → ${h.result}` : ""}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${rows.length} hypotheses`);
}

async function cmdEvalHypotheses() {
  const verdicts = await evaluateHypotheses();
  if (!verdicts.length) {
    log.info("no hypotheses had enough data to decide yet");
    return;
  }
  for (const v of verdicts) {
    log.info(`${v.decision.toUpperCase()}: ${v.idea} — ${v.result}`);
  }
}

async function cmdEvent(p: Parsed) {
  const email = str(p.flags.email);
  const type = str(p.flags.type) as EventType;
  if (!email || !type) throw new Error('usage: cli event --email <e> --type <booked|showed|closed_won|...>');
  const lead = await LeadsRepo.getByEmail(email);
  if (!lead) throw new Error(`lead not found: ${email}`);
  await EventsRepo.record({ leadId: lead._id, type, metadata: { manual: true } });
  log.info(`recorded ${type} for ${email} (run process-events to score it)`);
}

async function cmdStatus() {
  const [total, active, replied, meetings, hot] = await Promise.all([
    LeadsRepo.count(),
    LeadsRepo.count({ status: "active" }),
    LeadsRepo.count({ status: "replied" }),
    LeadsRepo.count({ status: "meeting" }),
    LeadsRepo.count({ score: { $gte: 70 } }),
  ]);
  log.info(`leads: ${total} total | active ${active} | replied ${replied} | meetings ${meetings} | hot ${hot}`);
}

async function cmdLead(p: Parsed) {
  const email = p._[0] || str(p.flags.email);
  const lead = await LeadsRepo.getByEmail(email);
  if (!lead) throw new Error(`lead not found: ${email}`);
  log.info(`${lead.name ?? lead.email} | ${lead.company ?? ""} | status=${lead.status} | score=${lead.score}`);
  const events = await EventsRepo.recentForLead(lead._id, 15);
  for (const e of events) log.info(`  ${e.timestamp.toISOString()} ${e.type}`);
  const msgs = await MessagesRepo.listForLead(lead._id);
  for (const m of msgs) log.info(`  step ${m.step} [${m.status}] "${m.subject}" @ ${m.scheduledAt.toISOString()}`);
}

async function cmdMakePixel(p: Parsed) {
  const email = str(p.flags.email);
  const subject = str(p.flags.subject);
  const body = str(p.flags.body);
  if (!email || !subject || !body) {
    throw new Error('usage: cli make-pixel --email <e> --subject "..." --body "..." [--campaign <id>]');
  }
  const r = await createGmailPixel({ email, subject, body, campaignId: str(p.flags.campaign) || undefined });
  log.info(`pixel: ${r.pixelUrl}`);
  // eslint-disable-next-line no-console
  console.log("\n— Paste this into the Gmail Compose DevTools console —\n");
  // eslint-disable-next-line no-console
  console.log(r.consoleScript);
}

async function cmdGenVariants(p: Parsed) {
  const c = await ensureCampaign(str(p.flags.campaign));
  if (!c) throw new Error("campaign not found (use --campaign <name|id>)");
  const created = await generateVariants({
    campaign: c,
    step: int(p.flags.step, 1),
    count: int(p.flags.count, 3),
  });
  log.info(`created ${created.length} variants for "${c.name}" step ${int(p.flags.step, 1)}`);
  for (const v of created) log.info(`  ${v.name}: "${v.subjectLine}" [${v.tone}]`);
}

async function cmdListVariants(p: Parsed) {
  const c = await ensureCampaign(str(p.flags.campaign));
  if (!c) throw new Error("campaign not found (use --campaign <name|id>)");
  const board = await variantLeaderboard(c._id);
  for (const v of board) {
    log.info(`  step ${v.step} ${v.active ? "●" : "○"} ${v.name} — ${v.sent} sent, ${v.replyRate}% reply, score ${v.score}`);
  }
  if (!board.length) log.info("no variants yet — run gen-variants");
}

async function cmdPruneVariants(p: Parsed) {
  const c = await ensureCampaign(str(p.flags.campaign));
  if (!c) throw new Error("campaign not found (use --campaign <name|id>)");
  const r = await pruneVariants(c._id);
  log.info(`pruned ${r.pruned}, kept ${r.kept}`);
}

async function cmdVideoScript(p: Parsed) {
  const email = str(p.flags.email);
  const offer = str(p.flags.offer, DEFAULT_VIDEO_OFFER);
  if (!email) throw new Error('usage: cli video-script --email <e> [--offer "..."] [--campaign <id>] [--purpose cold|follow_up|appointment|proposal]');
  const asset = await createVideoForLead({ leadEmail: email, offer, campaignId: str(p.flags.campaign) || undefined, purpose: parseVideoPurpose(p) });
  if (!asset) return;
  log.info(`watch URL: ${asset.watchUrl}`);
  log.info(`hook: ${asset.hook}`);
  if (asset.context) log.info(`email context: ${asset.context}`);
  // eslint-disable-next-line no-console
  console.log(`\n--- script ---\n${asset.script}\n`);
}

async function cmdCreateVideo(p: Parsed) {
  const email = str(p.flags.email);
  const offer = str(p.flags.offer, DEFAULT_VIDEO_OFFER);
  if (!email) throw new Error('usage: cli create-video --email <e> [--offer "..."] [--campaign <id>] [--purpose cold|follow_up|appointment|proposal]');

  const asset = await createVideoForLead({ leadEmail: email, offer, campaignId: str(p.flags.campaign) || undefined, purpose: parseVideoPurpose(p) });
  if (!asset) return;

  log.info(`video id: ${asset._id}`);
  log.info(`watch URL: ${asset.watchUrl}`);
  log.info(`hook: ${asset.hook}`);
  if (asset.context) log.info(`email context: ${asset.context}`);
  // eslint-disable-next-line no-console
  console.log(`\n--- script ---\n${asset.script}\n`);

  const rendered = await produceVideo(asset._id);
  log.info(`render status: ${rendered?.status ?? "unknown"} ${rendered?.videoUrl ?? ""}`);
}

function parseVideoPurpose(p: Parsed): VideoPurpose | undefined {
  const raw = str(p.flags.purpose);
  if (!raw) return undefined;
  const allowed: VideoPurpose[] = ["cold", "follow_up", "appointment", "proposal"];
  if (!allowed.includes(raw as VideoPurpose)) {
    throw new Error(`invalid --purpose "${raw}" (use: ${allowed.join(", ")})`);
  }
  return raw as VideoPurpose;
}

async function cmdWeeklyReview() {
  await runWeeklyReview();
}

async function cmdMonthlyReview() {
  await runMonthlyReview();
}

async function cmdChat(p: Parsed) {
  const text = str(p.flags.text) || p._.join(" ");
  if (!text) throw new Error('usage: cli chat --text "how are we doing this week?"');
  const reply = await handleChat(text);
  // eslint-disable-next-line no-console
  console.log(`\n${reply}\n`);
}

async function cmdAgentCycle() {
  const out = await runAutonomousCycle();
  // eslint-disable-next-line no-console
  console.log(`\n${out}\n`);
}

async function cmdSourceLeads(p: Parsed) {
  const r = await sourceLeadsFromApollo({
    titles: csv(p.flags.titles),
    industries: csv(p.flags.industries),
    keywords: str(p.flags.keywords) || undefined,
    limit: int(p.flags.limit, 10),
  });
  log.info(`found ${r.found}, imported ${r.imported.length}`);
  for (const l of r.imported) log.info(`  ${l.email} — ${l.name ?? ""} @ ${l.company ?? ""}`);
}

async function cmdSourceLeadsApify(p: Parsed) {
  const r = await sourceLeadsFromApify({
    companyCountry: csv(p.flags["company-country"]),
    companyEmployeeSize: csv(p.flags["company-size"]),
    contactEmailStatus: str(p.flags["email-status"], "verified"),
    includeEmails: true,
    industry: csv(p.flags.industries),
    personCountry: csv(p.flags["person-country"]),
    personTitle: csv(p.flags.titles),
    totalResults: int(p.flags.limit, 100),
  });
  log.info(`apify run ${r.runId}: found ${r.found}, imported ${r.imported.length}, cost=$${r.costUsd ?? "unknown"}`);
  for (const l of r.imported.slice(0, 25)) log.info(`  ${l.email} — ${l.name ?? ""} @ ${l.company ?? ""}`);
  if (r.imported.length > 25) log.info(`  ...and ${r.imported.length - 25} more`);
}

async function cmdDiscoverLeads(p: Parsed) {
  const r = await discoverLeads({
    role: str(p.flags.role) || undefined,
    industry: str(p.flags.industry) || undefined,
    company: str(p.flags.company) || undefined,
    location: str(p.flags.location) || undefined,
    keywords: str(p.flags.keywords) || undefined,
    limit: int(p.flags.limit, 10),
  });
  log.info(`${r.searchResults} results → ${r.consideredPeople} people → imported ${r.imported.length}`);
  for (const l of r.imported) log.info(`  ${l.email} [${l.verdict}] — ${l.name} @ ${l.company}`);
}

async function cmdDiscoverBusinessContacts(p: Parsed) {
  const r = await discoverBusinessContacts({
    industry: str(p.flags.industry) || undefined,
    location: str(p.flags.location) || undefined,
    keywords: str(p.flags.keywords) || undefined,
    limit: int(p.flags.limit, 10),
    importGuessed: p.flags["import-guessed"] === true ? true : undefined,
    allowUnverified: p.flags["allow-unverified"] === true ? true : undefined,
  });
  log.info(`${r.searchResults} results → ${r.candidates} businesses → imported ${r.imported.length}`);
  for (const l of r.imported) {
    log.info(`  ${l.email} [${l.verdict}/${l.confidence}] — ${l.company} via ${l.evidenceUrl}`);
  }
}

async function cmdVerifyEmail(p: Parsed) {
  const email = str(p.flags.email);
  const candidates = email
    ? [email]
    : emailCandidates(str(p.flags.first), str(p.flags.last), str(p.flags.domain));
  if (!candidates.length) throw new Error('usage: cli verify-email --email <e>  OR  --first --last --domain');
  const r = await verifyBestEmail(candidates);
  log.info(`${r.email ?? "(none)"} → ${r.verdict}`);
}

async function cmdResearch(p: Parsed) {
  const email = str(p.flags.email);
  if (!email) throw new Error("usage: cli research --email <e>");
  const r = await researchLead(email);
  if (r) {
    log.info(`summary: ${r.summary}`);
    log.info(`hooks: ${r.hooks.join(" | ")}`);
  }
}

async function cmdDiscoverContractors(p: Parsed) {
  const r = await discoverContractors({
    trade: str(p.flags.trade) || str(p.flags.industry) || undefined,
    location: str(p.flags.location) || undefined,
    keywords: str(p.flags.keywords) || undefined,
    limit: int(p.flags.limit, 10),
    importGuessed: p.flags["import-guessed"] === true ? true : undefined,
    allowUnverified: p.flags["allow-unverified"] === true ? true : undefined,
  });
  log.info(`${r.searchResults} results → ${r.candidates} contractors → imported ${r.imported.length}`);
  for (const l of r.imported) {
    log.info(`  ${l.email} [${l.verdict}/${l.confidence}] — ${l.company} via ${l.evidenceUrl}`);
  }
}

async function cmdCrm(p: Parsed) {
  const rows = await buildCrmSnapshot();
  const status = str(p.flags.status);
  const filtered = status ? rows.filter((r) => r.status === status) : rows;
  printCrmTable(filtered);
}

async function cmdCrmExport(p: Parsed) {
  const rows = await buildCrmSnapshot();
  const file = str(p.flags.file, "crm-export.csv");
  writeFileSync(file, toCsv(rows), "utf-8");
  log.info(`exported ${rows.length} leads → ${file}`);
}

async function cmdProduceVideo(p: Parsed) {
  const id = p._[0] || str(p.flags.video);
  if (!id) throw new Error("usage: cli produce-video <videoId>");
  const asset = await produceVideo(id);
  log.info(`status: ${asset?.status} ${asset?.videoUrl ?? ""}`);
}

async function cmdPruneVideos(p: Parsed) {
  // Destructive, so it previews by default and needs --yes to actually delete
  // (npm swallows bare --flags, so an opt-in guard can't be trusted).
  const dryRun = !p.flags.yes;
  const days = int(p.flags.days, config.video.retentionDays);
  const res = await pruneOldVideos({ maxAgeDays: days, dryRun });
  log.info(
    `${res.dryRun ? "[dry run] would delete" : "deleted"} ${res.deleted} file(s), ` +
      `${(res.bytes / 1e6).toFixed(1)}MB; ${res.kept} kept (newer than ${days}d)`,
  );
  if (res.dryRun) log.info("nothing was removed — re-run with --yes to apply");
}

async function cmdApprovals() {
  const pending = await ApprovalsRepo.listPending();
  if (!pending.length) return log.info("no pending approvals");
  for (const a of pending) log.info(`  ${a._id}  ${a.summary}`);
}

async function cmdApprove(p: Parsed) {
  const id = p._[0];
  if (!id) throw new Error("usage: cli approve <approvalId>");
  const r = await executeApproval(id);
  log.info(r.ok ? `executed: ${r.result}` : `failed: ${r.result}`);
}

async function cmdDeny(p: Parsed) {
  const id = p._[0];
  if (!id) throw new Error("usage: cli deny <approvalId>");
  await denyApproval(id);
  log.info("denied");
}

// ── voice / cold calling ─────────────────────────────────────────────────────
async function cmdCallLead(p: Parsed) {
  const email = p._[0] || str(p.flags.email);
  if (!email) throw new Error('usage: cli call-lead <email> [--campaign <id>] [--at "2026-08-13T15:00:00"]');
  const lead = await LeadsRepo.getByEmail(email);
  if (!lead) throw new Error(`lead not found: ${email}`);

  const when = str(p.flags.at) ? new Date(str(p.flags.at)) : undefined;
  const res = await queueCall({ leadId: lead._id, campaignId: str(p.flags.campaign) || undefined, scheduledAt: when });
  if (!res.queued) throw new Error(`not queued — ${res.reason}`);
  log.info(`queued call ${res.callId} → ${lead.phone} (${lead.email})`);
  if (config.sending.dryRun) log.warn("DRY_RUN=true → the dialer will log the call instead of placing it");
  log.info("the dialer places it on the next run; force one now with: npm run cli dial");
}

async function cmdDial() {
  const r = await dialDue();
  log.info(`dialer: ${r.placed} placed, ${r.skipped} skipped`);
}

async function cmdCallSim(p: Parsed) {
  const email = p._[0] || str(p.flags.email);
  if (!email) {
    throw new Error(
      'usage: cli call-sim <email> [--persona "skeptical HVAC owner, mid-job"] [--offer "..."] [--turns 14]',
    );
  }
  const lead = await LeadsRepo.getByEmail(email);
  if (!lead) throw new Error(`lead not found: ${email}`);
  const campaign = str(p.flags.campaign) ? await ensureCampaign(str(p.flags.campaign)) : null;
  const persona = str(p.flags.persona) || undefined;

  // eslint-disable-next-line no-console
  console.log(
    `\n— simulated cold call to ${lead.name ?? lead.email} —\n` +
      (persona ? `prospect persona: ${persona}\n` : "type the prospect's replies; blank line or /end hangs up\n"),
  );
  const r = await simulateCall({
    lead,
    campaign: campaign ?? undefined,
    offer: str(p.flags.offer) || undefined,
    persona,
    maxTurns: int(p.flags.turns, 14),
    onTurn: (role, text) => {
      // eslint-disable-next-line no-console
      console.log(`${role === "agent" ? "🤖 agent" : "🧑 prospect"}: ${text}`);
    },
  });
  const call = await CallsRepo.getById(r.callId);
  // eslint-disable-next-line no-console
  console.log(
    `\n— result —\noutcome: ${call?.outcome}\nobjections: ${call?.objections.join(", ") || "none"}\n` +
      `asks: ${call?.askCount}\nsummary: ${call?.summary ?? ""}\nnext: ${call?.nextAction ?? ""}\n`,
  );
}

async function cmdCalls(p: Parsed) {
  const calls = await CallsRepo.list(
    { status: (str(p.flags.status) || undefined) as never, campaignId: str(p.flags.campaign) || undefined },
    int(p.flags.limit, 25),
  );
  if (!calls.length) return log.info("no calls yet");
  for (const c of calls) {
    const lead = await LeadsRepo.getById(c.leadId);
    log.info(
      `${c.createdAt.toISOString().slice(0, 16)} ${(lead?.email ?? c.leadId).padEnd(28)} ` +
        `${c.status.padEnd(12)} ${(c.outcome ?? "-").padEnd(18)} ${c.durationSec}s asks=${c.askCount} ` +
        `${c.objections.join(",") || "-"}${c.failureReason ? ` (${c.failureReason})` : ""}`,
    );
  }
}

async function cmdCallTranscript(p: Parsed) {
  const id = p._[0] || str(p.flags.call);
  if (!id) throw new Error("usage: cli call-transcript <callId>");
  const call = await CallsRepo.getById(id);
  if (!call) throw new Error(`call not found: ${id}`);
  const lead = await LeadsRepo.getById(call.leadId);
  // eslint-disable-next-line no-console
  console.log(
    `\n${lead?.email ?? call.leadId} — ${call.status}/${call.outcome ?? "?"} — ${call.durationSec}s\n` +
      `objections: ${call.objections.join(", ") || "none"} | asks: ${call.askCount}\n`,
  );
  for (const t of call.transcript) {
    // eslint-disable-next-line no-console
    console.log(`${t.role === "agent" ? "🤖" : "🧑"} ${t.text}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nsummary: ${call.summary ?? "(none)"}\nnext: ${call.nextAction ?? "(none)"}\n`);
}

/**
 * Call your own phone, end to end, and print what happened.
 *
 * The checks below run BEFORE anything dials, because every one of them fails
 * the same way from the handset — your phone rings and nobody is there — and
 * that is indistinguishable from a bug in the agent. Better to refuse with a
 * reason than to let you debug silence.
 */
async function cmdCallMe(p: Parsed) {
  const phone = normalizePhone(str(p.flags.phone) || p._[0]);
  if (!phone) {
    throw new Error('usage: cli call-me --phone "+15551234567" [--name Alex] [--email you@x.com] [--campaign <c>] [--wait 240]');
  }

  const problems: string[] = [];
  if (!config.voice.enabled) problems.push('VOICE_ENABLED is not true — set VOICE_ENABLED="true"');
  if (config.sending.dryRun) {
    problems.push('DRY_RUN is true — no real call is placed. Set DRY_RUN="false" for a live test');
  }

  // Check the carrier credentials directly rather than via getTelephony(): under
  // DRY_RUN the dry-run provider reports itself "configured", which would hide a
  // missing Twilio account until you flipped DRY_RUN off and tried again.
  const missingTwilio = (
    [
      ["TWILIO_ACCOUNT_SID", config.voice.twilio.accountSid],
      ["TWILIO_AUTH_TOKEN", config.voice.twilio.authToken],
      ["TWILIO_FROM_NUMBER", config.voice.twilio.fromNumber],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missingTwilio.length) {
    problems.push(`no carrier — set ${missingTwilio.join(", ")} (a voice-capable Twilio number)`);
  }
  const sigReady = signatureValidationReady();
  if (!sigReady.ready) problems.push(sigReady.reason!);

  const voice = await realtimeAuthCheck();
  if (!voice.ready) problems.push(`voice credentials: ${voice.reason}`);

  // The bridge lives in the tracking server, NOT in this CLI process. If that
  // host isn't running this build, Twilio connects the call to nothing.
  let bridgeOk = false;
  try {
    const res = await fetch(`${config.tracking.baseURL}/voice/health`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as { voiceEnabled?: boolean; model?: string };
    bridgeOk = res.ok && Boolean(body.voiceEnabled);
    if (!bridgeOk) {
      problems.push(
        `${config.tracking.baseURL}/voice/health did not report a live voice channel ` +
          `(HTTP ${res.status}) — that host must be running THIS build with VOICE_ENABLED=true`,
      );
    } else {
      log.info(`bridge reachable at ${config.tracking.baseURL} (model ${body.model})`);
    }
  } catch (err) {
    problems.push(
      `could not reach ${config.tracking.baseURL}/voice/health (${err instanceof Error ? err.message : String(err)}) — ` +
        `Twilio must be able to reach it too, so localhost will not work; deploy or use a tunnel`,
    );
  }

  if (problems.length) {
    log.error("cannot place a live test call yet:");
    for (const it of problems) log.error(`  ⛔ ${it}`);
    log.info("nothing was dialed. Rehearse the conversation meanwhile: npm run cli -- call-sim <email> --persona '...'");
    return;
  }

  // A real lead row, so the call runs the exact production path.
  const email = str(p.flags.email) || config.notify.email || config.mail.fromEmail;
  const lead = await LeadsRepo.upsertByEmail({
    email,
    phone,
    name: str(p.flags.name) || "Test Call",
    firstName: str(p.flags.name)?.split(" ")[0] || "there",
    timezone: str(p.flags.timezone) || undefined,
    source: "voice-selftest",
  });

  // A held-back call from an earlier attempt is still queued and still due, so
  // dialing now would place it alongside the new one — two simultaneous calls
  // to the same phone. Supersede them.
  const stale = await CallsRepo.cancelQueuedForLead(lead._id, "superseded by a newer call-me run");
  if (stale) log.info(`canceled ${stale} earlier queued call${stale === 1 ? "" : "s"} for this number`);

  const campaign = str(p.flags.campaign) ? await ensureCampaign(str(p.flags.campaign)) : null;
  const queued = await queueCall({ leadId: lead._id, campaignId: campaign?._id });
  if (!queued.queued) throw new Error(`not queued — ${queued.reason}`);
  log.info(`queued call ${queued.callId} → ${phone}; dialing now…`);

  const placed = await dialDue();
  if (!placed.placed) {
    const call = await CallsRepo.getById(queued.callId!);
    log.error(
      `the dialer did not place it (status=${call?.status}${call?.failureReason ? `, ${call.failureReason}` : ""}). ` +
        `If it is outside ${config.voice.dialing.windowStartHour}:00–${config.voice.dialing.windowEndHour}:00 local, ` +
        `re-run with VOICE_WINDOW_START_HOUR=0 VOICE_WINDOW_END_HOUR=24`,
    );
    return;
  }

  log.info("📞 your phone should ring — answer it and try to give the agent a hard time");
  const deadline = Date.now() + int(p.flags.wait, 240) * 1000;
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const call = await CallsRepo.getById(queued.callId!);
    if (!call) break;
    if (call.status !== last) {
      log.info(`  status: ${call.status}`);
      last = call.status;
    }
    if (["completed", "failed", "no_answer", "busy", "canceled"].includes(call.status)) {
      // Post-call analysis runs right after hangup; give it a moment to land.
      await new Promise((r) => setTimeout(r, 6000));
      const done = await CallsRepo.getById(queued.callId!);
      // eslint-disable-next-line no-console
      console.log(`\n── how it went ──\nstatus: ${done?.status}   outcome: ${done?.outcome ?? "(pending)"}`);
      // eslint-disable-next-line no-console
      console.log(`duration: ${done?.durationSec}s   asks: ${done?.askCount}   objections: ${done?.objections.join(", ") || "none"}`);
      for (const t of done?.transcript ?? []) {
        // eslint-disable-next-line no-console
        console.log(`${t.role === "agent" ? "🤖" : "🧑"} ${t.text}`);
      }
      // eslint-disable-next-line no-console
      console.log(`\nsummary: ${done?.summary ?? "(none)"}\nnext: ${done?.nextAction ?? "(none)"}\n`);
      return;
    }
  }
  log.warn(`still in progress after the wait window — check later: npm run cli -- call-transcript ${queued.callId}`);
}

async function cmdVoicePreflight(p: Parsed) {
  const lead = str(p.flags.lead) ? await LeadsRepo.getByEmail(str(p.flags.lead)) : null;
  const campaign = str(p.flags.campaign) ? await ensureCampaign(str(p.flags.campaign)) : null;
  const model = str(p.flags.model) || undefined;
  const voiceName = str(p.flags.voice) || undefined;

  log.info(`probing ${model ?? config.voice.realtime.model} (voice=${voiceName ?? config.voice.realtime.voice})…`);
  const r = await voicePreflightAutodetect({
    lead: lead ?? undefined,
    campaign: campaign ?? undefined,
    offer: str(p.flags.offer) || undefined,
    model,
    voice: voiceName,
  });

  if (!r.ok) {
    log.error(`voice preflight FAILED (${r.model}, schema=${r.schema}): ${r.error}`);
    return;
  }
  log.info(`✅ live voice session works — ${r.model}, schema=${r.schema}, voice=${r.voice}`);
  const a = r.applied;
  if (a) {
    // Echoed back by the server, so this is what is REALLY in force — an
    // unsupported audio setting is dropped silently rather than rejected.
    log.info(
      `   applied: voice=${a.voice} audio=${a.inputFormat}→${a.outputFormat} ` +
        `transcribe=${a.transcriptionModel} noise=${a.noiseReduction}`,
    );
    // semantic_vad carries an eagerness; server_vad carries the raw timings.
    log.info(
      a.eagerness
        ? `   turn-taking: ${a.vadType} eagerness=${a.eagerness}`
        : `   turn-taking: ${a.vadType} threshold=${a.vadThreshold} ` +
          `prefixPadding=${a.prefixPaddingMs}ms silence=${a.silenceMs}ms`,
    );
  }
  log.info(`   ${r.durationSec}s of audio (${r.audioBytes} bytes μ-law)`);
  if (r.humanizer) {
    log.info(
      `   humanizer: ${r.humanizer.enabled ? "on" : "off"} ` +
        `noise=${r.humanizer.comfortNoiseDb}dB drive=${r.humanizer.driveDb}dB clarity=${r.humanizer.clarityDb}dB ` +
        `fastStart=${r.humanizer.fastStart ? `${r.humanizer.fastStartRate}x/${r.humanizer.fastStartMs}ms` : "off"}`,
    );
  }
  if (r.transcript) log.info(`   opener: "${r.transcript}"`);
  if (r.wavPath) {
    log.info(`   listen: open "${r.wavPath}"`);
    log.info(`   details: ${r.wavPath.replace(/\.wav$/i, ".json")}`);
  }
}

async function cmdCallCheck(p: Parsed) {
  const email = p._[0] || str(p.flags.email);
  if (!email) throw new Error("usage: cli call-check <email>");
  const lead = await LeadsRepo.getByEmail(email);
  if (!lead) throw new Error(`lead not found: ${email}`);
  const gate = await canCall(lead);
  log.info(`${lead.email} phone=${normalizePhone(lead.phone) ?? "(none)"} tz=${lead.timezone ?? "(server)"}`);
  log.info(gate.allowed ? "✅ callable right now" : `⛔ blocked — ${gate.reason}: ${gate.detail}`);

  // The lead can be perfectly callable while the channel itself can't talk.
  const telephony = getTelephony();
  log.info(`telephony: ${telephony.name} ${telephony.configured() ? "✅" : "⛔ not configured"}`);
  const voice = await realtimeAuthCheck();
  log.info(
    voice.ready
      ? `voice model: ✅ ${config.voice.realtime.model} (auth=${voice.source}` +
        `${voice.minutesLeft !== undefined ? `, ${voice.minutesLeft} min left` : ""})`
      : `voice model: ⛔ ${voice.reason}`,
  );
  if (voice.warning) log.warn(voice.warning);
}

async function cmdCallScript(p: Parsed) {
  const email = p._[0] || str(p.flags.email);
  if (!email) throw new Error('usage: cli call-script <email> [--campaign <name|id>] [--offer "..."]');
  const lead = await LeadsRepo.getByEmail(email);
  if (!lead) throw new Error(`lead not found: ${email}`);
  const campaign = str(p.flags.campaign) ? await ensureCampaign(str(p.flags.campaign)) : null;
  // eslint-disable-next-line no-console
  console.log(
    buildCallInstructions({ lead, campaign: campaign ?? undefined, offer: str(p.flags.offer) || undefined }),
  );
}

async function cmdDnc(p: Parsed) {
  const phone = str(p.flags.add);
  if (phone) {
    const normalized = await addToDnc(phone, str(p.flags.reason, "operator request"), "operator");
    if (!normalized) throw new Error(`could not parse "${phone}" as a phone number`);
    return log.info(`added ${normalized} to the do-not-call list`);
  }
  const entries = await DncRepo.list(int(p.flags.limit, 50));
  if (!entries.length) return log.info("do-not-call list is empty");
  for (const e of entries) {
    log.info(`${e._id.padEnd(16)} ${e.source.padEnd(9)} ${e.createdAt.toISOString().slice(0, 10)} ${e.reason}`);
  }
}

const HELP = `AI SDR CLI
  init                          create indexes
  import-leads <csv>            import leads from CSV (header row required, must include 'email')
  add-lead --email ...          add/update one lead
  create-campaign --name --offer --persona [--from] [--sequence-file seq.json] [--active]
  list-campaigns
  activate-campaign <name|id>
  enroll --campaign <name|id> [--status new] [--limit 50] [--lead <email>]
  cancel-enrollments <name|id> [--yes] [--all] [--keep-messages]   stop a campaign's in-flight enrollments + queued follow-ups (previews unless --yes)
  dispatch [--ignore-window]    send due messages now
  rebalance-mailbox --to <mailbox> [--from <mailbox>] [--limit 5]   move safe queued first-touch sends
  llm-smoke [--role worker|strategist] [--prompt "..."]   test LLM auth/config
  process-events                score queued events now
  daily-cycle                   run the strategist review + generate variants now
  weekly-review                 industry/persona/variant review + prune now
  monthly-review                monthly totals + review now
  reply-drafts                  draft responses to fresh positive replies now (queues approvals)
  human-digest                  send the Monday operator digest now
  sync-meetings                 Calendly sync now: backfill booked, reminders, no-show recovery
  gen-variants --campaign [--step 1] [--count 3]   AI-generate A/B test variants
  list-variants --campaign      variant leaderboard
  prune-variants --campaign     retire underperforming variants
  make-pixel --email --subject --body [--campaign]  Gmail compose snippet (manual send)
  create-video --email [--offer] [--campaign] [--purpose]   create script + render MP4 in one command
  video-script --email [--offer] [--campaign] [--purpose]   generate a Loom/video script + tracked link
  produce-video <videoId>       run TTS + scene spec + Remotion render for a scripted video
  prune-videos [--days 30] [--yes]  delete rendered videos past the retention window (previews without --yes)
  chat --text "..."             ask the GLM agent (uses tools; high-risk = approval)
  agent-cycle                   run the autonomous daily brain now
  discover-leads --role "VP Ops" --industry "Healthcare" [--company --location --keywords --limit]   FREE sourcing
  discover-businesses --industry "HVAC" --location "Indianapolis, IN" [--keywords --limit --import-guessed --allow-unverified]
  discover-contractors --trade "roofing" --location "Austin, TX" [--keywords --limit --import-guessed --allow-unverified]   contractor-targeted sourcing
  crm [--status active|replied|meeting]                 live CRM table view (all leads + engagement stats)
  crm-export [--file leads.csv]                         export full CRM to CSV (default: crm-export.csv)
  verify-email --email <e> | --first --last --domain    check deliverability (MX + SMTP)
  source-leads --titles "VP Ops,COO" --industries "Healthcare" [--keywords] [--limit]   Apollo (paid)
  source-leads-apify [--limit 30000] [--titles "..."] [--industries "..."]   Apify actor (paid)
  research --email <e>          web-research a lead + save hooks
  call-lead <email> [--campaign <id>] [--at <iso>]   queue an AI cold call to one lead
  dial                          place due queued calls now (respects hours, caps, DNC)
  call-sim <email> [--persona "..."] [--offer "..."] [--turns 14]   rehearse the call in text, no phone needed
  calls [--status <s>] [--campaign <id>] [--limit 25]   recent calls + outcomes
  call-transcript <callId>      full turn-by-turn transcript of one call
  call-check <email>            dry-run the compliance gate for one lead
  voice-preflight [--model <m>] [--voice <v>] [--lead <e>]   open a REAL voice session, save the opener as WAV
  call-me --phone "+1555..." [--name] [--email] [--campaign] [--wait 240]   call YOUR phone end-to-end and print the transcript
  call-script <email> [--campaign <c>] [--offer "..."]   print the exact instructions the voice agent gets
  dnc [--add <phone> --reason "..."]   view or extend the do-not-call list
  approvals                     list pending approvals
  approve <id> | deny <id>      decide a pending approval
  ingest-reply --email --text [--message]   simulate an inbound reply
  poll-replies                  fetch + ingest replies over IMAP now
  hypotheses [--status testing|keep|reject]   list experiments + their results
  eval-hypotheses               score testing experiments → keep/reject now
  event --email --type <booked|showed|closed_won|...>   manually log an event
  status                        pipeline overview
  lead <email>                  inspect one lead`;

async function run() {
  const [, , cmd, ...rest] = process.argv;
  const p = parseArgs(rest);
  await ensureIndexes();
  switch (cmd) {
    case "init": log.info("indexes ready"); break;
    case "import-leads": await cmdImportLeads(p); break;
    case "add-lead": await cmdAddLead(p); break;
    case "create-campaign": await cmdCreateCampaign(p); break;
    case "list-campaigns": await cmdListCampaigns(); break;
    case "activate-campaign": await cmdActivateCampaign(p); break;
    case "enroll": await cmdEnroll(p); break;
    case "cancel-enrollments": await cmdCancelEnrollments(p); break;
    case "dispatch": await cmdDispatch(p); break;
    case "rebalance-mailbox": await cmdRebalanceMailbox(p); break;
    case "llm-smoke": await cmdLlmSmoke(p); break;
    case "process-events": await cmdProcessEvents(); break;
    case "daily-cycle": await cmdDailyCycle(); break;
    case "weekly-review": await cmdWeeklyReview(); break;
    case "monthly-review": await cmdMonthlyReview(); break;
    case "reply-drafts": {
      const { processReplyDrafts } = await import("../workers/reply-drafts.js");
      const r = await processReplyDrafts();
      log.info(`reply drafts: ${r.drafted} queued for approval, ${r.skipped} skipped`);
      break;
    }
    case "human-digest": {
      const { runHumanDigest } = await import("../workers/human-digest.js");
      console.log(await runHumanDigest());
      break;
    }
    case "sync-meetings": {
      const { syncMeetings } = await import("../workers/meeting-lifecycle.js");
      const r = await syncMeetings();
      log.info(
        `meetings: ${r.meetings} seen, ${r.bookedBackfilled} booked backfilled, ${r.remindersSent} reminders sent, ${r.noShowsRecorded} no-shows recorded`,
      );
      break;
    }
    case "gen-variants": await cmdGenVariants(p); break;
    case "list-variants": await cmdListVariants(p); break;
    case "prune-variants": await cmdPruneVariants(p); break;
    case "make-pixel": await cmdMakePixel(p); break;
    case "create-video": await cmdCreateVideo(p); break;
    case "video-script": await cmdVideoScript(p); break;
    case "produce-video": await cmdProduceVideo(p); break;
    case "prune-videos": await cmdPruneVideos(p); break;
    case "chat": await cmdChat(p); break;
    case "agent-cycle": await cmdAgentCycle(); break;
    case "discover-leads": await cmdDiscoverLeads(p); break;
    case "discover-businesses": await cmdDiscoverBusinessContacts(p); break;
    case "discover-contractors": await cmdDiscoverContractors(p); break;
    case "crm": await cmdCrm(p); break;
    case "crm-export": await cmdCrmExport(p); break;
    case "verify-email": await cmdVerifyEmail(p); break;
    case "source-leads": await cmdSourceLeads(p); break;
    case "source-leads-apify": await cmdSourceLeadsApify(p); break;
    case "research": await cmdResearch(p); break;
    case "call-lead": await cmdCallLead(p); break;
    case "dial": await cmdDial(); break;
    case "call-sim": await cmdCallSim(p); break;
    case "calls": await cmdCalls(p); break;
    case "call-transcript": await cmdCallTranscript(p); break;
    case "call-check": await cmdCallCheck(p); break;
    case "voice-preflight": await cmdVoicePreflight(p); break;
    case "call-me": await cmdCallMe(p); break;
    case "call-script": await cmdCallScript(p); break;
    case "dnc": await cmdDnc(p); break;
    case "approvals": await cmdApprovals(); break;
    case "approve": await cmdApprove(p); break;
    case "deny": await cmdDeny(p); break;
    case "ingest-reply": await cmdIngestReply(p); break;
    case "poll-replies": await cmdPollReplies(); break;
    case "hypotheses": await cmdHypotheses(p); break;
    case "eval-hypotheses": await cmdEvalHypotheses(); break;
    case "event": await cmdEvent(p); break;
    case "status": await cmdStatus(); break;
    case "lead": await cmdLead(p); break;
    default:
      // eslint-disable-next-line no-console
      console.log(HELP);
  }
}

/**
 * The OpenAI SDK reports an unreachable endpoint as the bare string
 * "Connection error.", which sends you hunting through the wrong code. The
 * usual cause here is a WORKER_BASE_URL pointing at the local OAuth harness
 * proxy, which only runs inside `npm start` — so a standalone CLI process has
 * nothing to talk to. Say that instead.
 */
function explainConnectionError(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string } })?.cause?.code ?? "";
  const looksLikeConnRefused =
    /connection error|ECONNREFUSED|fetch failed|ENOTFOUND/i.test(`${message} ${cause}`);
  if (!looksLikeConnRefused) return undefined;

  const lines = [
    `could not reach the LLM endpoint — ${message}`,
    `  worker:     ${worker.configured ? worker.route : "not configured"}`,
    `  strategist: ${strategist.configured ? strategist.route : "not configured"}`,
  ];
  if (/127\.0\.0\.1|localhost/.test(config.llm.worker.baseURL)) {
    lines.push(
      `  WORKER_BASE_URL points at a local proxy (${config.llm.worker.baseURL}).`,
      `  That proxy is started by \`npm start\`, not by the CLI — run \`npm start\` in`,
      `  another terminal, or point WORKER_BASE_URL/WORKER_API_KEY at a hosted endpoint.`,
    );
  }
  return lines.join("\n");
}

run()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    log.error(explainConnectionError(err) ?? (err instanceof Error ? err.message : String(err)));
    await closeDb();
    process.exit(1);
  });
