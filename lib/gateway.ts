import { settleProviderCost } from "../eval/shared/accounting";
import { completeLiteLLM } from "../eval/shared/litellm-client";
import {
  activePool,
  describeReturnedModel,
  litellmProfiles,
  type ModelPool,
} from "../eval/shared/model-pool";
import { AppError } from "./db";
import type { Candidate, ModelProfile, RequestInput, RunRecord } from "./types";

/**
 * Gateway mode is opt-in: ORCHESTRA_POOL names the pool served by the local
 * LiteLLM gateway, and LITELLM_MASTER_KEY authorizes it. Without both, the app
 * never contacts a gateway.
 */
export function gatewayPool(
  env: Record<string, string | undefined> = process.env,
): ModelPool | null {
  if (!env.ORCHESTRA_POOL?.trim() || !env.LITELLM_MASTER_KEY?.trim())
    return null;
  try {
    return activePool(env);
  } catch (error) {
    throw new AppError(
      error instanceof Error ? error.message : "Invalid ORCHESTRA_POOL.",
      500,
    );
  }
}

export function gatewayProfiles(): ModelProfile[] {
  const pool = gatewayPool();
  return pool ? litellmProfiles(pool) : [];
}

export function gatewayAssumptions(pool: ModelPool): string[] {
  return pool.shadowPriced
    ? [
        `${pool.label}: nothing is billed. Costs are shadow prices from the gpt-4.1 tier of the same size, so the budget still constrains routing.`,
        "Quality and latency are measured on calibration prompts when a calibration file exists; otherwise they are uncalibrated estimates.",
      ]
    : [
        `${pool.label}: requests are billed by the provider. The reservation covers the input estimate and the full output allowance.`,
        "Quality and latency are uncalibrated estimates unless a calibration file exists.",
      ];
}

/** Calls the selected alias directly; smart-router is never used here. */
export async function generateGateway(
  input: RequestInput,
  selected: Candidate,
  remainingUsd: number,
): Promise<
  Pick<
    RunRecord,
    | "status"
    | "response"
    | "actualCost"
    | "inputTokens"
    | "outputTokens"
    | "measuredLatencyMs"
    | "error"
    | "gateway"
  >
> {
  const pool = gatewayPool();
  if (!pool)
    throw new AppError(
      "Gateway mode is not configured. Set ORCHESTRA_POOL and LITELLM_MASTER_KEY, then restart.",
    );
  const reservedCost = selected.estimatedCost;
  const call = await completeLiteLLM({
    model: selected.model.id,
    prompt: input.prompt,
    maxTokens: input.outputTokens,
    remainingUsd,
    reservedUsd: reservedCost,
  });
  const described = describeReturnedModel(
    selected.model.id,
    call.returnedModel,
    pool,
  );
  const settled = settleProviderCost({
    reservedCostUsd: reservedCost,
    providerContacted: call.providerContacted,
    costUsd: call.costUsd,
    costBasis: call.costBasis,
  });
  const errors = [
    call.error,
    described.mismatch
      ? `LiteLLM returned ${call.returnedModel} but Orchestra requested ${selected.model.id}. The response was not accepted.`
      : null,
    settled.costBasis === "unresolved"
      ? "The gateway may have accepted this request but reported no usage. The reservation stays locked as an unresolved cost."
      : null,
  ].filter(Boolean);
  const success = call.success && !described.mismatch;
  return {
    status: success ? "completed" : "failed",
    response: success ? (call.response ?? "") : "",
    actualCost: settled.costUsd,
    inputTokens: call.inputTokens ?? 0,
    outputTokens: call.outputTokens ?? 0,
    measuredLatencyMs: call.latencyMs,
    error: errors.length ? errors.join(" ") : null,
    gateway: {
      pool: pool.id,
      shadowPriced: pool.shadowPriced,
      requestedModel: selected.model.id,
      returnedModel: call.returnedModel,
      costBasis: settled.costBasis,
      reservedCost,
      attempts: call.attempts,
    },
  };
}
