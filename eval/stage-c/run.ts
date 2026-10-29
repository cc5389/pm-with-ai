import { restoreCheckpoint } from "./checkpoint";
import { mkdir } from "node:fs/promises";
import { readCheckpoint, writeCheckpoint } from "../shared/checkpoint-io";
import { buildStageCWorkload } from "./workload";
import { MockEvaluationAdapter } from "../stage-b/mock-adapter";
import { IntegratedEvaluationAdapter } from "../shared/integrated-adapter";
import { applyExperimentCost, unresolvedCostMessage } from "../shared/accounting";
import { runBaseline, runOrchestra } from "../shared/pipelines";
import {
  assertPaidRunIsExplicit,
  executionLimit,
  executionMode,
  resultsPath,
} from "../shared/run-mode";
import type { EvaluationAdapter, EvaluationResult } from "../shared/pipeline";

const BUDGET_USD = 1;

interface StageCRecord {
  sequenceIndex: number;
  result: EvaluationResult;
}

interface SavedResults {
  experiment: string;
  mode: string;
  budgetUsd: number;
  workloadSize: number;
  records: StageCRecord[];
}

async function loadResults(
  path: string,
  mode: string,
  plannedSize: number,
): Promise<StageCRecord[]> {
  const parsed = await readCheckpoint<SavedResults>(path);
  if (parsed === null) return [];
  if (
    parsed.mode !== mode ||
    parsed.budgetUsd !== BUDGET_USD ||
    parsed.workloadSize !== plannedSize ||
    !Array.isArray(parsed.records)
  ) {
    throw new Error(
      "Saved Stage C configuration mismatch. Refusing to mix mock and real results or a different request limit.",
    );
  }
  return parsed.records;
}

async function main() {
  const mode = executionMode();
  const limit = executionLimit();
  assertPaidRunIsExplicit(mode, limit);

  const output = resultsPath("stage-c", mode);
  await mkdir("eval/results/stage-c", { recursive: true });

  const fullWorkload = buildStageCWorkload();
  const workload = limit === null ? fullWorkload : fullWorkload.slice(0, limit);
  const adapters: EvaluationAdapter[] =
    mode === "mock"
      ? [
          new MockEvaluationAdapter("baseline"),
          new MockEvaluationAdapter("orchestra"),
        ]
      : [
          new IntegratedEvaluationAdapter("baseline", runBaseline),
          new IntegratedEvaluationAdapter("orchestra", runOrchestra),
        ];

  const existing = await loadResults(output, mode, workload.length);
  const records: StageCRecord[] = [];

  async function save() {
    await writeCheckpoint(output, {
      experiment: "stage-c-sequential",
      mode,
      budgetUsd: BUDGET_USD,
      workloadSize: workload.length,
      updatedAt: new Date().toISOString(),
      records,
    });
  }

  console.log(`Execution: ${mode}`);
  console.log(`Workload in this run: ${workload.length}`);

  for (const adapter of adapters) {
    const previous = existing
      .filter((record) => record.result.system === adapter.name)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    const unresolved = previous.find(
      (record) => record.result.generation.costUsd === null,
    );
    if (unresolved) {
      throw new Error(
        unresolvedCostMessage(
          `${adapter.name} request ${unresolved.sequenceIndex + 1}`,
        ),
      );
    }

    const tracker = restoreCheckpoint(
      adapter.name,
      previous,
      workload,
      BUDGET_USD,
    );
    records.push(...previous);
    console.log(
      `${adapter.name}: resuming from ${previous.length}/${workload.length}`,
    );

    for (let i = previous.length; i < workload.length; i++) {
      const item = workload[i];
      const stateBefore = tracker.organizationState(
        item.taskImportance,
        item.qualityFloor,
      );
      const request = {
        id: item.id,
        prompt: item.prompt,
        task: item.task,
        rubric: item.rubric,
        scenarioId: `stage-c-${adapter.name}-${i + 1}`,
        organizationState: stateBefore,
      };
      const result = await adapter.execute(request);
      if (
        result.system !== adapter.name ||
        result.requestId !== request.id ||
        result.scenarioId !== request.scenarioId
      ) {
        throw new Error(`Adapter result mismatch at request ${i + 1}`);
      }

      result.stateBefore = { ...stateBefore };
      const cost = result.generation.costUsd;
      if (cost === null) {
        result.stateAfter = { ...stateBefore };
        records.push({ sequenceIndex: i, result });
        await save();
        throw new Error(
          unresolvedCostMessage(`${adapter.name} request ${i + 1}`),
        );
      }
      if (!result.generation.success) {
        console.warn(
          `Generation failed: ${request.id}. Reported cost: $${cost.toFixed(6)}. Error: ${result.generation.error ?? "unknown"}`,
        );
      }
      const stateAfter = applyExperimentCost(tracker, cost);
      result.stateAfter = {
        ...stateBefore,
        spentUsd: stateAfter.spentUsd,
        budgetUsedFraction: stateAfter.budgetUsedFraction,
      };
      records.push({ sequenceIndex: i, result });
      await save();
      if ((i + 1) % 25 === 0) {
        console.log(
          `${adapter.name}: ${i + 1}/${workload.length}, spent $${stateAfter.spentUsd.toFixed(4)}`,
        );
      }
    }
  }

  await save();
  console.log(`Completed records: ${records.length}`);
  console.log(`Saved to ${output}`);
  if (mode === "mock") {
    console.log(
      "Mock execution did not call a provider. Do not claim savings from this file.",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
