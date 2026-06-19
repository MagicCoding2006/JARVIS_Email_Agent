import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { createLogger } from "../lib/logger.js";
import { closeDb } from "../lib/mongo.js";
import { ensureIndexes } from "../repositories/collections.js";
import {
  CampaignsRepo,
  EnrollmentsRepo,
  EventsRepo,
  LeadsRepo,
  MessagesRepo,
} from "../repositories/index.js";
import { DEFAULT_SEQUENCE } from "../services/sequences/default-sequence.js";
import { enrollLead } from "../services/sequencer.service.js";
import { dispatchDue } from "../workers/dispatcher.js";
import { processEvents } from "../workers/event-processor.js";
import { runDailyCycle } from "../workers/daily-cycle.js";
import { runWeeklyReview } from "../workers/weekly-review.js";
import { runMonthlyReview } from "../workers/monthly-review.js";
import { handleInboundReply } from "../services/replies.service.js";
import { createGmailPixel } from "../services/compose.service.js";
import { generateVariants, variantLeaderboard, pruneVariants, ensureCampaign } from "../services/variants.service.js";
import { createVideoForLead, produceVideo } from "../services/video.service.js";
import { researchLead } from "../services/research.service.js";
import { sourceLeadsFromApollo } from "../services/apollo.service.js";
import { sourceLeadsFromApify } from "../services/apify.service.js";
import { discoverLeads } from "../services/discovery.service.js";
import { discoverBusinessContacts, discoverContractors } from "../services/business-discovery.service.js";
import { buildCrmSnapshot, toCsv, printCrmTable } from "../services/crm.service.js";
import { emailCandidates, verifyBestEmail } from "../lib/email-verify.js";
import { handleChat } from "../agent/agent.js";
import { runAutonomousCycle } from "../workers/autonomous-cycle.js";
import { executeApproval, denyApproval } from "../agent/approvals.js";
import { ApprovalsRepo } from "../repositories/index.js";
import type { EventType, LeadStatus } from "../models/types.js";

const csv = (v: string | boolean | undefined) =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

const log = createLogger("cli");

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
    "email", "name", "firstname", "lastname", "title", "company",
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
  if (!email) throw new Error("usage: cli add-lead --email <e> [--name --company --title --industry]");
  const lead = await LeadsRepo.upsertByEmail({
    email,
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
    throw new Error('usage: cli create-campaign --name "X" --offer "..." --persona "..." [--from email] [--active]');
  }
  const existing = await CampaignsRepo.getByName(name);
  if (existing) {
    log.warn(`campaign "${name}" already exists (${existing._id})`);
    return;
  }
  const c = await CampaignsRepo.create({
    name,
    offer,
    targetPersona: persona,
    fromEmail: str(p.flags.from) || undefined,
    sequence: DEFAULT_SEQUENCE,
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

async function cmdProcessEvents() {
  const r = await processEvents();
  log.info(`processed ${r.processed} events`);
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
  const offer = str(p.flags.offer);
  if (!email || !offer) throw new Error('usage: cli video-script --email <e> --offer "..." [--campaign <id>]');
  const asset = await createVideoForLead({ leadEmail: email, offer, campaignId: str(p.flags.campaign) || undefined });
  if (!asset) return;
  log.info(`watch URL: ${asset.watchUrl}`);
  log.info(`hook: ${asset.hook}`);
  // eslint-disable-next-line no-console
  console.log(`\n--- script ---\n${asset.script}\n`);
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

const HELP = `AI SDR CLI
  init                          create indexes
  import-leads <csv>            import leads from CSV (header row required, must include 'email')
  add-lead --email ...          add/update one lead
  create-campaign --name --offer --persona [--from] [--active]
  list-campaigns
  activate-campaign <name|id>
  enroll --campaign <name|id> [--status new] [--limit 50] [--lead <email>]
  dispatch [--ignore-window]    send due messages now
  process-events                score queued events now
  daily-cycle                   run the strategist review + generate variants now
  weekly-review                 industry/persona/variant review + prune now
  monthly-review                monthly totals + review now
  gen-variants --campaign [--step 1] [--count 3]   AI-generate A/B test variants
  list-variants --campaign      variant leaderboard
  prune-variants --campaign     retire underperforming variants
  make-pixel --email --subject --body [--campaign]  Gmail compose snippet (manual send)
  video-script --email --offer [--campaign]         generate a Loom/video script + tracked link
  produce-video <videoId>       run TTS + scene spec + Remotion render for a scripted video
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
  approvals                     list pending approvals
  approve <id> | deny <id>      decide a pending approval
  ingest-reply --email --text [--message]   simulate an inbound reply
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
    case "dispatch": await cmdDispatch(p); break;
    case "process-events": await cmdProcessEvents(); break;
    case "daily-cycle": await cmdDailyCycle(); break;
    case "weekly-review": await cmdWeeklyReview(); break;
    case "monthly-review": await cmdMonthlyReview(); break;
    case "gen-variants": await cmdGenVariants(p); break;
    case "list-variants": await cmdListVariants(p); break;
    case "prune-variants": await cmdPruneVariants(p); break;
    case "make-pixel": await cmdMakePixel(p); break;
    case "video-script": await cmdVideoScript(p); break;
    case "produce-video": await cmdProduceVideo(p); break;
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
    case "approvals": await cmdApprovals(); break;
    case "approve": await cmdApprove(p); break;
    case "deny": await cmdDeny(p); break;
    case "ingest-reply": await cmdIngestReply(p); break;
    case "event": await cmdEvent(p); break;
    case "status": await cmdStatus(); break;
    case "lead": await cmdLead(p); break;
    default:
      // eslint-disable-next-line no-console
      console.log(HELP);
  }
}

run()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    log.error(err instanceof Error ? err.message : String(err));
    await closeDb();
    process.exit(1);
  });
