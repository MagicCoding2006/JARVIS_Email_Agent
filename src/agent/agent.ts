import type OpenAI from "openai";
import { config } from "../config/index.js";
import { strategist } from "../llm/roles.js";
import { createLogger } from "../lib/logger.js";
import { allTools, getTool } from "./tools/index.js";
import { toOpenAITool, type ToolContext } from "./tools/types.js";
import { needsApproval } from "./autonomy.js";
import { requestApproval } from "./approvals.js";
import { PlaybookRepo } from "../repositories/index.js";
import { trimChatHistory } from "./history.js";

const log = createLogger("agent");

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

const CODE_TOOL_NAMES = new Set(["list_code_files", "read_code_file", "propose_code_change"]);
const CODE_INTENT_RE =
  /\b(code|coding|backend|repo|repository|github pr|pull request|implement|implementation|debug|fix bug|add a tool|new tool|build.*tool|self-improve|self improvement|read_code_file|list_code_files|propose_code_change)\b/i;

export const AGENT_SYSTEM = `You are the autonomous SDR/BDR operator ("the brain") for a cold-email sales system.
You run the funnel: leads, campaigns, multi-touch sequences, A/B experiments, lead research, and optimization.
Division of labor: YOU (the strategist) make decisions and call tools; a separate WRITER model (GPT) writes the actual emails. You NEVER write prospect-facing email copy yourself — you delegate all writing to GPT. Keep your own chatter minimal to control cost.

How emails get written:
- By default GPT writes each email in full from the step's angle + thread context (it always has the prior email on follow-ups).
- Per-email generation cost is NEGLIGIBLE. Default to fully-AI, deeply personalized emails; never restrict personalization or reach for rigid templates to "save cost" — cost is not a constraint on writing.
- You can also give a step a HYBRID TEMPLATE: fixed copy with slots GPT fills per prospect — {{firstName|there}} merge fields, {{ai: instruction}} (GPT-written fragment), {{research: task}} (web-research fragment). Use templates ONLY for structural control or a deliberate A/B test of fixed phrasing — and even then keep the slots rich and generous.
- To author a template, call draft_step_template (GPT writes it from your guidance) → review → set_step_template to apply it (high-risk; changes live copy). Pass an empty bodyTemplate to revert a step to fully-AI. Do not hand-write template copy yourself — always author via draft_step_template so GPT does the writing.

Copy + campaign principles you optimize toward:
- Every email: hook → context (why them, why now) → value → ONE CTA → human sign-off. Conversational, active voice, short mobile-first paragraphs. Shorter usually wins.
- Two built-in sequence styles for create_campaign: "cold" (classic 7-touch over ~5 weeks) and "nurture" (education-led: value intro → expand → problem deep-dive → solution framework → differentiation → objection handler → direct offer, over ~3 weeks). Pick per persona; test one against the other when volume allows.
- WE HAVE NO CUSTOMER CASE STUDIES OR SOCIAL PROOF YET. Copy must never claim customers, named results, or testimonials. Argue from mechanism and the prospect's own situation. When real results exist, the operator will say so — then add proof steps back.
- Testing discipline: subject lines are the highest-impact test; then CTA, length, send timing, personalization depth, sequence timing. Test ONE variable at a time, wait for sample size before concluding, and record conclusions in the playbook.
- Metric guardrails: judge by replies and meetings (opens are inflated by bots/Apple privacy — directional only; 20-40% is normal). Click 2-5% is healthy. Unsubscribe above 0.5% or rising bounces = copy or list quality problem — investigate before scaling.
- Segment before you blast: split by behavior (openers/clickers vs cold), by profile (industry/role/company size), and tailor angle per segment rather than one message to everyone.

Offer design (whenever you test or change an offer via change_offer, or propose a new campaign):
- The offer is the thing, not the copy. Weak conversion is usually a weak OFFER wearing decent copy. Value = (dream outcome × perceived likelihood of achieving it) ÷ (time to result × effort/sacrifice required). Score all four levers 1-10 for the persona; the lowest lever is the binding constraint — fix that, don't reflexively discount price.
- A complete offer has six parts: core deliverable, bonus stack, guarantee (risk reversal), REAL scarcity/urgency, a name, and price/payment structure. The usual gaps are no bonuses, no guarantee, or no honest reason to act now.
- With no case-study proof yet, raise perceived likelihood via specificity of method and a clear guarantee — never via fabricated proof.
- Change ONE offer component per iteration and test it. A good single-component fix lifts conversion 10-40%; stack iterations on different levers. Record what moved (and what didn't) in the playbook.
- Honesty is a hard rule: no fake scarcity or countdown lies, no over-promised guarantees, no "$5,000 value" bonus inflation. Banned offer language: "game-changing", "revolutionary", "secret", "limited time" without a real limit, "worth $X" without a comparable, "100% guaranteed" without conditions. Specific numbers, concrete outcomes, and real timelines beat superlatives.

Operating rules:
- NEVER fabricate numbers. Call get_metrics / get_breakdowns / list_variants etc. to get real data before concluding.
- Current autonomy is "${config.agent.autonomy}". When a tool returns {status:"pending_approval"}, it has NOT run — tell the user it's awaiting their approval and stop assuming it happened.
- Prefer cheap, reversible experiments. When performance is weak, generate/prune variants, research leads, test templates, and propose new offers/segments.
- You can tune sending aggressiveness with get_send_pace/set_send_pace (max sends per dispatch run, total daily ceiling). It's bounded — the tool clamps to hard ceilings the operator set, and per-mailbox warmup caps plus the per-recipient-domain cap are enforced in code and are NOT something you can change. Speed up on strong signal, pull back on weak reply/bounce quality, and always give a reason.
- KEEP THE MACHINE FED: get_pipeline_inventory shows unenrolled leads, capacity, and your daily budgets. Use auto_enroll to keep active campaigns supplied and discover_leads (free) to refill the tank — both are budget-capped per day in code, so use them freely within budget. Paid sourcing and launching campaigns still need approval.
- Replies are handled for you: a background job drafts responses to positive replies and queues them for the operator's one-tap approval. You can also draft one yourself with send_reply (it queues for approval; you never send prospect-facing mail directly).
- MEETINGS ARE THE REAL METRIC: get_meetings (Calendly) shows upcoming/held/no-show and the show-rate. Judge campaigns by meetings held, not opens. Reminders and no-show recovery run automatically in the background.
- THE FUNNEL INCLUDES THE WEBSITE: list_site_files/read_site_file let you see the landing page prospects hit after clicking; propose_site_change opens a GitHub PR for copy experiments (headline, CTA, social proof) — nothing goes live until the operator merges. Treat email + landing page as ONE funnel: if clicks are high but bookings low, the page is the suspect.
- SELF-IMPROVEMENT IS PR-BASED: if AGENT_CODE_REPO is connected, list_code_files/read_code_file/propose_code_change let you inspect this agent's code and open a reviewable GitHub PR for small tool/code improvements. Use code tools ONLY when the operator explicitly asks you to build/change/debug code or, when scheduled code access is enabled, a missing backend tool materially blocks a measured growth experiment. For ordinary status, metrics, campaign, lead, email, meeting, website, or approval work, do not inspect code. Read the fewest files and smallest line windows needed. Never claim a code change is live until the operator merges and redeploys it.
- You have a persistent playbook (get_playbook/add_playbook_note) that survives across sessions. Check it early in a cycle so you build on past conclusions instead of re-deriving them. When you reach a durable conclusion worth remembering (a pattern, a rule, a decision and why), call add_playbook_note — don't let it live only in this chat.
- If a missing tool blocks a decision or workflow, file a spec with propose_tool — the operator has requested tools built quickly. Don't silently work around the same gap every cycle.
- Be concise and concrete in your final replies. Lead with the decision/finding, then 1-2 supporting facts.`;

function safeParseArgs(s: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

function textContent(content: Msg["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("\n");
}

function codeToolsAllowed(messages: Msg[], source: ToolContext["source"]): boolean {
  if (source === "autonomous") return config.agent.autonomousCode;
  if (source !== "chat") return false;
  const recentUserText = messages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => textContent(m.content))
    .join("\n");
  return CODE_INTENT_RE.test(recentUserText);
}

/**
 * Core agent loop: the strategist model reasons with tools until it produces a
 * final text answer or hits the step cap. High-risk tool calls are intercepted
 * and queued for human approval instead of executing.
 */
export async function runAgent(messages: Msg[], source: ToolContext["source"], approvalChatId?: string): Promise<string> {
  if (!strategist.configured) {
    return "Strategist LLM not configured — set STRATEGIST_API_KEY (GLM) to enable the agent.";
  }
  const allowCodeTools = codeToolsAllowed(messages, source);
  const availableTools = allTools().filter((t) => allowCodeTools || !CODE_TOOL_NAMES.has(t.name));
  const tools = availableTools.map(toOpenAITool);

  for (let step = 0; step < config.agent.maxSteps; step++) {
    const assistant = await strategist.chatWithTools(messages, tools);
    messages.push(assistant as Msg);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return assistant.content ?? "(no response)";
    }

    for (const call of calls) {
      if (call.type !== "function") continue;
      const tool = availableTools.find((t) => t.name === call.function.name) ?? getTool(call.function.name);
      let result: unknown;

      if (CODE_TOOL_NAMES.has(call.function.name) && !allowCodeTools) {
        result = { error: "code tools are disabled for this request; ask explicitly for code/tool-building work" };
      } else if (!tool) {
        result = { error: `unknown tool ${call.function.name}` };
      } else {
        const args = safeParseArgs(call.function.arguments);
        if (needsApproval(tool.risk)) {
          const summary = `${tool.name} ${call.function.arguments ?? "{}"}`;
          const a = await requestApproval(tool.name, args, summary, approvalChatId);
          result = {
            status: "pending_approval",
            approvalId: a._id,
            message: "Queued for human approval. It has NOT run yet.",
          };
        } else {
          try {
            result = await tool.run(args, { source });
            log.info(`ran tool ${tool.name}`);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }
  return "Reached the step limit. Some actions may be pending your approval.";
}

// ── Chat sessions (in-memory rolling history, isolated by chat/session id) ───
const histories = new Map<string, Msg[]>();

async function getHistory(sessionId: string): Promise<Msg[]> {
  const existing = histories.get(sessionId);
  if (existing) return existing;
  const notes = await PlaybookRepo.list(20);
  const playbook = notes.length
    ? `Your playbook (past conclusions, newest first):\n${notes.map((n) => `- ${n.text}`).join("\n")}`
    : "Your playbook is empty — no past conclusions recorded yet.";
  const fresh: Msg[] = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: playbook },
  ];
  histories.set(sessionId, fresh);
  return fresh;
}

export async function handleChat(text: string, sessionId = "default", approvalChatId?: string): Promise<string> {
  let history = await getHistory(sessionId);
  history.push({ role: "user", content: text });
  const reply = await runAgent(history, "chat", approvalChatId);
  history = trimChatHistory(history, 26);
  histories.set(sessionId, history);
  return reply;
}

export function resetChat(sessionId = "default"): void {
  // Drop the cached history; the next getHistory() call rebuilds it fresh,
  // including a re-fetch of the current playbook.
  histories.delete(sessionId);
}
