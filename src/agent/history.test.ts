import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import { trimChatHistory } from "./history.js";

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

test("history trimming keeps assistant tool calls with their tool outputs", () => {
  const messages: Msg[] = [{ role: "system", content: "system" }];
  for (let index = 0; index < 10; index++) {
    messages.push({ role: "user", content: `old-${index}` });
    messages.push({ role: "assistant", content: `answer-${index}` });
  }
  for (let index = 0; index < 4; index++) {
    const id = `call-${index}`;
    messages.push({ role: "user", content: `tool-turn-${index}` });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "test_tool", arguments: "{}" } }],
    });
    messages.push({ role: "tool", tool_call_id: id, content: "{}" });
    messages.push({ role: "assistant", content: `done-${index}` });
  }

  const trimmed = trimChatHistory(messages, 24);
  assert.equal(trimmed[0].role, "system");
  assert.equal(trimmed[1].role, "user");

  const retainedCallIds = new Set(
    trimmed.flatMap((message) =>
      message.role === "assistant" && "tool_calls" in message && message.tool_calls
        ? message.tool_calls.map((call) => call.id)
        : [],
    ),
  );
  for (const message of trimmed) {
    if (message.role === "tool") assert.ok(retainedCallIds.has(message.tool_call_id));
  }
});
