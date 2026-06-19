import { config } from "../config/index.js";
import type { Risk } from "./tools/types.js";

export type Autonomy = "semi" | "propose" | "full";

/**
 * Whether an action of the given risk needs human approval under the current
 * autonomy level:
 *   - full    : nothing needs approval (still bounded by hard caps elsewhere)
 *   - propose : everything needs approval
 *   - semi    : only high-risk actions need approval
 */
export function needsApproval(risk: Risk, autonomy: Autonomy = config.agent.autonomy): boolean {
  if (autonomy === "full") return false;
  if (autonomy === "propose") return true;
  return risk === "high";
}
