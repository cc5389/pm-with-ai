import { buildPreview } from "../../lib/engine";
import { DEFAULT_COMPANY_POLICY } from "../../lib/policy";
import type { Preview, RequestInput, Settings } from "../../lib/types";
import type { RouterResult } from "../stage-a/adapters/base";
import { settleProviderCost } from "./accounting";
import {
  completeLiteLLM,
  type LiteLLMCompletion,
  type LiteLLMTransport,
} from "./litellm-client";
import {
  EVAL_MONTHLY_REQUESTS,
  EVAL_OUTPUT_TOKEN_CAP,
  EVAL_SIMULATED_DATE,
  EVAL_USER_ID,
  LITELLM_MODELS,
  SMART_ROUTER_ALIAS,
  conservativePoolCost,
  describeReturnedModel,
  estimateInputTokens,
  fullCapReservation,
  litellmProfiles,
} from "./model-pool";
import type { EvaluationRequest } from "./pipeline";
import type { PipelineExecution } from "./integrated-adapter";

const ESTIMATE_NOTE =
  "Estimated quality and latency are uncalibrated planning estimates, not guarantees. The reserved cost uses the frozen 2026-10-07 price snapshot and the full output cap.";

export interface PaidPlan {
  kind: "call";
  requestedModel: string;
  maxTokens: number;
  reservedCostUsd: number;
  inputTokens: number;
  preview: Preview | null;
  allowedModels: string[] | null;
  reason: string;
}

export interface RejectPlan {
  kind: "reject";
  reason: string;
  preview: Preview | null;
  allowedModels: string[] | null;
}

export type ExecutionPlan = PaidPlan | RejectPlan;

export interface PipelineOptions {
  transport?: LiteLLMTransport;
}

function evaluationSettings(request: EvaluationRequest): Settings {
  return {
    companyPolicy: { ...DEFAULT_COMPANY_POLICY },
    teamName: "Evaluation",
    monthlyBudget: request.organizationState.budgetUsd,
    monthlyRequests: EVAL_MONTHLY_REQUESTS,
    scenario: "custom",
    simulatedDate: EVAL_SIMULATED_DATE,
    openingSpend: 0,
    users: [
      {
        id: EVAL_USER_ID,
        name: "Evaluation",
        role: "experiment",
        budget: null,
      },
    ],
    blockedModels: [],
  };
}

function evaluationInput(request: EvaluationRequest): RequestInput {
  return {
    prompt: request.prompt,
    task: request.task,
    importance: request.organizationState.taskImportance,
    userId: EVAL_USER_ID,
    qualityFloor: request.organizationState.qualityFloor,
    latencyTarget: 30,
    strictLatency: false,
    maxRequestCost: null,
    outputTokens: EVAL_OUTPUT_TOKEN_CAP,
    weights: { quality: 0.8, cost: 0.15, latency: 0.05 },
    preferredModels: [],
    blockedModels: [],
    localOnly: false,
    mode: "simulation",
  };
}

function rejectionReason(preview: Preview): string {
  const because = [
    ...new Set(preview.candidates.flatMap((candidate) => candidate.reasons)),
  ].join(" ");
  return `Rejected before calling LiteLLM. ${because} ${ESTIMATE_NOTE}`;
}

export function planOrchestra(request: EvaluationRequest): ExecutionPlan {
  const preview = buildPreview(
    evaluationInput(request),
    evaluationSettings(request),
    litellmProfiles(),
    {
      spent: request.organizationState.spentUsd,
      reserved: 0,
      userSpent: 0,
      userReserved: 0,
      completedRequests: 0,
    },
  );
  const selected = preview.selected;
  if (!selected) {
    return {
      kind: "reject",
      reason: rejectionReason(preview),
      preview,
      allowedModels: preview.policy.allowedModels,
    };
  }
  const priced = LITELLM_MODELS.find((model) => model.alias === selected.model.id);
  if (!priced) {
    return {
      kind: "reject",
      reason: `Rejected ${selected.model.id} because it is not a configured LiteLLM alias. ${ESTIMATE_NOTE}`,
      preview,
      allowedModels: preview.policy.allowedModels,
    };
  }
  const reservedCostUsd = Math.max(
    selected.estimatedCost,
    fullCapReservation(priced, selected.inputTokens),
  );
  return {
    kind: "call",
    requestedModel: selected.model.id,
    maxTokens: EVAL_OUTPUT_TOKEN_CAP,
    reservedCostUsd,
    inputTokens: selected.inputTokens,
    preview,
    allowedModels: preview.policy.allowedModels,
    reason: `Selected ${selected.model.id} in lib/engine.ts and sent that alias to LiteLLM. The smart-router was not used. Quality estimates do not remove aliases from the shared pool. ${ESTIMATE_NOTE}`,
  };
}

export function planBaseline(request: EvaluationRequest): ExecutionPlan {
  const reserved = conservativePoolCost(request.prompt);
  const remaining =
    request.organizationState.budgetUsd - request.organizationState.spentUsd;
  const reason =
    "Baseline sends the smart-router alias. LiteLLM's adaptive router chooses the model with its own weights, and this request cannot give it an allow-list. The comparison is two policies; it does not isolate routing quality. The reservation is the most expensive configured model at the full output cap, including input tokens.";
  if (!(remaining > 0) || reserved > remaining + 1e-12) {
    return {
      kind: "reject",
      reason: `Rejected before calling LiteLLM. The remaining budget cannot reserve the most expensive shared-pool model at the output cap. ${reason}`,
      preview: null,
      allowedModels: null,
    };
  }
  return {
    kind: "call",
    requestedModel: SMART_ROUTER_ALIAS,
    maxTokens: EVAL_OUTPUT_TOKEN_CAP,
    reservedCostUsd: reserved,
    inputTokens: estimateInputTokens(request.prompt),
    preview: null,
    allowedModels: null,
    reason,
  };
}

function rejectedExecution(
  request: EvaluationRequest,
  plan: RejectPlan,
  applied: boolean,
  started: number,
): PipelineExecution {
  const generation: RouterResult = {
    router: "litellm",
    requestId: request.id,
    success: false,
    selectedModel: null,
    provider: null,
    response: null,
    latencyMs: Math.max(0, performance.now() - started),
    inputTokens: estimateInputTokens(request.prompt),
    outputTokens: 0,
    costUsd: 0,
    error: plan.reason,
    requestedModel: null,
    returnedModel: null,
    costBasis: "none",
    outcome: "rejected",
    reservedCostUsd: 0,
    attempts: 0,
    providerContacted: false,
    outputTokenCap: null,
  };
  return {
    generation,
    policy: {
      applied,
      allowedModels: plan.allowedModels,
      reason: plan.reason,
    },
  };
}

function mismatchMessage(requested: string, returned: string | null): string {
  if (requested === SMART_ROUTER_ALIAS) {
    return `LiteLLM returned ${returned}, which is outside the shared model pool.`;
  }
  return `LiteLLM returned ${returned} but Orchestra requested ${requested}. The gateway choice was not accepted.`;
}

function generationFromCall(
  request: EvaluationRequest,
  plan: PaidPlan,
  call: LiteLLMCompletion,
): RouterResult {
  const described = describeReturnedModel(
    plan.requestedModel,
    call.returnedModel,
  );
  const settled = settleProviderCost({
    reservedCostUsd: plan.reservedCostUsd,
    providerContacted: call.providerContacted,
    costUsd: call.costUsd,
    costBasis: call.costBasis,
  });
  let success = call.success && !described.mismatch;
  let outcome: RouterResult["outcome"] = success ? "completed" : "failed";
  let error = call.error;
  if (described.mismatch) {
    success = false;
    outcome = "failed";
    const note = mismatchMessage(plan.requestedModel, call.returnedModel);
    error = error ? `${error} ${note}` : note;
  }
  if (settled.costBasis === "unresolved") {
    const note =
      "The provider may have accepted this request, but it did not report a cost. The original reservation stays locked and is marked unresolved.";
    error = error ? `${error} ${note}` : note;
  }
  return {
    router: "litellm",
    requestId: request.id,
    success,
    selectedModel: described.selectedModel,
    provider: call.returnedModel ? "openai" : null,
    response: call.response,
    latencyMs: call.latencyMs,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    costUsd: settled.costUsd,
    error,
    requestedModel: plan.requestedModel,
    returnedModel: call.returnedModel,
    costBasis: settled.costBasis,
    outcome,
    reservedCostUsd: plan.reservedCostUsd,
    attempts: call.attempts,
    providerContacted: call.providerContacted,
    outputTokenCap: plan.maxTokens,
  };
}

async function executePlan(
  request: EvaluationRequest,
  plan: ExecutionPlan,
  applied: boolean,
  options: PipelineOptions,
): Promise<PipelineExecution> {
  const started = performance.now();
  if (plan.kind === "reject") {
    return rejectedExecution(request, plan, applied, started);
  }
  const call = await completeLiteLLM({
    model: plan.requestedModel,
    prompt: request.prompt,
    maxTokens: plan.maxTokens,
    transport: options.transport,
    remainingUsd:
      request.organizationState.budgetUsd - request.organizationState.spentUsd,
    reservedUsd: plan.reservedCostUsd,
  });
  return {
    generation: generationFromCall(request, plan, call),
    policy: {
      applied,
      allowedModels: plan.allowedModels,
      reason: plan.reason,
    },
  };
}

export function runBaseline(
  request: EvaluationRequest,
  options: PipelineOptions = {},
): Promise<PipelineExecution> {
  return executePlan(request, planBaseline(request), false, options);
}

export function runOrchestra(
  request: EvaluationRequest,
  options: PipelineOptions = {},
): Promise<PipelineExecution> {
  return executePlan(request, planOrchestra(request), true, options);
}
