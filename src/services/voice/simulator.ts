import { createInterface } from "node:readline/promises";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";
import { worker } from "../../llm/roles.js";
import { CallsRepo, CampaignsRepo, LeadsRepo, PlaybookRepo } from "../../repositories/index.js";
import { buildCallInstructions } from "./script.js";
import { buildCallTools } from "./call-tools.js";
import { analyzeCall } from "./call-analysis.service.js";
import type { RealtimeTool } from "./voice.interface.js";
import type { Call, Campaign, Lead } from "../../models/types.js";

const log = createLogger("voice:sim");

/**
 * The call, in text, with no telephony and no realtime session.
 *
 * This exists because the expensive, risky part of a calling bot is not the
 * audio plumbing — it's whether the thing can actually handle "not interested"
 * and still get to a close. Waiting on a Twilio number and a realtime key to
 * find that out is a bad trade, so the simulator runs the SAME instructions,
 * the SAME tool definitions, and the SAME post-call analysis through the cheap
 * worker model over stdin.
 *
 * What it does NOT test: audio quality, latency, barge-in, VAD turn-taking, and
 * answering-machine detection. Those only show up on a real line.
 */

export interface SimulateOptions {
  lead: Lead;
  campaign?: Campaign;
  offer?: string;
  /** Auto-play the prospect with a persona instead of reading stdin. */
  persona?: string;
  /** Turn limit for auto mode. */
  maxTurns?: number;
  /** Print each turn as it happens. */
  onTurn?: (role: "agent" | "prospect", text: string) => void;
}

interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Render the live tools as text the worker model can "call" by writing JSON. */
function toolCatalog(tools: RealtimeTool[]): string {
  return tools
    .map((t) => `- ${t.name}(${Object.keys((t.parameters as { properties?: object }).properties ?? {}).join(", ")}): ${t.description}`)
    .join("\n");
}

const TOOL_CALL_RE = /\{[^{}]*"tool"\s*:\s*"[^"]+"[^{}]*\}/;

export async function simulateCall(opts: SimulateOptions): Promise<{ callId: string; turns: number }> {
  if (!worker.configured) throw new Error("the worker LLM is not configured — set WORKER_API_KEY");

  const { lead } = opts;
  const campaign = opts.campaign;
  const notes = await PlaybookRepo.list(8).catch(() => []);

  // A real Call row, so the transcript, the tools, and the analysis all behave
  // exactly as they would on a live call.
  const call: Call = await CallsRepo.create({
    leadId: lead._id,
    campaignId: campaign?._id,
    toNumber: lead.phone ?? "+10000000000",
    fromNumber: config.voice.twilio.fromNumber || "+10000000000",
    provider: "simulator",
  });
  await CallsRepo.setStatus(call._id, "in_progress", { startedAt: new Date() });

  let hungUp = false;
  const tools = buildCallTools({
    call,
    lead,
    campaign,
    hangup: async (reason) => {
      hungUp = true;
      log.info(`agent hung up: ${reason}`);
    },
  });
  const byName = new Map(tools.map((t) => [t.name, t]));

  const instructions = buildCallInstructions({ lead, campaign, offer: opts.offer, notes });
  const messages: ChatTurn[] = [
    {
      role: "system",
      content:
        `${instructions}\n\n` +
        `════════════════════════════════════════\n` +
        `SIMULATION MODE — you are on a text transcript of the call, not audio.\n` +
        `Reply with ONLY the words you would say out loud. No stage directions, no narration.\n` +
        `To use a tool, emit a single line of JSON on its own: {"tool":"tool_name","args":{...}}\n` +
        `You may emit speech and then a tool line. Available tools:\n${toolCatalog(tools)}`,
    },
    { role: "user", content: "[the prospect picks up] Hello?" },
  ];

  const rl = opts.persona ? null : createInterface({ input: process.stdin, output: process.stdout });
  const emit = (role: "agent" | "prospect", text: string) => {
    opts.onTurn?.(role, text);
    void CallsRepo.appendTurn(call._id, { role, text, at: new Date() });
  };
  emit("prospect", "Hello?");

  const maxTurns = opts.maxTurns ?? 14;
  let turns = 0;

  try {
    for (; turns < maxTurns && !hungUp; turns++) {
      // The system turn goes in the system slot only — repeating a ~12k-char
      // instruction block inside the prompt doubles the cost of every turn.
      const reply = await worker.complete(
        messages
          .slice(1)
          .map((m) => `${m.role === "assistant" ? "YOU" : "PROSPECT"}: ${m.content}`)
          .join("\n\n"),
        { system: messages[0].content, temperature: 0.8, maxTokens: 400 },
      );

      // Split the model's turn into what it says and what it does.
      const toolMatch = TOOL_CALL_RE.exec(reply);
      const speech = reply.replace(TOOL_CALL_RE, "").trim();
      if (speech) {
        emit("agent", speech);
        messages.push({ role: "assistant", content: speech });
      }

      if (toolMatch) {
        let toolResult = "";
        try {
          const parsed = JSON.parse(toolMatch[0]) as { tool: string; args?: Record<string, unknown> };
          const tool = byName.get(parsed.tool);
          const result = tool ? await tool.run(parsed.args ?? {}) : { error: `unknown tool ${parsed.tool}` };
          toolResult = JSON.stringify(result);
          log.info(`↪ tool ${parsed.tool} → ${toolResult.slice(0, 160)}`);
        } catch (err) {
          toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
        messages.push({ role: "user", content: `[tool result] ${toolResult}` });
        if (hungUp) break;
        continue;
      }

      if (hungUp) break;

      const prospect = opts.persona
        ? await autoProspect(opts.persona, messages, lead)
        : ((await rl!.question("prospect> ")) || "").trim();

      if (!prospect || /^(hang ?up|\/quit|\/end)$/i.test(prospect)) {
        emit("prospect", "[hangs up]");
        break;
      }
      emit("prospect", prospect);
      messages.push({ role: "user", content: prospect });
    }
  } catch (err) {
    // A crash mid-simulation must not leave the row looking like a live call —
    // that would hold a concurrency slot the dialer can never reclaim.
    await CallsRepo.setStatus(call._id, "failed", {
      endedAt: new Date(),
      failureReason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    rl?.close();
  }

  await CallsRepo.setStatus(call._id, "completed", {
    endedAt: new Date(),
    durationSec: turns * 12, // rough: a conversational turn is ~12 seconds of call
  });
  const analysis = await analyzeCall(call._id);
  log.info(`simulated call ${call._id} → ${analysis?.outcome ?? "unknown"}`);
  return { callId: call._id, turns };
}

/** The other side of the call: an LLM playing a hard-to-reach prospect. */
async function autoProspect(persona: string, messages: ChatTurn[], lead: Lead): Promise<string> {
  const recent = messages
    .slice(-8)
    .map((m) => `${m.role === "assistant" ? "CALLER" : "YOU"}: ${m.content}`)
    .join("\n");
  const reply = await worker.complete(
    `${recent}\n\nYou are ${lead.firstName || "the person"} who just answered an unexpected sales call. ` +
      `Reply with one or two short spoken sentences — nothing else.`,
    {
      system:
        `You are role-playing a cold-call PROSPECT: ${persona}. ` +
        `You are busy and mildly annoyed at being interrupted. Push back realistically — brush the caller off at least once ` +
        `before you engage at all. Only agree to a meeting if the caller genuinely earns it by saying something specific and ` +
        `relevant to you; if they are vague, generic, or pushy, refuse. Never break character, never narrate.`,
      temperature: 0.9,
      maxTokens: 150,
    },
  );
  return reply.trim().replace(/^["']|["']$/g, "");
}
