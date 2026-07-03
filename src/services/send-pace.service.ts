import { config } from "../config/index.js";
import { SendPaceRepo } from "../repositories/index.js";

export interface SendPace {
  /** Max sends per dispatch cycle (dispatcher runs every few minutes). */
  maxPerRun: number;
  /** Total sends allowed today across all mailboxes, on top of per-mailbox
   *  warmup caps and the per-recipient-domain cap (whichever binds first wins). */
  dailyCeiling: number;
}

const FLOOR = 1;

function clamp(v: number, ceiling: number): number {
  return Math.max(FLOOR, Math.min(ceiling, Math.round(v)));
}

/**
 * Effective sending pace: the agent's override (if any), clamped to the
 * operator-set hard ceilings in config.agent, falling back to the static
 * config defaults when no override has been set. This is the only lever the
 * agent's set_send_pace tool controls — it can never widen the per-mailbox
 * warmup caps or the per-recipient-domain cap, which are enforced separately.
 */
export async function getSendPace(): Promise<SendPace> {
  const override = await SendPaceRepo.get();
  const maxPerRun =
    override?.maxPerRun !== undefined
      ? clamp(override.maxPerRun, config.agent.maxPerRunCeiling)
      : config.sending.maxPerRun;
  const dailyCeiling =
    override?.dailyCeiling !== undefined
      ? clamp(override.dailyCeiling, config.agent.dailySendCeiling)
      : config.agent.dailySendCeiling;
  return { maxPerRun, dailyCeiling };
}

export async function setSendPace(input: {
  maxPerRun?: number;
  dailyCeiling?: number;
  reason: string;
  updatedBy: string;
}): Promise<SendPace> {
  await SendPaceRepo.set(input);
  return getSendPace();
}

export async function resetSendPace(): Promise<SendPace> {
  await SendPaceRepo.reset();
  return getSendPace();
}
