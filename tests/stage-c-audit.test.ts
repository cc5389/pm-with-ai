import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { timeoutMs } from "../eval/shared/timeout";
import { judgeConfig, judgeResponse } from "../eval/shared/judge";
import { buildStageCWorkload } from "../eval/stage-c/workload";
import {
  planOrchestra,
  runOrchestra,
  runBaseline,
} from "../eval/shared/pipelines";
import {
  EVAL_OUTPUT_TOKEN_CAP,
  readCalibration,
} from "../eval/shared/model-pool";
import { summarizeStageC } from "../eval/stage-c/report";
import {
  assertNoPendingAttempt,
  restoreCheckpoint,
} from "../eval/stage-c/checkpoint";
import { IntegratedEvaluationAdapter } from "../eval/shared/integrated-adapter";
import { accountIndependent } from "../eval/shared/accounting";
import type { EvaluationRequest } from "../eval/shared/pipeline";

async function withEnv(
  values: Record<string, string | undefined>,
  action: () => void | Promise<void>,
) {
  const before = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await action();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
function request(): EvaluationRequest {
  return {
    ...buildStageCWorkload()[0],
    scenarioId: "stage-c-orchestra-fixed-1",
    importanceMode: "fixed",
    organizationState: {
      budgetUsd: 0.1,
      spentUsd: 0,
      budgetUsedFraction: 0,
      taskImportance: "high",
      qualityFloor: 0.75,
    },
  };
}
const ollamaEnv = {
  ORCHESTRA_POOL: "ollama",
  ORCHESTRA_CALIBRATION_PATH: "eval/results/calibration/ollama-quality.json",
  LITELLM_MASTER_KEY: "test-only-not-a-real-secret",
};

test("timeouts are configurable, validated, and allow slow inference", () => {
  assert.equal(timeoutMs("TIMEOUT", 600_000, {}), 600_000);
  assert.equal(timeoutMs("TIMEOUT", 600_000, { TIMEOUT: "900000" }), 900_000);
  for (const raw of ["NaN", "0", "-1", "Infinity", "1.5", "2147483648", ""])
    assert.throws(
      () => timeoutMs("TIMEOUT", 600_000, { TIMEOUT: raw }),
      /positive integer/,
    );
  assert.equal(
    judgeConfig({
      JUDGE_BASE_URL: "http://127.0.0.1:11434/v1",
      JUDGE_TIMEOUT_MS: "900000",
    }).timeoutMs,
    900_000,
  );
});
test("measured Gemma calibration preserves five inferred coding policy rejections at $0.10", async () => {
  await withEnv(ollamaEnv, async () => {
    assert.equal(EVAL_OUTPUT_TOKEN_CAP, 1024);
    assert.ok(readCalibration("ollama"));
    const records = [];
    for (const item of buildStageCWorkload(5)) {
      const req = {
        ...request(),
        ...item,
        importanceMode: "inferred" as const,
        scenarioId: `stage-c-orchestra-inferred-${item.sequenceIndex + 1}`,
      };
      const plan = planOrchestra(req);
      assert.equal(plan.kind, "reject");
      assert.equal(plan.preview!.policy.importance, "medium");
      assert.equal(plan.preview!.policy.maxCostPerRequest, 0.0015);
      const mini = plan.preview!.candidates.find(
        (c) => c.model.id === "gemma3-4b",
      )!;
      assert.ok(mini.estimatedQuality >= 0.75);
      assert.ok(mini.estimatedCost > 0.0015);
      const nano = plan.preview!.candidates.find(
        (c) => c.model.id === "gemma3-1b",
      )!;
      assert.ok(nano.estimatedQuality < 0.75);
      const adapter = new IntegratedEvaluationAdapter("orchestra", (r) =>
        runOrchestra(r, {
          transport: async () => {
            throw new Error("Policy rejection must never call transport");
          },
        }),
      );
      const result = await adapter.execute(req);
      result.stateBefore.taskImportance = "medium";
      result.stateAfter = accountIndependent(
        result.stateBefore,
        result.generation.costUsd,
      );
      records.push({
        variant: "orchestra-inferred",
        sequenceIndex: item.sequenceIndex,
        result,
      });
    }
    const group = summarizeStageC(records, []).groups["orchestra-inferred/all"];
    assert.equal(group.policyRejections, 5);
    assert.equal(group.providerFailures, 0);
    assert.equal(group.successfulGenerations, 0);
    assert.equal(group.observedPassRate, null);
    assert.equal(group.overallSuccessfulServiceRate, 0);
    restoreCheckpoint(
      "orchestra",
      records,
      buildStageCWorkload(5).map((w) => ({ ...w, taskImportance: "medium" })),
      0.1,
      "orchestra-inferred",
    );
  });
});
test("routing estimates and classification are captured before transport; interrupted saves block calls", async () => {
  await withEnv(ollamaEnv, async () => {
    const req = request();
    let saved = false;
    const plan = planOrchestra(req);
    assert.equal(plan.kind, "call");
    const output = await runOrchestra(req, {
      onPlanned: async (policy, reservation) => {
        assert.equal(
          policy!.predictedQuality,
          plan.preview!.selected!.estimatedQuality,
        );
        assert.equal(policy!.requestedModel, "gemma3-4b");
        assert.ok(reservation > 0);
        saved = true;
      },
      transport: async () => {
        assert.equal(saved, true);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "test response" } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { headers: { "x-litellm-model-name": "gemma3-4b" } },
        );
      },
    });
    assert.equal(output.policy!.predictionTiming, "before-generation");
    assert.equal(
      output.policy!.predictedQuality,
      plan.preview!.selected!.estimatedQuality,
    );
    await assert.rejects(
      () =>
        runOrchestra(req, {
          onPlanned: async () => {
            throw new Error("checkpoint unavailable");
          },
          transport: async () => {
            assert.fail("must save before sending");
          },
        }),
      /checkpoint unavailable/,
    );
    assert.throws(
      () =>
        assertNoPendingAttempt({ pendingAttempt: { reservedCostUsd: 0.01 } }),
      /Do not retry automatically/,
    );
    assert.doesNotThrow(() => assertNoPendingAttempt({}));
  });
});
test("baseline prediction uses a profile snapshot before the gateway selects its model", async () => {
  await withEnv(ollamaEnv, async () => {
    let before: number | undefined;
    const output = await runBaseline(request(), {
      onPlanned: async (policy) => {
        assert.equal(policy!.predictedQuality, null);
        before = policy!.qualitySnapshot!.find(
          (p) => p.model === "gemma3-4b",
        )!.quality;
      },
      transport: async () => {
        assert.ok(before);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "test" } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { headers: { "x-litellm-adaptive-router-model": "gemma3-4b" } },
        );
      },
    });
    assert.equal(output.policy!.predictedQuality, before);
    assert.equal(
      output.policy!.predictionTiming,
      "pre-generation-snapshot-post-gateway-selection",
    );
  });
});
test("local Qwen judgment disables thinking on initial and retry requests without real inference", async () => {
  await withEnv(
    {
      JUDGE_BASE_URL: "http://127.0.0.1:11434/v1",
      JUDGE_MODEL: "qwen3.5-judge",
      JUDGE_TIMEOUT_MS: "900000",
    },
    async () => {
      let calls = 0;
      const result = await judgeResponse(
        request(),
        {
          router: "litellm",
          requestId: request().id,
          success: true,
          selectedModel: "gemma3-4b",
          response: "test answer",
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
          error: null,
        },
        0.75,
        {
          fetch: async (_input, init) => {
            calls++;
            const body = JSON.parse(String(init?.body));
            assert.equal(body.model, "qwen3.5-judge");
            assert.equal(body.reasoning_effort, "none");
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content:
                        calls === 1
                          ? "invalid json"
                          : JSON.stringify({
                              correctness: 4,
                              completeness: 4,
                              instructionFollowing: 4,
                              reasoning: "test judgment",
                            }),
                    },
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 20 },
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        },
      );
      assert.equal(calls, 2);
      assert.equal(result.overallScore, 0.75);
      assert.equal(result.passed, true);
      assert.equal(result.judgeCostUsd, 0);
    },
  );
});
test("invalid LiteLLM timeout fails before transport and is not charged", async () => {
  await withEnv({ ...ollamaEnv, LITELLM_TIMEOUT_MS: "invalid" }, async () => {
    await assert.rejects(
      () =>
        runBaseline(request(), {
          transport: async () => {
            assert.fail("invalid configuration must not send a request");
          },
        }),
      /LITELLM_TIMEOUT_MS/,
    );
  });
});
test("service rates stay unknown until successful generations have judgments", async () => {
  await withEnv(ollamaEnv, async () => {
    const adapter = new IntegratedEvaluationAdapter("baseline", (r) =>
      runBaseline(r, {
        transport: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "test" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { headers: { "x-litellm-adaptive-router-model": "gemma3-4b" } },
          ),
      }),
    );
    const result = await adapter.execute(request());
    const records = [{ variant: "baseline", sequenceIndex: 0, result }];
    const group = summarizeStageC(records, []).groups["baseline/all"];
    assert.equal(group.generationSuccessRate, 1);
    assert.equal(group.overallSuccessfulServiceRate, null);
    assert.equal(group.judgmentCoverage, 0);
    const judged = summarizeStageC(records, [
      { scenarioId: result.scenarioId, overallScore: 0.8, passed: true },
    ]).groups["baseline/all"];
    assert.equal(judged.overallSuccessfulServiceRate, 1);
    assert.equal(judged.observedPassRate, 1);
  });
});
test("Ollama gateway master key is sourced from the environment", () => {
  assert.match(
    readFileSync("eval/litellm/ollama.yaml", "utf8"),
    /master_key: os.environ\/LITELLM_MASTER_KEY/,
  );
});
