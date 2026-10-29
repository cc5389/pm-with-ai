import { BENCHMARK_PROMPTS } from "../../lib/benchmark";
import type { Task } from "../../lib/types";
import { readCheckpoint, writeCheckpoint } from "../shared/checkpoint-io";
import type { QualityJudgment } from "../shared/judge";
import { completeLiteLLM } from "../shared/litellm-client";
import {
  EVAL_OUTPUT_TOKEN_CAP,
  activePool,
  calibrationPath,
  describeReturnedModel,
  fullCapReservation,
  estimateInputTokens,
  type PoolCalibration,
} from "../shared/model-pool";
import { assertPaidRunIsExplicit, executionLimit } from "../shared/run-mode";
import type { RouterRequest, RouterResult } from "../stage-a/adapters/base";

/**
 * Measures each alias of the active pool on the 20 calibration prompts.
 * Phase 1 generates every answer, one model at a time so Ollama keeps a single
 * model loaded; phase 2 judges them. Held-out evaluation prompts are never used.
 */

interface Generation {
  alias: string;
  requestId: string;
  task: Task;
  success: boolean;
  response: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  returnedModel: string | null;
  error: string | null;
}

interface SavedRuns {
  pool: string;
  generations: Generation[];
  judgments: (QualityJudgment & { alias: string })[];
}

const TASKS: Task[] = ["coding", "analysis", "writing", "qa"];

async function main() {
  const pool = activePool();
  const limit = executionLimit();
  assertPaidRunIsExplicit("real", limit, pool);

  const requests: RouterRequest[] = BENCHMARK_PROMPTS.filter(
    (item) => item.split === "calibration",
  )
    .slice(0, limit ?? undefined)
    .map((item) => ({
      id: item.id,
      task: item.task,
      prompt: item.prompt,
      rubric: item.rubric,
    }));

  const runsPath = `eval/results/calibration/${pool.id}-runs.json`;
  const saved = await readCheckpoint<SavedRuns>(runsPath);
  if (saved && saved.pool !== pool.id) {
    throw new Error(`${runsPath} belongs to another pool.`);
  }
  const generations = saved?.generations ?? [];
  const judgments = saved?.judgments ?? [];
  const save = () =>
    writeCheckpoint(runsPath, {
      pool: pool.id,
      updatedAt: new Date().toISOString(),
      generations,
      judgments,
    });

  console.log(`Pool: ${pool.label}`);
  console.log(`Calibration prompts: ${requests.length}`);

  for (const model of pool.models) {
    const pending = requests.filter(
      (request) =>
        !generations.some(
          (g) => g.alias === model.alias && g.requestId === request.id,
        ),
    );
    if (!pending.length) continue;
    // Unrecorded warm-up so the first measured latency does not include model loading.
    await completeLiteLLM({
      model: model.alias,
      prompt: "Reply with OK.",
      maxTokens: 8,
    });
    for (const request of pending) {
      const reserved = fullCapReservation(
        model,
        estimateInputTokens(request.prompt),
      );
      const call = await completeLiteLLM({
        model: model.alias,
        prompt: request.prompt,
        maxTokens: EVAL_OUTPUT_TOKEN_CAP,
        remainingUsd: reserved * 2,
        reservedUsd: reserved,
      });
      const described = describeReturnedModel(model.alias, call.returnedModel);
      const success = call.success && !described.mismatch;
      generations.push({
        alias: model.alias,
        requestId: request.id,
        task: request.task,
        success,
        response: call.response,
        latencyMs: call.latencyMs,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        returnedModel: call.returnedModel,
        error: described.mismatch
          ? `Gateway returned ${call.returnedModel} for ${model.alias}.`
          : call.error,
      });
      await save();
      console.log(
        `${model.alias} ${request.id}: ${success ? "ok" : "failed"} ${(call.latencyMs / 1000).toFixed(1)}s`,
      );
    }
  }

  const { judgeResponse } = await import("../shared/judge");
  for (const generation of generations) {
    if (
      judgments.some(
        (j) =>
          j.alias === generation.alias &&
          j.requestId === generation.requestId,
      )
    )
      continue;
    const request = requests.find((r) => r.id === generation.requestId);
    if (!request) continue;
    const result: RouterResult = {
      router: "litellm",
      requestId: generation.requestId,
      success: generation.success,
      selectedModel: generation.alias,
      response: generation.response,
      latencyMs: generation.latencyMs,
      inputTokens: generation.inputTokens,
      outputTokens: generation.outputTokens,
      costUsd: null,
      error: generation.error,
    };
    const judgment = await judgeResponse(request, result);
    judgments.push({ ...judgment, alias: generation.alias });
    await save();
    console.log(
      `judged ${generation.alias} ${generation.requestId}: ${judgment.overallScore.toFixed(2)}`,
    );
  }

  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const calibration: PoolCalibration = {
    pool: pool.id,
    judgeModel:
      judgments.find((j) => j.judgeModel)?.judgeModel ?? "unknown",
    updatedAt: new Date().toISOString(),
    models: Object.fromEntries(
      pool.models.map((model) => {
        const quality: Partial<Record<Task, number>> = {};
        const latencySeconds: Partial<Record<Task, number>> = {};
        const samples: Partial<Record<Task, number>> = {};
        for (const task of TASKS) {
          // Failed generations are gateway problems, not answer quality; they are excluded.
          const ok = generations.filter(
            (g) => g.alias === model.alias && g.task === task && g.success,
          );
          const scores = ok.flatMap((g) => {
            const j = judgments.find(
              (x) => x.alias === g.alias && x.requestId === g.requestId,
            );
            return j ? [j.overallScore] : [];
          });
          samples[task] = scores.length;
          if (scores.length) quality[task] = mean(scores);
          if (ok.length)
            latencySeconds[task] = mean(ok.map((g) => g.latencyMs)) / 1000;
        }
        return [model.alias, { quality, latencySeconds, samples }];
      }),
    ),
  };
  const output = calibrationPath(pool.id);
  await writeCheckpoint(output, calibration);
  console.table(
    Object.entries(calibration.models).map(([alias, m]) => ({
      alias,
      ...Object.fromEntries(
        TASKS.map((task) => [task, m.quality[task]?.toFixed(2) ?? "-"]),
      ),
    })),
  );
  console.log(`Saved ${output}`);
  const failed = generations.filter((g) => !g.success);
  if (failed.length) {
    console.warn(
      `${failed.length} generations failed and were excluded. First error: ${failed[0].error}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
