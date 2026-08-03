import type OpenAI from "openai";

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

/** Trim old chat context only at a user-turn boundary so tool-call pairs stay intact. */
export function trimChatHistory(messages: Msg[], maxMessages = 26): Msg[] {
  if (messages.length <= maxMessages) return messages;

  const hasSystemPrefix = messages[0]?.role === "system";
  const prefixLength = hasSystemPrefix ? 1 : 0;
  const tailBudget = Math.max(1, maxMessages - prefixLength);
  const targetStart = Math.max(prefixLength, messages.length - tailBudget);

  let turnStart = messages.findIndex((message, index) => index >= targetStart && message.role === "user");
  if (turnStart === -1) {
    // A single tool-heavy turn may exceed the target size. Keep that complete
    // turn even if it is larger than the nominal history budget.
    for (let index = targetStart - 1; index >= prefixLength; index--) {
      if (messages[index].role === "user") {
        turnStart = index;
        break;
      }
    }
  }

  if (turnStart === -1) return hasSystemPrefix ? [messages[0]] : [];
  return hasSystemPrefix ? [messages[0], ...messages.slice(turnStart)] : messages.slice(turnStart);
}
