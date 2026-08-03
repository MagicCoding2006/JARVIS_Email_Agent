import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("telegram");

const api = (method: string) => `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;

export function telegramEnabled(): boolean {
  return Boolean(config.telegram.botToken);
}

export interface InlineButton {
  text: string;
  data: string;
}

const TELEGRAM_TEXT_LIMIT = 4000;

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_TEXT_LIMIT) {
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_TEXT_LIMIT);
    if (splitAt < TELEGRAM_TEXT_LIMIT / 2) splitAt = TELEGRAM_TEXT_LIMIT;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

async function sendMessageChunk(text: string, opts: { chatId?: string; buttons?: InlineButton[][] }): Promise<void> {
  const chat_id = opts.chatId ?? config.telegram.chatId;
  if (!chat_id) return;
  const body: Record<string, unknown> = { chat_id, text, disable_web_page_preview: true };
  if (opts.buttons) {
    body.reply_markup = {
      inline_keyboard: opts.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
    };
  }
  const res = await fetch(api("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) log.warn(`sendMessage ${res.status}: ${await res.text()}`);
}

export async function sendMessage(
  text: string,
  opts: { chatId?: string; buttons?: InlineButton[][] } = {},
): Promise<void> {
  if (!config.telegram.botToken) return;
  try {
    const chunks = splitText(text);
    for (let i = 0; i < chunks.length; i++) {
      await sendMessageChunk(chunks[i], {
        chatId: opts.chatId,
        buttons: i === chunks.length - 1 ? opts.buttons : undefined,
      });
    }
  } catch (err) {
    log.error("sendMessage failed", err);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  if (!config.telegram.botToken) return;
  await fetch(api("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text ?? "" }),
  }).catch((err) => log.error("answerCallbackQuery failed", err));
}

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { id: number } };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
    from?: { id: number };
  };
}

/** Long-poll for updates. `timeout` is the server-side hold (seconds). */
export async function getUpdates(offset: number, timeout = 45): Promise<TelegramUpdate[]> {
  if (!config.telegram.botToken) return [];
  try {
    const res = await fetch(api(`getUpdates?timeout=${timeout}&offset=${offset}`), {
      signal: AbortSignal.timeout((timeout + 10) * 1000),
    });
    if (!res.ok) {
      log.warn(`getUpdates ${res.status}`);
      return [];
    }
    const data: any = await res.json();
    return data.result ?? [];
  } catch (err) {
    if ((err as Error).name !== "TimeoutError") log.error("getUpdates failed", err);
    return [];
  }
}
