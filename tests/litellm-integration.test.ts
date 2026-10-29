import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BudgetTracker } from "../eval/stage-c/budget";
import { evaluateConstraints } from "../eval/stage-b/constraints";
import {
  accountIndependent,
  allowProviderRetry,
  applyExperimentCost,
  settleProviderCost,
} from "../eval/shared/accounting";
import { summarizeComparison } from "../eval/shared/comparison";
import { IntegratedEvaluationAdapter } from "../eval/shared/integrated-adapter";
import {
  completeLiteLLM,
  isRetryableConnectionError,
  type LiteLLMTransport,
} from "../eval/shared/litellm-client";
import {
  EVAL_OUTPUT_TOKEN_CAP,
  canonicalAlias,
  estimatedRequestCost,
  estimateInputTokens,
  fullCapReservation,
  LITELLM_MODELS,
  mostExpensiveEligibleModel,
} from "../eval/shared/model-pool";
import {
  planBaseline,
  planOrchestra,
  runBaseline,
  runOrchestra,
} from "../eval/shared/pipelines";
import {
  assertPaidRunIsExplicit,
  executionLimit,
  executionMode,
} from "../eval/shared/run-mode";
import { calculateGenerationCost } from "../eval/shared/pricing";
import type { EvaluationRequest, EvaluationResult } from "../eval/shared/pipeline";
import { history } from "../lib/db";

process.env.ORCHESTRA_DB_PATH = ":memory:";

const ORIGINAL = {
  url: process.env.LITELLM_URL,
  key: process.env.LITELLM_MASTER_KEY,
};

beforeEach(() => {
  process.env.LITELLM_URL = "http://127.0.0.1:4000/v1/chat/completions";
  process.env.LITELLM_MASTER_KEY = "test-gateway-master-key";
});

afterEach(() => {
  restore("LITELLM_URL", ORIGINAL.url);
  restore("LITELLM_MASTER_KEY", ORIGINAL.key);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function request(
  state: Partial<EvaluationRequest["organizationState"]> = {},
  fields: Partial<EvaluationRequest> = {},
): EvaluationRequest {
  return {
    id: "req-1",
    prompt: "Hi",
    task: "qa",
    rubric: "Answer briefly.",
    scenarioId: "scenario-1",
    ...fields,
    organizationState: {
      budgetUsd: 10,
      spentUsd: 1,
      budgetUsedFraction: 0.1,
      taskImportance: "high",
      qualityFloor: 0.75,
      ...state,
    },
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function completion(
  headers: Record<string, string> = {},
  body: unknown = {
    choices: [{ message: { content: "gateway text" } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  },
): Response {
  return jsonResponse(body, 200, headers);
}

function capturing(responses: Array<Response | Error>): {
  calls: Array<{ url: string; init: RequestInit }>;
  transport: LiteLLMTransport;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: LiteLLMTransport = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra LiteLLM call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, transport };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function connectionError(message = "connect failed"): Error {
  return Object.assign(new Error(message), {
    cause: { code: "ECONNREFUSED" },
  });
}

test("execution mode defaults to mock and a real run requires a limit", () => {
  assert.equal(executionMode({}), "mock");
  assert.equal(executionLimit({}), null);
  assert.equal(executionLimit({ EVAL_LIMIT: "2" }), 2);
  assert.throws(
    () => executionMode({ EVAL_EXECUTION: "live" }),
    /EVAL_EXECUTION must be/,
  );
  assert.throws(() => executionLimit({ EVAL_LIMIT: "0" }), /positive integer/);
  assert.doesNotThrow(() => assertPaidRunIsExplicit("mock", null));
  assert.throws(
    () => assertPaidRunIsExplicit("real", null),
    /unbounded paid run/,
  );
  assert.doesNotThrow(() => assertPaidRunIsExplicit("real", 1));
});

test("Orchestra selects one configured alias and reserves input plus the full output cap", async () => {
  const sample = request();
  const planned = planOrchestra(sample);
  assert.equal(planned.kind, "call");
  if (planned.kind !== "call") return;
  assert.deepEqual([...(planned.allowedModels ?? [])].sort(), [
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
  ]);
  assert.equal(planned.maxTokens, EVAL_OUTPUT_TOKEN_CAP);
  const priced = LITELLM_MODELS.find(
    (model) => model.alias === planned.requestedModel,
  );
  assert.ok(priced);
  const expectedReservation =
    (planned.inputTokens * priced.inputPerMillion +
      EVAL_OUTPUT_TOKEN_CAP * priced.outputPerMillion) /
    1e6;
  assert.ok(Math.abs(planned.reservedCostUsd - expectedReservation) < 1e-12);
  assert.equal(planned.reason.includes("smart-router was not used"), true);
  assert.equal(planned.reason.includes("not guarantees"), true);

  const returned = `openai/${priced.providerModel}`;
  const { calls, transport } = capturing([
    completion({
      "x-litellm-response-cost": "0.000001",
      "x-litellm-model-name": returned,
    }),
  ]);
  const output = await runOrchestra(sample, { transport });
  assert.equal(calls.length, 1);
  const body = bodyOf(calls[0].init);
  assert.deepEqual(Object.keys(body).sort(), [
    "max_tokens",
    "messages",
    "model",
    "temperature",
  ]);
  assert.equal(body.model, planned.requestedModel);
  assert.equal(body.max_tokens, 256);
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
  assert.equal(JSON.stringify(body).includes("smart-router"), false);
  assert.equal(JSON.stringify(body).includes("test-gateway-master-key"), false);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-gateway-master-key");
  assert.equal(output.generation.requestedModel, planned.requestedModel);
  assert.equal(output.generation.returnedModel, returned);
  assert.equal(output.generation.selectedModel, planned.requestedModel);
  assert.equal(output.generation.success, true);
  assert.equal(output.generation.outcome, "completed");
  assert.equal(output.policy?.applied, true);
  assert.equal(output.policy?.allowedModels?.includes("gpt-4.1"), true);
});

test("the same budget sends smart-router for baseline and the engine alias for Orchestra", async () => {
  const tight = request({
    budgetUsd: 0.02,
    spentUsd: 0,
    budgetUsedFraction: 0,
    taskImportance: "low",
    qualityFloor: 0,
  });
  const orchestraPlan = planOrchestra(tight);
  const baselinePlan = planBaseline(tight);
  assert.equal(orchestraPlan.kind, "call", JSON.stringify(orchestraPlan));
  assert.equal(baselinePlan.kind, "call", JSON.stringify(baselinePlan));
  if (orchestraPlan.kind !== "call" || baselinePlan.kind !== "call") return;
  assert.equal(orchestraPlan.requestedModel, "gpt-4.1-nano");
  assert.equal(baselinePlan.requestedModel, "smart-router");
  const expensive = mostExpensiveEligibleModel();
  assert.equal(expensive.alias, "gpt-4.1");
  assert.ok(
    Math.abs(
      baselinePlan.reservedCostUsd -
        fullCapReservation(expensive, estimateInputTokens(tight.prompt)),
    ) < 1e-12,
  );
  assert.ok(baselinePlan.reservedCostUsd > orchestraPlan.reservedCostUsd);

  const orchestra = capturing([
    completion({ "x-litellm-model-name": "gpt-4.1-nano" }),
  ]);
  const baseline = capturing([
    completion({ "x-litellm-adaptive-router-model": "gpt-4.1-mini" }),
  ]);
  const orchestraResult = await runOrchestra(tight, {
    transport: orchestra.transport,
  });
  const baselineResult = await runBaseline(tight, {
    transport: baseline.transport,
  });
  assert.equal(bodyOf(orchestra.calls[0].init).model, "gpt-4.1-nano");
  assert.equal(bodyOf(baseline.calls[0].init).model, "smart-router");
  assert.equal(baselineResult.policy?.applied, false);
  assert.equal(baselineResult.generation.selectedModel, "gpt-4.1-mini");
  assert.equal(orchestraResult.generation.requestedModel, "gpt-4.1-nano");
});

test("ineligible models and an unaffordable baseline reservation do not call LiteLLM", async () => {
  const blocked = capturing([]);
  const rejected = await runOrchestra(
    request({ qualityFloor: 0.99 }),
    { transport: blocked.transport },
  );
  assert.equal(blocked.calls.length, 0);
  assert.equal(rejected.generation.outcome, "rejected");
  assert.equal(rejected.generation.success, false);
  assert.equal(rejected.generation.costUsd, 0);
  assert.equal(rejected.generation.costBasis, "none");
  assert.equal(rejected.generation.providerContacted, false);
  assert.equal(rejected.generation.response, null);
  assert.equal(rejected.policy?.applied, true);
  assert.match(rejected.generation.error ?? "", /quality/i);

  const baseline = capturing([]);
  const unaffordable = await runBaseline(
    request({ budgetUsd: 0.00001, spentUsd: 0, budgetUsedFraction: 0 }),
    { transport: baseline.transport },
  );
  assert.equal(baseline.calls.length, 0);
  assert.equal(unaffordable.generation.outcome, "rejected");
  assert.equal(unaffordable.generation.costUsd, 0);
  assert.match(unaffordable.generation.error ?? "", /most expensive/);
});

test("a zero budget is rejected before a paid request", async () => {
  const { calls, transport } = capturing([]);
  const output = await runOrchestra(
    request({ budgetUsd: 0, spentUsd: 0, budgetUsedFraction: 0, qualityFloor: 0 }),
    { transport },
  );
  assert.equal(calls.length, 0);
  assert.equal(output.generation.outcome, "rejected");
  assert.match(output.generation.error ?? "", /zero/i);
});

test("actual gateway cost replaces the reservation and an estimate is labeled", async () => {
  const reserved = planOrchestra(request());
  assert.equal(reserved.kind, "call");
  if (reserved.kind !== "call") return;
  const { transport } = capturing([
    completion({
      "x-litellm-response-cost": "0.000001",
      "x-litellm-model-name": "gpt-4.1",
    }),
  ]);
  const actual = await runOrchestra(request(), { transport });
  assert.equal(actual.generation.costUsd, 0.000001);
  assert.equal(actual.generation.costBasis, "actual");
  assert.equal(actual.generation.reservedCostUsd, reserved.reservedCostUsd);
  assert.ok((actual.generation.costUsd ?? 0) < reserved.reservedCostUsd);

  const estimatedTransport = capturing([
    completion(
      { "x-litellm-model-name": "gpt-4.1-2025-04-14" },
      {
        choices: [{ message: { content: "gateway text" } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
    ),
  ]);
  const estimated = await runOrchestra(request(), {
    transport: estimatedTransport.transport,
  });
  assert.equal(estimated.generation.costBasis, "estimated");
  assert.equal(
    estimated.generation.costUsd,
    calculateGenerationCost("gpt-4.1-2025-04-14", 10, 20),
  );
  assert.equal(estimated.generation.inputTokens, 10);
  assert.equal(estimated.generation.outputTokens, 20);
  assert.ok((estimated.generation.latencyMs ?? -1) >= 0);
});

test("failures are not replaced with mock text, and a connection retry is charged once", async () => {
  const serverError = capturing([
    jsonResponse({ error: { message: "bad test-gateway-master-key" } }, 500),
  ]);
  const failed = await runOrchestra(request(), {
    transport: serverError.transport,
  });
  assert.equal(serverError.calls.length, 1);
  assert.equal(failed.generation.success, false);
  assert.equal(failed.generation.outcome, "failed");
  assert.equal(failed.generation.response, null);
  assert.equal(failed.generation.providerContacted, true);
  assert.equal(
    (failed.generation.error ?? "").includes("test-gateway-master-key"),
    false,
  );
  assert.equal((failed.generation.error ?? "").includes("Mock"), false);
  assert.equal((failed.generation.response ?? "").includes("Mock"), false);

  const retried = capturing([
    connectionError("connect test-gateway-master-key"),
    completion({
      "x-litellm-response-cost": "0.01",
      "x-litellm-model-name": "gpt-4.1",
    }),
  ]);
  const recovered = await runOrchestra(request(), {
    transport: retried.transport,
  });
  assert.equal(retried.calls.length, 2);
  assert.equal(recovered.generation.attempts, 2);
  assert.equal(recovered.generation.costUsd, 0.01);
  assert.equal(recovered.generation.costBasis, "actual");
  assert.notEqual(recovered.generation.costUsd, 0.02);

  const timedOut = capturing([
    Object.assign(new Error("timed out"), { name: "TimeoutError" }),
  ]);
  const timeoutPlan = planOrchestra(request());
  assert.equal(timeoutPlan.kind, "call");
  if (timeoutPlan.kind !== "call") return;
  const timeout = await runOrchestra(request(), {
    transport: timedOut.transport,
  });
  assert.equal(timedOut.calls.length, 1);
  assert.equal(timeout.generation.attempts, 1);
  assert.equal(timeout.generation.costBasis, "unresolved");
  assert.equal(timeout.generation.costUsd, timeoutPlan.reservedCostUsd);
  assert.equal(timeout.generation.providerContacted, true);
  assert.equal(timeout.generation.response, null);

  const refused = capturing([
    connectionError(),
    connectionError(),
  ]);
  const offline = await runOrchestra(request(), { transport: refused.transport });
  assert.equal(refused.calls.length, 2);
  assert.equal(offline.generation.costUsd, 0);
  assert.equal(offline.generation.costBasis, "none");
  assert.equal(offline.generation.providerContacted, false);
});

test("versioned ids match the requested alias, and a different model keeps its cost", async () => {
  assert.equal(canonicalAlias("gpt-4.1"), "gpt-4.1");
  assert.equal(canonicalAlias("gpt-4.1-2025-04-14"), "gpt-4.1");
  assert.equal(canonicalAlias("openai/gpt-4.1-2025-04-14"), "gpt-4.1");
  assert.equal(canonicalAlias("gpt-4.1-mini-2025-04-14"), "gpt-4.1-mini");
  assert.equal(canonicalAlias("openai/gpt-4.1-nano-2025-04-14"), "gpt-4.1-nano");
  assert.equal(canonicalAlias("gpt-4.1-mini"), "gpt-4.1-mini");
  assert.notEqual(canonicalAlias("gpt-4.1-mini"), "gpt-4.1");
  assert.equal(canonicalAlias("gpt-4o"), null);

  const sample = request();
  const planned = planOrchestra(sample);
  assert.equal(planned.kind, "call");
  if (planned.kind !== "call") return;
  const priced = LITELLM_MODELS.find(
    (model) => model.alias === planned.requestedModel,
  );
  const other = LITELLM_MODELS.find(
    (model) => model.alias !== planned.requestedModel,
  );
  assert.ok(priced && other);
  const matched = await runOrchestra(sample, {
    transport: capturing([
      completion({
        "x-litellm-response-cost": "0.000001",
        "x-litellm-model-name": priced.providerModel,
      }),
    ]).transport,
  });
  assert.equal(matched.generation.success, true);
  assert.equal(matched.generation.requestedModel, planned.requestedModel);
  assert.equal(matched.generation.returnedModel, priced.providerModel);
  assert.equal(matched.generation.selectedModel, planned.requestedModel);

  const mismatched = await runOrchestra(sample, {
    transport: capturing([
      completion({
        "x-litellm-response-cost": "0.004",
        "x-litellm-model-name": other.providerModel,
      }),
    ]).transport,
  });
  assert.equal(mismatched.generation.success, false);
  assert.equal(mismatched.generation.requestedModel, planned.requestedModel);
  assert.equal(mismatched.generation.returnedModel, other.providerModel);
  assert.equal(mismatched.generation.selectedModel, other.providerModel);
  assert.equal(mismatched.generation.costUsd, 0.004);
  assert.equal(mismatched.generation.costBasis, "actual");
  assert.match(mismatched.generation.error ?? "", /not accepted/);
  assert.equal(mismatched.generation.response, "gateway text");
});

test("a missing gateway password or a public URL fails before any request", async () => {
  delete process.env.LITELLM_MASTER_KEY;
  const missing = capturing([]);
  await assert.rejects(
    () => runOrchestra(request(), { transport: missing.transport }),
    /LITELLM_MASTER_KEY/,
  );
  assert.equal(missing.calls.length, 0);

  process.env.LITELLM_MASTER_KEY = "test-gateway-master-key";
  const remote = capturing([]);
  await assert.rejects(
    () =>
      completeLiteLLM({
        model: "gpt-4.1",
        prompt: "Hi",
        maxTokens: 16,
        url: "https://example.com/v1/chat/completions",
        transport: remote.transport,
      }),
    /loopback/,
  );
  assert.equal(remote.calls.length, 0);
  assert.equal(isRetryableConnectionError(connectionError()), true);
  assert.equal(
    isRetryableConnectionError(
      Object.assign(new Error("slow"), { name: "TimeoutError" }),
    ),
    false,
  );
});

test("retries cannot spend a second reservation the budget does not cover", async () => {
  const expensive = mostExpensiveEligibleModel();
  const reserved = fullCapReservation(expensive, estimateInputTokens("Hi"));
  const start = {
    budgetUsd: reserved * 1.5,
    spentUsd: 0,
    budgetUsedFraction: 0,
    taskImportance: "low" as const,
    qualityFloor: 0,
  };
  assert.equal(
    allowProviderRetry({
      attempt: 1,
      providerContacted: false,
      connectionError: true,
      remainingUsd: start.budgetUsd,
      reservedUsd: reserved,
    }),
    false,
  );
  assert.equal(
    allowProviderRetry({
      attempt: 1,
      providerContacted: true,
      connectionError: false,
      remainingUsd: 100,
      reservedUsd: reserved,
    }),
    false,
  );

  const queued = capturing([
    connectionError(),
    completion({
      "x-litellm-response-cost": String(reserved),
      "x-litellm-adaptive-router-model": expensive.providerModel,
    }),
  ]);
  const output = await runBaseline(request(start), {
    transport: queued.transport,
  });
  assert.equal(queued.calls.length, 1);
  assert.equal(output.generation.attempts, 1);
  assert.equal(output.generation.costUsd, 0);
  assert.ok((output.generation.costUsd ?? 0) < start.budgetUsd);

  const billed = capturing([
    completion({
      "x-litellm-response-cost": "0.2",
      "x-litellm-model-name": "gpt-4.1",
    }),
    completion({
      "x-litellm-response-cost": "0.2",
      "x-litellm-model-name": "gpt-4.1",
    }),
  ]);
  const once = await runOrchestra(request(), { transport: billed.transport });
  assert.equal(billed.calls.length, 1);
  assert.equal(once.generation.costUsd, 0.2);
  assert.notEqual(once.generation.costUsd, 0.4);

  const locked = capturing([
    Object.assign(new Error("timed out"), { name: "TimeoutError" }),
  ]);
  const unresolved = await runBaseline(request(start), {
    transport: locked.transport,
  });
  assert.equal(unresolved.generation.costBasis, "unresolved");
  assert.ok(
    Math.abs((unresolved.generation.costUsd ?? -1) - reserved) < 1e-9,
  );
  const after = accountIndependent(start, unresolved.generation.costUsd);
  assert.ok(Math.abs(after.spentUsd - reserved) < 1e-9);
  assert.equal(planBaseline(request(after)).kind, "reject");
  assert.equal(
    settleProviderCost({
      reservedCostUsd: reserved,
      providerContacted: true,
      costUsd: 0.004,
      costBasis: "actual",
    }).costUsd,
    0.004,
  );
});

test("evaluation accounting is separate from app history and updates once", async () => {
  const before = history().length;
  const sample = request();
  const tracker = new BudgetTracker(
    sample.organizationState.budgetUsd,
    sample.organizationState.spentUsd,
  );
  const { transport } = capturing([
    completion({
      "x-litellm-response-cost": "0.002",
      "x-litellm-model-name": "gpt-4.1",
    }),
  ]);
  const adapter = new IntegratedEvaluationAdapter("orchestra", (item) =>
    runOrchestra(item, { transport }),
  );
  const result = await adapter.execute(sample);
  assert.equal(history().length, before);
  assert.equal(result.stateAfter, null);
  assert.equal(tracker.snapshot().spentUsd, sample.organizationState.spentUsd);

  const once = accountIndependent(sample.organizationState, result.generation.costUsd);
  const repeated = accountIndependent(
    sample.organizationState,
    result.generation.costUsd,
  );
  assert.ok(Math.abs(once.spentUsd - 1.002) < 1e-12);
  assert.equal(repeated.spentUsd, once.spentUsd);
  assert.equal(sample.organizationState.spentUsd, 1);

  const sequential = new BudgetTracker(1, 0);
  applyExperimentCost(sequential, 0.2);
  applyExperimentCost(sequential, 0.05);
  assert.ok(Math.abs(sequential.snapshot().spentUsd - 0.25) < 1e-12);
  assert.throws(() => applyExperimentCost(sequential, null), /known nonnegative/);
  assert.ok(Math.abs(sequential.snapshot().spentUsd - 0.25) < 1e-12);

  const pipelineSource = await readFile("eval/shared/pipelines.ts", "utf8");
  assert.equal(pipelineSource.includes("saveRecord"), false);
  assert.equal(pipelineSource.includes("recordCost"), false);
  assert.equal(pipelineSource.includes("lib/db"), false);
  assert.equal(pipelineSource.includes("mock-adapter"), false);
});

test("comparison reports rates, cost, and budget violations without a savings claim", async () => {
  const rejected = await runOrchestra(request({ qualityFloor: 0.99 }), {
    transport: async () => {
      throw new Error("should not call");
    },
  });
  const rejectedResult: EvaluationResult = {
    system: "orchestra",
    scenarioId: "scenario-1",
    requestId: "req-1",
    ...rejected,
    stateBefore: request({ qualityFloor: 0.99 }).organizationState,
    stateAfter: accountIndependent(
      request({ qualityFloor: 0.99 }).organizationState,
      rejected.generation.costUsd,
    ),
  };
  const constraint = evaluateConstraints(
    request({ qualityFloor: 0.99 }),
    rejectedResult,
  );
  assert.equal(constraint.allowedModelCompliant, null);
  assert.equal(constraint.policyApplied, true);
  assert.equal(constraint.budgetFeasible, true);
  assert.equal(
    constraint.violations.some((item) => item.includes("allowedModels")),
    false,
  );

  const overspend: EvaluationResult = {
    system: "baseline",
    scenarioId: "scenario-2",
    requestId: "req-2",
    generation: {
      router: "litellm",
      requestId: "req-2",
      success: true,
      selectedModel: "gpt-4.1",
      response: "gateway text",
      latencyMs: 10,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 3,
      costBasis: "actual",
      outcome: "completed",
      error: null,
    },
    policy: null,
    stateBefore: {
      budgetUsd: 10,
      spentUsd: 8,
      budgetUsedFraction: 0.8,
      taskImportance: "low",
      qualityFloor: 0,
    },
    stateAfter: {
      budgetUsd: 10,
      spentUsd: 11,
      budgetUsedFraction: 1.1,
      taskImportance: "low",
      qualityFloor: 0,
    },
  };
  const mockReport = summarizeComparison(
    [rejectedResult, overspend],
    "mock",
  );
  assert.equal(mockReport.quality, null);
  assert.equal(mockReport.savingsClaimAllowed, false);
  assert.match(mockReport.savingsNote, /Do not claim savings/);
  assert.equal(mockReport.completed, 1);
  assert.equal(mockReport.rejected, 1);
  assert.equal(mockReport.completionRate, 0.5);
  assert.equal(mockReport.rejectionRate, 0.5);
  assert.equal(mockReport.totalCostUsd, 3);
  assert.equal(mockReport.budgetViolations, 1);
  assert.equal(JSON.stringify(mockReport).includes('"savings":'), false);

  const realReport = summarizeComparison([overspend], "real");
  assert.match(realReport.savingsNote, /does not convert/);
  assert.equal(realReport.savingsNote.includes("Do not claim savings"), false);
  assert.equal(realReport.isolatesRoutingQuality, false);
  assert.match(realReport.policyNote, /does not isolate routing quality/);

  const inputTokens = estimateInputTokens("Hi");
  const nano = LITELLM_MODELS.find((model) => model.alias === "gpt-4.1-nano");
  assert.ok(nano);
  assert.ok(estimatedRequestCost(nano!, inputTokens, 256) > 0);
});
