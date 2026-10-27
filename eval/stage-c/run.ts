import { classifyTask } from "../../lib/classification";
import { stageCConfig, stageCPath, VARIANTS } from "./config";
import { planBaseline, planOrchestra } from "../shared/pipelines";
import { summarizeStageC } from "./report";
import { restoreCheckpoint } from "./checkpoint";
import { mkdir } from "node:fs/promises";
import { readCheckpoint, writeCheckpoint } from "../shared/checkpoint-io";
import { buildStageCWorkload } from "./workload";
import { MockEvaluationAdapter } from "../stage-b/mock-adapter";
import { IntegratedEvaluationAdapter } from "../shared/integrated-adapter";
import {
  applyExperimentCost,
  unresolvedCostMessage,
} from "../shared/accounting";
import { runBaseline, runOrchestra } from "../shared/pipelines";
import {
  assertPaidRunIsExplicit,
  executionLimit,
  executionMode,
} from "../shared/run-mode";
import type { EvaluationResult } from "../shared/pipeline";

/**
 * Default is $0.10; legacy $0.40 files remain untouched. Was $1. With answers capped near 300 words, 200 requests on the most
 * expensive model cost about $0.78, so $1 never constrained either system.
 * $0.40 is about half of that, so a budget-blind policy runs out partway.
 */
const BUDGET_USD = stageCConfig().budgetUsd;

interface StageCRecord {
  variant: string;
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

  const output = stageCPath(mode);
  await mkdir("eval/results/stage-c", { recursive: true });

  const fullWorkload = buildStageCWorkload();
  const workload = limit === null ? fullWorkload : fullWorkload.slice(0, limit);
  const existing = await loadResults(output, mode, workload.length);
  const records: StageCRecord[] = [...existing];

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

  for (const variant of VARIANTS.filter(
    (v) => stageCConfig().variant === "all" || stageCConfig().variant === v,
  )) {
    const system = variant === "baseline" ? "baseline" : "orchestra";
    const adapter = new IntegratedEvaluationAdapter(
      system,
      system === "baseline" ? runBaseline : runOrchestra,
    );
    const previous = existing
      .filter((record) => record.variant === variant)
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
      workload.map((item) => ({
        ...item,
        taskImportance:
          variant === "orchestra-inferred"
            ? classifyTask(item.prompt).importance
            : item.taskImportance,
      })),
      BUDGET_USD,
      variant,
    );
    console.log(
      `${adapter.name}: resuming from ${previous.length}/${workload.length}`,
    );

    for (let i = previous.length; i < workload.length; i++) {
      const item = workload[i];
      const stateBefore = tracker.organizationState(
        variant === "orchestra-inferred"
          ? classifyTask(item.prompt).importance
          : item.taskImportance,
        item.qualityFloor,
      );
      const request = {
        importanceMode:
          variant === "orchestra-inferred"
            ? ("inferred" as const)
            : ("fixed" as const),
        id: item.id,
        prompt: item.prompt,
        task: item.task,
        rubric: item.rubric,
        scenarioId: `stage-c-${variant}-${i + 1}`,
        organizationState: stateBefore,
      };
      const result =
        mode === "real"
          ? await adapter.execute(request)
          : await (async () => {
              const plan =
                system === "baseline"
                  ? planBaseline(request)
                  : planOrchestra(request);
              const result = await new MockEvaluationAdapter(system).execute(
                request,
              );
              result.policy = {
                applied: system === "orchestra",
                allowedModels: plan.allowedModels,
                reason: plan.reason,
                predictedQuality:
                  plan.preview?.selected?.estimatedQuality ?? null,
                classification:
                  variant === "orchestra-inferred"
                    ? classifyTask(item.prompt)
                    : undefined,
              };
              result.generation.selectedModel =
                plan.kind === "call"
                  ? (plan.preview?.selected?.model.id ??
                    result.generation.selectedModel)
                  : null;
              if (plan.kind === "reject")
                Object.assign(result.generation, {
                  success: false,
                  response: null,
                  costUsd: 0,
                  outcome: "rejected",
                  error: plan.reason,
                });
              return result;
            })();
      if (
        result.system !== adapter.name ||
        result.requestId !== request.id ||
        result.scenarioId !== request.scenarioId
      ) {
        throw new Error(`Adapter result mismatch at request ${i + 1}`);
      }

      result.taskCategory = item.task;
      result.stateBefore = { ...stateBefore };
      const cost = result.generation.costUsd;
      if (cost === null) {
        result.stateAfter = { ...stateBefore };
        records.push({ variant, sequenceIndex: i, result });
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
      records.push({ variant, sequenceIndex: i, result });
      await save();
      if ((i + 1) % 25 === 0) {
        console.log(
          `${adapter.name}: ${i + 1}/${workload.length}, spent $${stateAfter.spentUsd.toFixed(4)}`,
        );
      }
    }
  }

  await save();
  await writeCheckpoint(
    stageCPath(mode, "report"),
    summarizeStageC(
      records,
      (
        await readCheckpoint<{ judgments: import("./report").Observation[] }>(
          stageCPath(mode, "judgments"),
        )
      )?.judgments ?? [],
    ),
  );
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
