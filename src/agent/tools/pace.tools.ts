import { schema, type Tool } from "./types.js";
import { config } from "../../config/index.js";
import { getSendPace, setSendPace, resetSendPace } from "../../services/send-pace.service.js";

export const getSendPaceTool: Tool = {
  name: "get_send_pace",
  description:
    "Get the current effective sending pace (max sends per dispatch run, and today's total send ceiling), plus the hard limits you can never exceed.",
  risk: "low",
  parameters: schema({}),
  async run() {
    const pace = await getSendPace();
    return {
      current: pace,
      hardCeilings: {
        maxPerRun: config.agent.maxPerRunCeiling,
        dailyCeiling: config.agent.dailySendCeiling,
      },
      note:
        "Real sends are further bounded by per-mailbox warmup caps and maxPerRecipientDomainPerDay " +
        `(currently ${config.sending.maxPerRecipientDomainPerDay || "disabled"}/day/domain) — you cannot change either of those.`,
    };
  },
};

export const setSendPaceTool: Tool = {
  name: "set_send_pace",
  description:
    "Tune sending aggressiveness: max sends per dispatch cycle (~every 5 min) and/or the total daily send ceiling. " +
    "Values are silently clamped to operator-set hard ceilings (get_send_pace shows them) and are still further bounded by " +
    "per-mailbox warmup caps and the per-recipient-domain cap, neither of which you can change. " +
    "Speed up when reply/open quality is strong; pull back when it degrades. Always give a reason. LOW RISK — bounded and reversible.",
  risk: "low",
  parameters: schema(
    {
      maxPerRun: { type: "number", description: "New max sends per dispatch cycle" },
      dailyCeiling: { type: "number", description: "New total sends allowed per day across all mailboxes" },
      reset: { type: "boolean", description: "If true, clear any override and revert to the operator's defaults" },
      reason: { type: "string", description: "Why you're changing the pace" },
    },
    ["reason"],
  ),
  async run(args: { maxPerRun?: number; dailyCeiling?: number; reset?: boolean; reason: string }, ctx) {
    if (args.reset) {
      const pace = await resetSendPace();
      return { applied: pace, reset: true };
    }
    if (args.maxPerRun === undefined && args.dailyCeiling === undefined) {
      return { error: "provide maxPerRun and/or dailyCeiling, or reset: true" };
    }
    const pace = await setSendPace({
      maxPerRun: args.maxPerRun,
      dailyCeiling: args.dailyCeiling,
      reason: args.reason,
      updatedBy: ctx.source,
    });
    return { applied: pace, note: "Values were clamped to the operator's hard ceilings if they exceeded them." };
  },
};
