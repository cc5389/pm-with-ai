import type { ModelProfile, Task } from "../../lib/types";
import { MODEL_PRICING } from "./pricing";

/** Stage A alias. Orchestra must not send this to LiteLLM. */
export const SMART_ROUTER_ALIAS = "smart-router";

/** Shared cap for baseline and Orchestra, in output tokens. */
export const EVAL_OUTPUT_TOKEN_CAP = 256;

/** Fixed UTC date so Orchestra's calendar math is reproducible. */
export const EVAL_SIMULATED_DATE = "2026-10-16";

/** Shared volume assumption. Matches the Stage C workload length. */
export const EVAL_MONTHLY_REQUESTS = 200;

export const EVAL_USER_ID = "eval";

const TASKS = ["coding", "analysis", "writing", "qa"] as const;

/**
 * One shared, uncalibrated quality estimate for every alias.
 * It meets the Stage B/C floor of 0.75, so the estimate does not remove
 * gpt-4.1-nano from the pool. It is not a measurement and does not rank quality.
 */
const SHARED_QUALITY_ESTIMATE = 0.75;

/** Uncalibrated latency placeholders in seconds. Not a deadline guarantee. */
const LATENCY_ESTIMATE_SECONDS = {
  3: 4,
  2: 2,
  1: 1,
} as const;

export interface LiteLLMModel {
  alias: string;
  providerModel: keyof typeof MODEL_PRICING;
  qualityTier: 1 | 2 | 3;
  inputPerToken: number;
  outputPerToken: number;
  inputPerMillion: number;
  outputPerMillion: number;
}

function definedModel(
  alias: string,
  providerModel: keyof typeof MODEL_PRICING,
  qualityTier: 1 | 2 | 3,
): LiteLLMModel {
  const pricing = MODEL_PRICING[providerModel];
  return {
    alias,
    providerModel,
    qualityTier,
    inputPerToken: pricing.input,
    outputPerToken: pricing.output,
    inputPerMillion: pricing.input * 1_000_000,
    outputPerMillion: pricing.output * 1_000_000,
  };
}

/** Same three aliases as eval/stage-a/litellm/config.yaml, excluding smart-router. */
export const LITELLM_MODELS: readonly LiteLLMModel[] = [
  definedModel("gpt-4.1", "gpt-4.1-2025-04-14", 3),
  definedModel("gpt-4.1-mini", "gpt-4.1-mini-2025-04-14", 2),
  definedModel("gpt-4.1-nano", "gpt-4.1-nano-2025-04-14", 1),
];

/**
 * Identifiers the gateway may return for each configured alias.
 * The versioned ids are the model strings in config.yaml and the frozen price table.
 * Matching is exact: gpt-4.1-mini is not gpt-4.1.
 */
export const RETURNED_MODEL_IDS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    LITELLM_MODELS.map((model) => [
      model.alias,
      [
        model.alias,
        model.providerModel,
        `openai/${model.alias}`,
        `openai/${model.providerModel}`,
      ],
    ]),
  );

export function estimateInputTokens(prompt: string): number {
  return Math.max(1, Math.ceil(prompt.length / 4));
}

/** Matches lib/engine.ts: prices are USD per million tokens. */
export function estimatedRequestCost(
  model: LiteLLMModel,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * model.inputPerMillion +
      outputTokens * model.outputPerMillion) /
    1e6
  );
}

/** Input tokens plus every token of the shared output cap. */
export function fullCapReservation(
  model: LiteLLMModel,
  inputTokens: number,
): number {
  return estimatedRequestCost(model, inputTokens, EVAL_OUTPUT_TOKEN_CAP);
}

/**
 * Smart-router can return any configured alias. The gateway is not given an
 * allow-list, so the eligible set for a reservation is the whole configured pool.
 */
export function mostExpensiveEligibleModel(
  models: readonly LiteLLMModel[] = LITELLM_MODELS,
): LiteLLMModel {
  if (models.length === 0) {
    throw new Error("The eligible LiteLLM pool is empty.");
  }
  return models.reduce((highest, candidate) =>
    fullCapReservation(candidate, 1) > fullCapReservation(highest, 1)
      ? candidate
      : highest,
  );
}

export function conservativePoolCost(
  prompt: string,
  models: readonly LiteLLMModel[] = LITELLM_MODELS,
): number {
  const inputTokens = estimateInputTokens(prompt);
  return fullCapReservation(mostExpensiveEligibleModel(models), inputTokens);
}

export function litellmProfiles(): ModelProfile[] {
  return LITELLM_MODELS.map((entry) => {
    const quality = Object.fromEntries(
      TASKS.map((task) => [task, SHARED_QUALITY_ESTIMATE]),
    ) as Record<Task, number>;
    const latency = Object.fromEntries(
      TASKS.map((task) => [
        task,
        LATENCY_ESTIMATE_SECONDS[entry.qualityTier],
      ]),
    ) as Record<Task, number>;
    return {
      id: entry.alias,
      name: entry.alias,
      provider: "OpenAI via local LiteLLM",
      tier: `quality tier ${entry.qualityTier} (estimate)`,
      inputPrice: entry.inputPerMillion,
      outputPrice: entry.outputPerMillion,
      contextWindow: 128000,
      quality,
      latency,
      source: "illustrative",
      measuredAt: null,
      sampleCount: 0,
      local: false,
    };
  });
}

export function canonicalAlias(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  for (const [alias, identifiers] of Object.entries(RETURNED_MODEL_IDS)) {
    if (identifiers.includes(trimmed)) return alias;
  }
  return null;
}

export function pricingModelId(name: string): string | null {
  const alias = canonicalAlias(name);
  if (alias) {
    return (
      LITELLM_MODELS.find((entry) => entry.alias === alias)?.providerModel ??
      null
    );
  }
  const normalized = name.replace(/^openai\//, "");
  return normalized in MODEL_PRICING ? normalized : null;
}

export function describeReturnedModel(
  requested: string,
  returned: string | null,
): { selectedModel: string | null; mismatch: boolean } {
  if (returned === null) {
    return {
      selectedModel: requested === SMART_ROUTER_ALIAS ? null : requested,
      mismatch: false,
    };
  }
  const alias = canonicalAlias(returned);
  if (requested === SMART_ROUTER_ALIAS) {
    return {
      selectedModel: alias ?? returned,
      mismatch: alias === null,
    };
  }
  return {
    selectedModel: alias === requested ? requested : returned,
    mismatch: alias !== requested,
  };
}
