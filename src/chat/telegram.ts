import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";
import {
  getUpdates,
  sendMessage,
  sendVoice,
  answerCallbackQuery,
  TTS_CALLBACK,
  type TelegramUpdate,
} from "./telegram-client.js";
import { getTts, toSpeech } from "../services/tts/index.js";
import { handleChat, resetChat } from "../agent/agent.js";
import { executeApproval, denyApproval, formatApprovalMessage } from "../agent/approvals.js";
import { ApprovalsRepo } from "../repositories/index.js";
import { strategist, worker } from "../llm/roles.js";

const log = createLogger("telegram-bot");

let offset = 0;
let running = false;

function csvSet(value: string): Set<string> {
  return new Set(value.split(",").map((v) => v.trim()).filter(Boolean));
}

function isAuthorized(chatId?: number | string, userId?: number | string): boolean {
  const configuredChatId = config.telegram.chatId ? String(config.telegram.chatId) : "";
  const allowedChatIds = csvSet(config.telegram.allowedChatIds);
  const allowedUserIds = csvSet(config.telegram.allowedUserIds);
  const hasRestrictions = Boolean(configuredChatId) || allowedChatIds.size > 0 || allowedUserIds.size > 0;

  if (!hasRestrictions) return true;
  if (chatId !== undefined) {
    const chat = String(chatId);
    if (configuredChatId && chat === configuredChatId) return true;
    if (allowedChatIds.has(chat)) return true;
  }
  if (userId !== undefined && allowedUserIds.has(String(userId))) return true;
  return false;
}

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

/**
 * 🔊 tap → read the message the button is attached to out loud.
 *
 * Telegram returns the source message inside the callback, so no text cache is
 * needed — but it strips the content of messages older than ~48h, which shows
 * up here as a missing `text`.
 */
async function handleVoiceRequest(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const chatId = cq.message?.chat.id !== undefined ? String(cq.message.chat.id) : undefined;
  const tts = getTts();
  if (!tts) {
    await answerCallbackQuery(cq.id, "Voice is turned off");
    return;
  }
  const source = cq.message?.text;
  if (!source) {
    await answerCallbackQuery(cq.id, "That message is too old to read aloud");
    return;
  }
  const text = toSpeech(source, config.tts.maxChars);
  if (!text) {
    await answerCallbackQuery(cq.id, "Nothing here to read");
    return;
  }
  // Acknowledge before synthesizing: Telegram expires the callback in ~15s and
  // leaves the button spinning until it's answered.
  await answerCallbackQuery(cq.id, "Generating audio…");
  try {
    const { ogg } = await tts.synthesize(text);
    await sendVoice(ogg, { chatId, replyToMessageId: cq.message?.message_id });
  } catch (err) {
    log.error("tts failed", err);
    await sendMessage("⚠️ Couldn't generate the audio for that one.", { chatId });
  }
}

async function handleUpdate(u: TelegramUpdate): Promise<void> {
  if (u.callback_query) {
    const cq = u.callback_query;
    const callbackChatId = cq.message?.chat.id;
    if (!isAuthorized(callbackChatId, cq.from?.id)) {
      log.warn(`ignoring callback from unauthorized user ${cq.from?.id ?? "unknown"}`);
      await answerCallbackQuery(cq.id, "Unauthorized");
      return;
    }
    const [action, id] = (cq.data ?? "").split(":");
    if (action === TTS_CALLBACK) {
      // Deliberately not awaited: synthesis is CPU-bound and runs ~1.5x
      // realtime, and pollLoop processes updates one at a time — awaiting here
      // would make the bot ignore you for the length of the clip. The engine
      // serializes its own work, so overlapping taps still queue safely.
      void handleVoiceRequest(cq).catch((err) => log.error("voice request failed", err));
      return;
    }
    if (action === "approve") {
      const r = await executeApproval(id);
      await answerCallbackQuery(cq.id, r.ok ? "Approved ✅" : "Failed");
      await sendMessage(r.ok ? `✅ Approved & executed:\n${r.result}` : `⚠️ Execution failed:\n${r.result}`, {
        chatId: callbackChatId !== undefined ? String(callbackChatId) : undefined,
      });
    } else if (action === "deny") {
      await denyApproval(id);
      await answerCallbackQuery(cq.id, "Denied");
      await sendMessage("❌ Denied — no action taken.", {
        chatId: callbackChatId !== undefined ? String(callbackChatId) : undefined,
      });
    }
    return;
  }

  const msg = u.message;
  if (!msg?.text) return;

  if (!isAuthorized(msg.chat.id, msg.from?.id)) {
    log.warn(`ignoring message from unauthorized chat ${msg.chat.id} user ${msg.from?.id ?? "unknown"}`);
    return;
  }

  const chatId = String(msg.chat.id);
  const sessionId = `telegram:${chatId}`;
  const text = msg.text.trim();
  if (text === "/reset") {
    resetChat(sessionId);
    await sendMessage("🧹 Conversation reset.", { chatId });
    return;
  }
  if (text === "/start") {
    await sendMessage("Hi! I run your outbound. Ask me anything (e.g. \"how are we doing this week?\") or tell me what to do. Use /llm to verify model routing.", { chatId });
    return;
  }
  if (text === "/llm") {
    await sendMessage(`Strategist/chat: ${strategist.route}\nWorker/email generation: ${worker.route}`, { chatId });
    return;
  }
  if (text === "/pending") {
    const pending = await ApprovalsRepo.listPending();
    if (!pending.length) {
      await sendMessage("No pending approvals.", { chatId });
    } else {
      for (const a of pending) {
        await sendMessage(formatApprovalMessage(a), {
          chatId,
          buttons: [[
            { text: "✅ Approve", data: `approve:${a._id}` },
            { text: "❌ Deny", data: `deny:${a._id}` },
          ]],
        });
      }
    }
    return;
  }

  try {
    const reply = await handleChat(text, sessionId, chatId);
    await sendMessage(reply || "(no reply)", { chatId, voice: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/No tool call found for function call output with call_id/i.test(message)) {
      resetChat(sessionId);
      log.warn(`reset malformed tool history for ${sessionId}`);
      await sendMessage(
        "The conversation's tool history became invalid, so I reset this chat session. Please resend your last message.",
        { chatId },
      );
      return;
    }
    throw err;
  }
}
