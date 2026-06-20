import { schema, type Tool } from "./types.js";
import { HypothesesRepo } from "../../repositories/index.js";
import { evaluateHypotheses } from "../../services/experiments.service.js";

export const evaluateExperiments: Tool = {
  name: "evaluate_hypotheses",
  description:
    "Measure every hypothesis currently being tested against its baseline variants and mark each KEEP or REJECT (or leave it testing if data is thin). This closes the learning loop.",
  risk: "low",
  parameters: schema({}, []),
  async run() {
    const verdicts = await evaluateHypotheses();
    return { decided: verdicts };
  },
};

export const listHypotheses: Tool = {
  name: "list_hypotheses",
  description:
    "List recorded hypotheses (experiments) with their status (proposed/testing/keep/reject) and measured result. The accumulated 'what works' knowledge base.",
  risk: "low",
  parameters: schema(
    { status: { type: "string", description: "Optional filter: proposed|testing|keep|reject" } },
    [],
  ),
  async run(args: { status?: string }) {
    const valid = ["proposed", "testing", "keep", "reject"] as const;
    const rows =
      args.status && (valid as readonly string[]).includes(args.status)
        ? await HypothesesRepo.listByStatus(args.status as (typeof valid)[number])
        : await HypothesesRepo.list();
    return rows.slice(0, 40).map((h) => ({
      idea: h.idea,
      reason: h.reason,
      status: h.status,
      result: h.result ?? "",
    }));
  },
};
