import { createLogger } from "../lib/logger.js";
import { ApprovalsRepo } from "../repositories/index.js";
import { getTool } from "./tools/index.js";
import { sendMessage } from "../chat/telegram-client.js";
import type { Approval } from "../models/types.js";

const log = createLogger("approvals");
const APPROVAL_PREVIEW_LIMIT = 3200;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Keep Telegram approval cards readable even when the stored args contain full files. */
export function formatApprovalMessage(a: Pick<Approval, "_id" | "tool" | "args" | "summary">): string {
  if (a.tool === "propose_code_change") {
    const title = typeof a.args.title === "string" ? a.args.title : "Code change";
    const description = typeof a.args.description === "string" ? a.args.description : "";
    const changes = Array.isArray(a.args.changes) ? a.args.changes : [];
    const files = changes
      .map((change) => {
        if (!change || typeof change !== "object" || !("path" in change)) return "";
        return typeof change.path === "string" ? change.path : "";
      })
      .filter(Boolean);
    return truncate(
      `🔐 Approval needed: code PR\n\n${title}\n\n${description}` +
        `${files.length ? `\n\nFiles (${files.length}):\n${files.map((file) => `- ${file}`).join("\n")}` : ""}` +
        `\n\nApproval ID: ${a._id}`,
      APPROVAL_PREVIEW_LIMIT,
    );
  }

  return truncate(`🔐 Approval needed\n\n${a.summary}\n\nApproval ID: ${a._id}`, APPROVAL_PREVIEW_LIMIT);
}

/** Persist a pending high-risk action and ping the human (Telegram buttons). */
export async function requestApproval(
  tool: string,
  args: Record<string, unknown>,
  summary: string,
  chatId?: string,
): Promise<Approval> {
  const a = await ApprovalsRepo.create(tool, args, summary);
  await sendMessage(formatApprovalMessage(a), {
    chatId,
    buttons: [[
      { text: "✅ Approve", data: `approve:${a._id}` },
      { text: "❌ Deny", data: `deny:${a._id}` },
    ]],
  });
  log.info(`approval requested: ${tool} (${a._id})`);
  return a;
}

/** Run a previously-approved action. */
export async function executeApproval(id: string): Promise<{ ok: boolean; result: string }> {
  const a = await ApprovalsRepo.getById(id);
  if (!a) return { ok: false, result: "approval not found" };
  if (a.status !== "pending") return { ok: false, result: `already ${a.status}` };

  const tool = getTool(a.tool);
  if (!tool) {
    await ApprovalsRepo.setStatus(id, "failed", "unknown tool");
    return { ok: false, result: "unknown tool" };
  }

  await ApprovalsRepo.setStatus(id, "approved");
  try {
    const result = await tool.run(a.args, { source: "approval" });
    const resultStr = JSON.stringify(result).slice(0, 800);
    await ApprovalsRepo.setStatus(id, "executed", resultStr);
    log.info(`executed approval ${id} (${a.tool})`);
    return { ok: true, result: resultStr };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ApprovalsRepo.setStatus(id, "failed", msg);
    log.error(`approval ${id} failed`, err);
    return { ok: false, result: msg };
  }
}

export async function denyApproval(id: string): Promise<void> {
  await ApprovalsRepo.setStatus(id, "denied");
  log.info(`denied approval ${id}`);
}
