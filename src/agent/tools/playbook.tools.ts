import { schema, type Tool } from "./types.js";
import { PlaybookRepo } from "../../repositories/index.js";
import { notify } from "../../services/notifications.service.js";

export const getPlaybook: Tool = {
  name: "get_playbook",
  description:
    "Read your persistent playbook — durable conclusions you (or the operator) recorded in past cycles, e.g. 'cold opens beat warm on Tuesdays for SaaS'. Optionally filter by tag (a campaign name or segment).",
  risk: "low",
  parameters: schema({
    tag: { type: "string", description: "Optional tag filter, e.g. a campaign name" },
    limit: { type: "number", description: "Max notes to return (default 30)" },
  }),
  async run(args: { tag?: string; limit?: number }) {
    const notes = args.tag
      ? await PlaybookRepo.listByTag(args.tag, args.limit ?? 30)
      : await PlaybookRepo.list(args.limit ?? 30);
    return notes.map((n) => ({ text: n.text, tags: n.tags, createdBy: n.createdBy, createdAt: n.createdAt }));
  },
};

export const addPlaybookNote: Tool = {
  name: "add_playbook_note",
  description:
    "Record a durable conclusion so it survives past this session and is read back to you at the start of every future cycle. " +
    "Use for patterns/rules worth remembering (what works, what doesn't, decisions and why) — not for one-off status updates.",
  risk: "low",
  parameters: schema(
    {
      text: { type: "string", description: "The conclusion, written so it's useful without today's context" },
      tags: { type: "array", items: { type: "string" }, description: "Optional labels, e.g. campaign name or segment" },
    },
    ["text"],
  ),
  async run(args: { text: string; tags?: string[] }) {
    const note = await PlaybookRepo.add(args.text, args.tags ?? [], "agent");
    return { saved: true, id: note._id };
  },
};

export const proposeTool: Tool = {
  name: "propose_tool",
  description:
    "When you're blocked because you WISH you had a tool that doesn't exist (a metric you can't read, an action you can't take), " +
    "write a spec for it here. It's filed to the playbook and pinged to the operator, who has it built by a coding agent — " +
    "well-specified tools usually ship within a day. Be concrete: exact inputs, outputs, and the decision it would unblock.",
  risk: "low",
  parameters: schema(
    {
      name: { type: "string", description: "snake_case tool name, e.g. get_reply_time_stats" },
      purpose: { type: "string", description: "What it does, in one or two sentences" },
      unblocks: { type: "string", description: "The decision/workflow you couldn't do without it (with a concrete example)" },
      inputs: { type: "string", description: "Proposed parameters and types" },
      outputs: { type: "string", description: "Proposed return shape" },
    },
    ["name", "purpose", "unblocks"],
  ),
  async run(args: { name: string; purpose: string; unblocks: string; inputs?: string; outputs?: string }) {
    const spec =
      `TOOL REQUEST: ${args.name}\n` +
      `Purpose: ${args.purpose}\n` +
      `Unblocks: ${args.unblocks}\n` +
      (args.inputs ? `Inputs: ${args.inputs}\n` : "") +
      (args.outputs ? `Outputs: ${args.outputs}\n` : "");
    await PlaybookRepo.add(spec, ["tool-request"], "agent");
    await notify({
      kind: "tool_request",
      level: "important",
      title: `🛠️ Agent requested a new tool: ${args.name}`,
      body: `${spec}\nPaste this spec to Claude Code to build it.`,
    });
    return { filed: true, note: "Spec sent to the operator. Work around the gap for now; the tool may exist next cycle." };
  },
};
