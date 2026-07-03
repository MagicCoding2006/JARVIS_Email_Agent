import { schema, type Tool } from "./types.js";
import { config } from "../../config/index.js";
import { startOfDay } from "../../lib/time.js";
import { EnrollmentsRepo, LeadsRepo, MessagesRepo } from "../../repositories/index.js";
import { allCapacities } from "../../services/sender/mailbox.js";
import { enrollLead } from "../../services/sequencer.service.js";
import { ensureCampaign } from "../../services/variants.service.js";
import type { LeadStatus } from "../../models/types.js";

export const getPipelineInventory: Tool = {
  name: "get_pipeline_inventory",
  description:
    "The funnel-feeding dashboard: unenrolled lead counts, active enrollments, today's mailbox capacity, scheduled backlog, " +
    "and your remaining auto_enroll budget for today. Check this every cycle to keep the machine fed.",
  risk: "low",
  parameters: schema({}),
  async run() {
    const todayStart = startOfDay(new Date());
    const [newLeads, activeEnrollments, enrolledToday, caps, due, discoveredToday] = await Promise.all([
      LeadsRepo.count({ status: "new" }),
      EnrollmentsRepo.listActive().then((l) => l.length),
      EnrollmentsRepo.countEnrolledSince(todayStart),
      allCapacities(),
      MessagesRepo.getDue(500).then((m) => m.length),
      LeadsRepo.count({ source: "discovery", createdAt: { $gte: todayStart } }),
    ]);
    let capacityToday = 0;
    for (const c of caps.values()) capacityToday += c.remaining;
    return {
      unenrolledNewLeads: newLeads,
      activeEnrollments,
      messagesDueNow: due,
      mailboxCapacityRemainingToday: capacityToday,
      autoEnroll: {
        enrolledToday,
        remainingBudgetToday: Math.max(0, config.agent.autoEnrollPerDay - enrolledToday),
        dailyCap: config.agent.autoEnrollPerDay,
      },
      discovery: {
        importedToday: discoveredToday,
        remainingBudgetToday: Math.max(0, config.agent.autoDiscoverPerDay - discoveredToday),
        dailyCap: config.agent.autoDiscoverPerDay,
      },
    };
  },
};

export const autoEnroll: Tool = {
  name: "auto_enroll",
  description:
    "Enroll leads into an ALREADY-ACTIVE campaign, bounded by a hard daily enrollment budget (see get_pipeline_inventory). " +
    "Use this to keep the funnel fed day-to-day. For launching new campaigns or bulk pushes beyond the budget, use enroll_leads (approval-gated).",
  risk: "low",
  parameters: schema(
    {
      campaign: { type: "string", description: "Name or id of an ACTIVE campaign" },
      status: { type: "string", description: "Lead status to enroll (default 'new')" },
      limit: { type: "number", description: "Max leads to enroll (further capped by today's remaining budget)" },
    },
    ["campaign"],
  ),
  async run(args: { campaign: string; status?: string; limit?: number }) {
    const c = await ensureCampaign(args.campaign);
    if (!c) return { error: `campaign not found: ${args.campaign}` };
    if (c.status !== "active") {
      return { error: `campaign "${c.name}" is ${c.status} — auto_enroll only feeds ACTIVE campaigns; activating one needs approval (set_campaign_status)` };
    }

    const enrolledToday = await EnrollmentsRepo.countEnrolledSince(startOfDay(new Date()));
    const budget = Math.max(0, config.agent.autoEnrollPerDay - enrolledToday);
    if (budget <= 0) {
      return { error: `today's auto-enroll budget (${config.agent.autoEnrollPerDay}) is spent — try again tomorrow or ask the operator to raise AGENT_AUTO_ENROLL_PER_DAY` };
    }

    const take = Math.min(args.limit ?? budget, budget);
    const leads = await LeadsRepo.list({ status: (args.status ?? "new") as LeadStatus }, take);
    let created = 0;
    for (const l of leads) {
      const r = await enrollLead(l._id, c._id);
      if (r.created) created++;
    }
    return { campaign: c.name, enrolled: created, considered: leads.length, budgetRemaining: budget - created };
  },
};
