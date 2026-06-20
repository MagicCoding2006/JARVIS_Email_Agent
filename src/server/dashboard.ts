import { Router, type Request, type Response } from "express";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { buildCrmSnapshot, buildCrmPage, toCsv } from "../services/crm.service.js";
import { buildDashboardAnalytics } from "../services/analytics.service.js";
import { allCapacities, getMailboxes } from "../services/sender/mailbox.js";
import { checkSendingHealth } from "../services/sending-health.service.js";
import { LeadsRepo, CampaignsRepo, HypothesesRepo } from "../repositories/index.js";
import { enrollLead } from "../services/sequencer.service.js";
import { dispatchDue } from "../workers/dispatcher.js";
import { config } from "../config/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let dashboardHtml: string;

function getHtml(): string {
  if (!dashboardHtml) {
    dashboardHtml = readFileSync(join(__dirname, "dashboard.html"), "utf-8");
  }
  return dashboardHtml;
}

export function createDashboardRouter(): Router {
  const router = Router();

  // ── Dashboard HTML ──────────────────────────────────────────────────────────
  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(getHtml());
  });

  // ── Pipeline stats ──────────────────────────────────────────────────────────
  router.get("/api/stats", async (_req: Request, res: Response) => {
    try {
      const [total, newLeads, active, replied, meetings, won, hot, health] = await Promise.all([
        LeadsRepo.count(),
        LeadsRepo.count({ status: "new" }),
        LeadsRepo.count({ status: "active" }),
        LeadsRepo.count({ status: "replied" }),
        LeadsRepo.count({ status: "meeting" }),
        LeadsRepo.count({ status: "won" }),
        LeadsRepo.count({ score: { $gte: 70 } } as Record<string, unknown>),
        checkSendingHealth(),
      ]);
      res.json({
        total, newLeads, active, replied, meetings, won, hot,
        dryRun: config.sending.dryRun,
        dailyLimit: config.sending.dailyLimit,
        bounceRatePct: health.bounceRatePct,
        sendingPaused: !health.healthy && !config.sending.dryRun,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── CRM table data (paginated) ──────────────────────────────────────────────
  router.get("/api/crm", async (req: Request, res: Response) => {
    try {
      const page = await buildCrmPage({
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 50,
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        search: typeof req.query.search === "string" ? req.query.search : undefined,
      });
      res.json(page);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Mailbox pool: warmup + rotation status ──────────────────────────────────
  router.get("/api/mailboxes", async (_req: Request, res: Response) => {
    try {
      const caps = await allCapacities();
      const rows = getMailboxes().map((mb) => {
        const c = caps.get(mb.email);
        return {
          email: mb.email,
          warmup: mb.warmup,
          warmupDay: c?.warmupDay ?? 0,
          cap: c?.cap ?? mb.dailyCap,
          sentToday: c?.sentToday ?? 0,
          remaining: c?.remaining ?? 0,
        };
      });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Hypotheses / experiments (the learning loop) ────────────────────────────
  router.get("/api/hypotheses", async (_req: Request, res: Response) => {
    try {
      const [counts, recent] = await Promise.all([
        HypothesesRepo.countsByStatus(),
        HypothesesRepo.list(),
      ]);
      res.json({
        counts,
        recent: recent.slice(0, 30).map((h) => ({
          idea: h.idea,
          status: h.status,
          result: h.result ?? "",
          updatedAt: h.updatedAt,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Analytics bundle (Overview tab) ─────────────────────────────────────────
  router.get("/api/analytics", async (req: Request, res: Response) => {
    try {
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
      const data = await buildDashboardAnalytics(days);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── CSV export (browser download) ───────────────────────────────────────────
  router.get("/api/crm/export", async (_req: Request, res: Response) => {
    try {
      const rows = await buildCrmSnapshot();
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="leads-crm-${Date.now()}.csv"`);
      res.send(toCsv(rows));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Campaigns list ──────────────────────────────────────────────────────────
  router.get("/api/campaigns", async (_req: Request, res: Response) => {
    try {
      const campaigns = await CampaignsRepo.list();
      res.json(campaigns);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Discover contractors — SSE streaming ────────────────────────────────────
  // Spawns the CLI as a child process and streams its log output line-by-line.
  router.post("/api/discover", (req: Request, res: Response) => {
    const { trade = "contractor", location = "", limit = 5, allowUnverified = false } = req.body ?? {};

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (type: string, payload: Record<string, unknown> = {}) => {
      res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    };

    const cliPath = join(process.cwd(), "src", "cli", "index.ts");
    const tsxPath = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

    const args = [
      tsxPath, cliPath,
      "discover-contractors",
      "--trade", String(trade),
      "--limit", String(Math.min(Number(limit) || 5, 25)),
      "--import-guessed",
    ];
    if (location) args.push("--location", String(location));
    if (allowUnverified) args.push("--allow-unverified");

    const child = spawn(process.execPath, args, {
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0", NO_COLOR: "1", FORCE_COLOR: "0" },
      cwd: process.cwd(),
    });

    const onData = (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) send("log", { text: line });
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("close", (code) => {
      send("done", { code: code ?? 0 });
      res.end();
    });

    child.on("error", (err) => {
      send("error", { text: err.message });
      res.end();
    });

    req.on("close", () => {
      try { child.kill(); } catch { /* ignore */ }
    });
  });

  // ── Enroll new leads into a campaign ────────────────────────────────────────
  router.post("/api/enroll", async (req: Request, res: Response) => {
    const { campaignId } = req.body ?? {};
    if (!campaignId) return res.status(400).json({ error: "campaignId required" });
    try {
      const leads = await LeadsRepo.list({ status: "new" }, 200);
      let enrolled = 0;
      for (const lead of leads) {
        const r = await enrollLead(lead._id, campaignId);
        if (r.created) enrolled++;
      }
      return res.json({ ok: true, enrolled, total: leads.length });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  // ── Dispatch due messages ───────────────────────────────────────────────────
  router.post("/api/dispatch", async (_req: Request, res: Response) => {
    try {
      const result = await dispatchDue({ ignoreWindow: true });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
