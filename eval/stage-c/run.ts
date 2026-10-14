import { restoreCheckpoint } from "./checkpoint";
import { mkdir } from "node:fs/promises";
import {
  readCheckpoint,
  writeCheckpoint,
} from "../shared/checkpoint-io";
import { buildStageCWorkload } from "./workload";
import { MockEvaluationAdapter } from "../stage-b/mock-adapter";
import type {
  EvaluationAdapter,
  EvaluationResult,
  EvaluationSystem,
} from "../shared/pipeline";

const OUTPUT_DIR = "eval/results/stage-c";
const OUTPUT = `${OUTPUT_DIR}/mock-results.json`;
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


async function loadResults(): Promise<StageCRecord[]> {
  const parsed = await readCheckpoint<SavedResults>(OUTPUT);

  if (parsed === null) {
    return [];
  }

  if (
    parsed.mode !== "mock" ||
    parsed.budgetUsd !== BUDGET_USD ||
    parsed.workloadSize !== buildStageCWorkload().length ||
    !Array.isArray(parsed.records)
  ) {
    throw new Error("Saved Stage C configuration mismatch.");
  }

  return parsed.records;
}


async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const workload = buildStageCWorkload();

  const adapters: EvaluationAdapter[] = [
    new MockEvaluationAdapter("baseline"),
    new MockEvaluationAdapter("orchestra"),
  ];

  const existing = await loadResults();
  const records: StageCRecord[] = [];

  
  async function save() {
    await writeCheckpoint(OUTPUT, {
      experiment: "stage-c-sequential",
      mode: "mock",
      budgetUsd: BUDGET_USD,
      workloadSize: workload.length,
      updatedAt: new Date().toISOString(),
      records,
    });
  }


  for (const adapter of adapters) {
    const previous = existing
      .filter((record) => record.result.system === adapter.name)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);

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

      
      const cost = result.generation.costUsd;
          
      if (
        cost === null ||
        !Number.isFinite(cost) ||
        cost < 0
      ) {
        throw new Error(
          `Cannot account for request ${request.id}: ` +
          `generation cost is missing or invalid. ` +
          `Previous checkpoint is preserved.`,
        );
      }
      
      // Failed generations may still incur API costs.
      // Record any reported cost regardless of success.
      if (!result.generation.success) {
        console.warn(
          `Generation failed: ${request.id}. ` +
          `Reported cost: $${cost.toFixed(6)}. ` +
          `Error: ${result.generation.error ?? "unknown"}`,
        );
      }
      
      const stateAfter = tracker.recordCost(cost);
      
      result.stateBefore = { ...stateBefore };
      result.stateAfter = {
        ...stateBefore,
        spentUsd: stateAfter.spentUsd,
        budgetUsedFraction: stateAfter.budgetUsedFraction,
      };

      records.push({
        sequenceIndex: i,
        result,
      });

      await save();

      if ((i + 1) % 25 === 0) {
        console.log(
          `${adapter.name}: ${i + 1}/${workload.length}, ` +
          `spent $${stateAfter.spentUsd.toFixed(4)}`,
        );
      }
    }
  }

  await save();

  console.log(`Completed records: ${records.length}`);
  console.log(`Saved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
