import { LeadsRepo } from "../repositories/index.js";
import {
  SCORE_WEIGHTS,
  HIGH_INTENT_LINK_KEYWORDS,
  HIGH_INTENT_CLICK_SCORE,
  ESCALATION,
} from "./scoring.config.js";
import type { Event } from "../models/types.js";

/** Compute the score delta for a single event (considering its metadata). */
export function scoreForEvent(event: Event): number {
  if (event.type === "click") {
    const url = String(event.metadata?.url ?? "").toLowerCase();
    const label = String(event.metadata?.label ?? "").toLowerCase();
    const highIntent = HIGH_INTENT_LINK_KEYWORDS.some(
      (kw) => url.includes(kw) || label.includes(kw),
    );
    return highIntent ? HIGH_INTENT_CLICK_SCORE : (SCORE_WEIGHTS.click ?? 0);
  }
  return SCORE_WEIGHTS[event.type] ?? 0;
}

/** Apply an event's score delta to its lead and return the new total. */
export async function applyScore(event: Event): Promise<{ delta: number; newScore: number }> {
  const delta = scoreForEvent(event);
  const newScore = delta !== 0 ? await LeadsRepo.addScore(event.leadId, delta) : await currentScore(event.leadId);
  return { delta, newScore };
}

async function currentScore(leadId: string): Promise<number> {
  const lead = await LeadsRepo.getById(leadId);
  return lead?.score ?? 0;
}

export type Temperature = "cold" | "warm" | "hot";

export function temperature(score: number): Temperature {
  if (score >= ESCALATION.hot) return "hot";
  if (score >= ESCALATION.notify) return "warm";
  return "cold";
}
