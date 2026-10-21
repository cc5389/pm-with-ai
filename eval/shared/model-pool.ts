import { readFileSync } from "node:fs";
import type { ModelProfile, Task } from "../../lib/types";
import { MODEL_PRICING } from "./pricing";

/** Stage A alias. Orchestra must not send this to LiteLLM. */
export const SMART_ROUTER_ALIAS = "smart-router";

/**
 * Shared cap for baseline and Orchestra, in output tokens. It was 256, which
 * truncated 56 of 60 calibration answers and made the judge score truncation.
 */
export const EVAL_OUTPUT_TOKEN_CAP = 1024;

/** Fixed UTC date so Orchestra's calendar math is reproducible. */
export const EVAL_SIMULATED_DATE = "2026-10-16";

/** Shared volume assumption. Matches the Stage C workload length. */
export const EVAL_MONTHLY_REQUESTS = 200;

export const EVAL_USER_ID = "eval";

const TASKS = ["coding", "analysis", "writing", "qa"] as const;

/**
 * One shared, uncalibrated quality estimate for every alias.
 * It meets the Stage B/C floor of 0.75, so the estimate does not remove
 * the cheapest tier from the pool. It is not a measurement and does not rank quality.
 * A calibration file replaces it with measured per-task scores.
 */
const SHARED_QUALITY_ESTIMATE = 0.75;

/** Uncalibrated latency placeholders in seconds. Not a deadline guarantee. */
const LATENCY_ESTIMATE_SECONDS = {
  3: 4,
  2: 2,
  1: 1,
} as const;

export type PoolId = "openai" | "ollama";

export interface ModelPool {
  id: PoolId;
  label: string;
  /** Prefixes the gateway may put before the provider model name. */
  providerPrefixes: readonly string[];
  /** Local models run on this machine; the privacy setting allows them. */
  local: boolean;
  /**
   * Shadow-priced pools ignore the gateway's cost header and always charge
   * the price table, so a gateway that reports $0 cannot empty the budget math.
   */
  shadowPriced: boolean;
  contextWindow: number;
  models: readonly LiteLLMModel[];
}

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

/** Each pool matches one gateway config: eval/stage-a/litellm/config.yaml or eval/litellm/ollama.yaml. */
export const MODEL_POOLS: Readonly<Record<PoolId, ModelPool>> = {
  openai: {
    id: "openai",
    label: "OpenAI via local LiteLLM",
    providerPrefixes: ["openai/"],
    local: false,
    shadowPriced: false,
    contextWindow: 128000,
    models: [
      definedModel("gpt-4.1", "gpt-4.1-2025-04-14", 3),
      definedModel("gpt-4.1-mini", "gpt-4.1-mini-2025-04-14", 2),
      definedModel("gpt-4.1-nano", "gpt-4.1-nano-2025-04-14", 1),
    ],
  },
  ollama: {
    id: "ollama",
    label: "Local Ollama via LiteLLM",
    providerPrefixes: ["ollama_chat/", "ollama/"],
    local: true,
    shadowPriced: true,
    // gemma3:1b has the smallest window; Ollama's own num_ctx may be lower.
    contextWindow: 32000,
    models: [
      definedModel("gemma3-12b", "gemma3:12b", 3),
      definedModel("gemma3-4b", "gemma3:4b", 2),
      definedModel("gemma3-1b", "gemma3:1b", 1),
    ],
  },
};

export function activePoolId(env: Record<string, string | undefined> = process.env): PoolId {
  const value = env.ORCHESTRA_POOL?.trim() || "openai";
  if (value !== "openai" && value !== "ollama") {
    throw new Error('ORCHESTRA_POOL must be "openai" or "ollama".');
  }
  return value;
}

export function activePool(env: Record<string, string | undefined> = process.env): ModelPool {
  return MODEL_POOLS[activePoolId(env)];
}

/** Aliases of the pool selected when this module loaded. Prefer activePool() in new code. */
export const LITELLM_MODELS: readonly LiteLLMModel[] = activePool().models;

/**
 * Identifiers the gateway may return for each configured alias.
 * The versioned ids are the model strings in the gateway config and the frozen price table.
 * Matching is exact: gpt-4.1-mini is not gpt-4.1.
 */
export function returnedModelIds(
  pool: ModelPool = activePool(),
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    pool.models.map((model) => [
      model.alias,
      [
        model.alias,
        model.providerModel,
        ...pool.providerPrefixes.flatMap((prefix) => [
          `${prefix}${model.alias}`,
          `${prefix}${model.providerModel}`,
        ]),
      ],
    ]),
  );
}

export const RETURNED_MODEL_IDS = returnedModelIds();

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
  models: readonly LiteLLMModel[] = activePool().models,
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
  models: readonly LiteLLMModel[] = activePool().models,
): number {
  const inputTokens = estimateInputTokens(prompt);
  return fullCapReservation(mostExpensiveEligibleModel(models), inputTokens);
}

/** Written by eval/calibration/run.ts from judged calibration responses. */
export interface PoolCalibration {
  pool: PoolId;
  judgeModel: string;
  updatedAt: string;
  models: Record<
    string,
    {
      quality: Partial<Record<Task, number>>;
      latencySeconds: Partial<Record<Task, number>>;
      samples: Partial<Record<Task, number>>;
    }
  >;
}

export function calibrationPath(
  pool: PoolId,
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.ORCHESTRA_CALIBRATION_PATH?.trim() ||
    `eval/results/calibration/${pool}-quality.json`
  );
}

export function readCalibration(
  pool: PoolId,
  env: Record<string, string | undefined> = process.env,
): PoolCalibration | null {
  let raw: string;
  try {
    // A local file chosen at runtime; Next must not trace the project for it.
    raw = readFileSync(
      /*turbopackIgnore: true*/ calibrationPath(pool, env),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as PoolCalibration;
  if (parsed.pool !== pool || typeof parsed.models !== "object") {
    throw new Error(`Calibration file for ${pool} is invalid.`);
  }
  return parsed;
}

const unit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const seconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Profiles for lib/engine.ts. Measured per-task quality and latency come from
 * the pool's calibration file when present; otherwise every alias shares the
 * uncalibrated estimates above.
 */
export function litellmProfiles(
  pool: ModelPool = activePool(),
  calibration: PoolCalibration | null = readCalibration(pool.id),
): ModelProfile[] {
  return pool.models.map((entry) => {
    const measured = calibration?.models[entry.alias];
    const qualitySampleCounts = Object.fromEntries(
      TASKS.map((task) => [task, measured?.samples[task] ?? 0]),
    ) as Record<Task, number>;
    const quality = Object.fromEntries(
      TASKS.map((task) => {
        const value = measured?.quality[task];
        return [task, unit(value) ? value : SHARED_QUALITY_ESTIMATE];
      }),
    ) as Record<Task, number>;
    const latency = Object.fromEntries(
      TASKS.map((task) => {
        const value = measured?.latencySeconds[task];
        return [
          task,
          seconds(value) ? value : LATENCY_ESTIMATE_SECONDS[entry.qualityTier],
        ];
      }),
    ) as Record<Task, number>;
    const sampleCount = Object.values(qualitySampleCounts).reduce(
      (sum, n) => sum + n,
      0,
    );
    return {
      id: entry.alias,
      name: entry.alias,
      provider: pool.label,
      tier: sampleCount
        ? `quality tier ${entry.qualityTier}`
        : `quality tier ${entry.qualityTier} (estimate)`,
      inputPrice: entry.inputPerMillion,
      outputPrice: entry.outputPerMillion,
      contextWindow: pool.contextWindow,
      quality,
      latency,
      source: sampleCount ? "measured" : "illustrative",
      measuredAt: sampleCount ? (calibration?.updatedAt ?? null) : null,
      sampleCount,
      qualitySampleCounts,
      local: pool.local,
      gateway: true,
    };
  });
}

export function canonicalAlias(
  name: string | null | undefined,
  pool: ModelPool = activePool(),
): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  for (const [alias, identifiers] of Object.entries(returnedModelIds(pool))) {
    if (identifiers.includes(trimmed)) return alias;
  }
  return null;
}

export function pricingModelId(
  name: string,
  pool: ModelPool = activePool(),
): string | null {
  const alias = canonicalAlias(name, pool);
  if (alias) {
    return (
      pool.models.find((entry) => entry.alias === alias)?.providerModel ?? null
    );
  }
  const normalized = name.replace(/^(openai|ollama_chat|ollama)\//, "");
  return normalized in MODEL_PRICING ? normalized : null;
}

export function describeReturnedModel(
  requested: string,
  returned: string | null,
  pool: ModelPool = activePool(),
): { selectedModel: string | null; mismatch: boolean } {
  if (returned === null) {
    return {
      selectedModel: requested === SMART_ROUTER_ALIAS ? null : requested,
      mismatch: false,
    };
  }
  const alias = canonicalAlias(returned, pool);
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
