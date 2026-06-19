import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import { getUpdates, sendMessage, answerCallbackQuery, type TelegramUpdate } from "./telegram-client.js";
import { handleChat, resetChat } from "../agent/agent.js";
import { executeApproval, denyApproval } from "../agent/approvals.js";
import { ApprovalsRepo } from "../repositories/index.js";

const log = createLogger("telegram-bot");

let offset = 0;
let running = false;

/** Start the two-way Telegram bot (long-polling — no public URL needed). */
export async function startTelegramBot(): Promise<void> {
  if (!config.telegram.botToken) {
    log.warn("TELEGRAM_BOT_TOKEN not set — chat bot disabled");
    return;
  }
  running = true;
  await sendMessage("🤖 SDR agent online. Talk to me, or try /status, /pending, /reset.");
  void pollLoop();
  log.info("telegram bot started");
}

export function stopTelegramBot(): void {
  running = false;
}

async function pollLoop(): Promise<void> {
  while (running) {
    const updates = await getUpdates(offset);
    for (const u of updates) {
      offset = u.update_id + 1;
      try {
        await handleUpdate(u);
      } catch (err) {
        log.error("update handler failed", err);
      }
    }
  }
}

async function handleUpdate(u: TelegramUpdate): Promise<void> {
  if (u.callback_query) {
    const cq = u.callback_query;
    const [action, id] = (cq.data ?? "").split(":");
    if (action === "approve") {
      const r = await executeApproval(id);
      await answerCallbackQuery(cq.id, r.ok ? "Approved ✅" : "Failed");
      await sendMessage(r.ok ? `✅ Approved & executed:\n${r.result}` : `⚠️ Execution failed:\n${r.result}`);
    } else if (action === "deny") {
      await denyApproval(id);
      await answerCallbackQuery(cq.id, "Denied");
      await sendMessage("❌ Denied — no action taken.");
    }
    return;
  }

  const msg = u.message;
  if (!msg?.text) return;

  // If a chat id is configured, only respond to that chat (lock to the owner).
  if (config.telegram.chatId && String(msg.chat.id) !== String(config.telegram.chatId)) {
    log.warn(`ignoring message from unauthorized chat ${msg.chat.id}`);
    return;
  }

  const text = msg.text.trim();
  if (text === "/reset") {
    resetChat();
    await sendMessage("🧹 Conversation reset.");
    return;
  }
  if (text === "/start") {
    await sendMessage("Hi! I run your outbound. Ask me anything (e.g. \"how are we doing this week?\") or tell me what to do.");
    return;
  }
  if (text === "/pending") {
    const pending = await ApprovalsRepo.listPending();
    if (!pending.length) {
      await sendMessage("No pending approvals.");
    } else {
      for (const a of pending) {
        await sendMessage(`🔐 ${a.summary}`, {
          buttons: [[
            { text: "✅ Approve", data: `approve:${a._id}` },
            { text: "❌ Deny", data: `deny:${a._id}` },
          ]],
        });
      }
    }
    return;
  }

  const reply = await handleChat(text);
  await sendMessage(reply || "(no reply)");
}
