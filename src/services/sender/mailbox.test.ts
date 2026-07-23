import assert from "node:assert/strict";
import test from "node:test";

process.env.MONGODB_URI ??= "mongodb://localhost:27017/jarvis-test";

import type { Mailbox, MailboxCapacity } from "./mailbox.js";

const { selectMailboxByAssignedLoad } = await import("./mailbox.js");

function mailbox(email: string, dailyCap: number): Mailbox {
  return {
    email,
    fromName: "Sales",
    replyTo: email,
    smtp: { host: "smtp.example.com", port: 465, secure: true, user: email, pass: "secret" },
    imap: { host: "imap.example.com", port: 993, secure: true },
    dailyCap,
    warmup: false,
  };
}

function capacity(email: string, cap: number, sentToday = 0): MailboxCapacity {
  return { email, cap, sentToday, remaining: Math.max(0, cap - sentToday), warmupDay: 0 };
}

test("selectMailboxByAssignedLoad spreads bulk assignments when sent capacity is tied", () => {
  const boxes = [mailbox("a@example.com", 10), mailbox("b@example.com", 10), mailbox("c@example.com", 10)];
  const capacities = new Map(boxes.map((box) => [box.email, capacity(box.email, 10)]));
  const activeAssigned = new Map<string, number>();
  const selections: string[] = [];

  for (let i = 0; i < 6; i += 1) {
    const selected = selectMailboxByAssignedLoad(boxes, capacities, activeAssigned);
    selections.push(selected.email);
    activeAssigned.set(selected.email, (activeAssigned.get(selected.email) ?? 0) + 1);
  }

  assert.deepEqual(selections, [
    "a@example.com",
    "b@example.com",
    "c@example.com",
    "a@example.com",
    "b@example.com",
    "c@example.com",
  ]);
});

test("selectMailboxByAssignedLoad normalizes active assignments by mailbox capacity", () => {
  const small = mailbox("small@example.com", 10);
  const large = mailbox("large@example.com", 30);
  const boxes = [small, large];
  const capacities = new Map<string, MailboxCapacity>([
    [small.email, capacity(small.email, 10)],
    [large.email, capacity(large.email, 30)],
  ]);

  assert.equal(
    selectMailboxByAssignedLoad(
      boxes,
      capacities,
      new Map([
        [small.email, 1],
        [large.email, 2],
      ]),
    ).email,
    large.email,
  );
});

test("selectMailboxByAssignedLoad preserves capacity-based tie breakers", () => {
  const capped = mailbox("capped@example.com", 10);
  const available = mailbox("available@example.com", 10);
  const boxes = [capped, available];
  const capacities = new Map<string, MailboxCapacity>([
    [capped.email, capacity(capped.email, 10, 10)],
    [available.email, capacity(available.email, 10, 2)],
  ]);

  assert.equal(selectMailboxByAssignedLoad(boxes, capacities, new Map()).email, available.email);
});
