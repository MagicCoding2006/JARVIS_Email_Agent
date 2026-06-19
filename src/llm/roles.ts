import { config } from "../config/index.js";
import { LLMClient } from "./provider.js";

/**
 * Two roles, per the master plan:
 *
 *  - worker  (GPT-5.4 mini): fast, cheap, high-volume. Email writing,
 *    follow-ups, subject lines, reply classification, extraction, summaries.
 *
 *  - strategist (GLM-5.2 max): slower, pricier, higher-level. Funnel
 *    optimization, campaign strategy, experiment planning, weekly/monthly
 *    reviews. Called at most ~once/day to keep token spend down.
 */
export const worker = new LLMClient("worker", config.llm.worker);
export const strategist = new LLMClient("strategist", config.llm.strategist);
