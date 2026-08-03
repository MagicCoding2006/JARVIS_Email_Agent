import assert from "node:assert/strict";
import test from "node:test";
import { formatApprovalMessage } from "./approvals.js";

test("code approval previews omit full patch bodies and stay within Telegram limits", () => {
  const message = formatApprovalMessage({
    _id: "approval-123",
    tool: "propose_code_change",
    summary: "unused " + "x".repeat(10_000),
    args: {
      title: "Add campaign filter",
      description: "Keeps contractor enrollment scoped correctly.",
      changes: [
        { path: "src/repositories/index.ts", newContent: "x".repeat(10_000) },
        { path: "src/agent/tools/pipeline.tools.ts", replace: "y".repeat(10_000) },
      ],
    },
  });

  assert.ok(message.length <= 3200);
  assert.match(message, /Add campaign filter/);
  assert.match(message, /src\/repositories\/index\.ts/);
  assert.doesNotMatch(message, /x{100}/);
});
