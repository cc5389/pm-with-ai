import { createHash } from "node:crypto";
import { timeoutMs } from "../shared/timeout";
import {
  activePool,
  litellmProfiles,
  EVAL_OUTPUT_TOKEN_CAP,
  EVAL_SIMULATED_DATE,
  estimatedRequestCost,
} from "../shared/model-pool";
import { DEFAULT_COMPANY_POLICY } from "../../lib/policy";
import { classifyTask } from "../../lib/classification";
import { stageCConfig, stageCPath, VARIANTS } from "./config";
import {
  planBaseline,
  planOrchestra,
  policyForPlan,
} from "../shared/pipelines";
import { summarizeStageC } from "./report";
import { assertNoPendingAttempt, restoreCheckpoint } from "./checkpoint";
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
  routingFingerprint?: string;
  pendingAttempt?: unknown;
}

async function loadResults(
  path: string,
  mode: string,
  plannedSize: number,
  routingFingerprint: string,
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
  if (
    parsed.routingFingerprint &&
    parsed.routingFingerprint !== routingFingerprint
  )
    throw new Error("Routing configuration changed; use a new STAGE_C_RUN_ID.");
  assertNoPendingAttempt(parsed);
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
  const profiles = litellmProfiles();
  if (
    activePool().id === "ollama" &&
    profiles.some(
      (m) =>
        Object.values(m.qualitySampleCounts ?? {}).length !== 4 ||
        Object.values(m.qualitySampleCounts ?? {}).some((n) => n < 1) ||
        m.source !== "measured",
    )
  )
    throw new Error(
      "Stage C Ollama requires the measured calibration file for every model and task.",
    );
  timeoutMs("LITELLM_TIMEOUT_MS", 600_000);
  const routingFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        pool: activePool(),
        profiles,
        workload,
        outputCap: EVAL_OUTPUT_TOKEN_CAP,
        date: EVAL_SIMULATED_DATE,
        policy: DEFAULT_COMPANY_POLICY,
        classifier: "prompt-rules-v1",
      }),
    )
    .digest("hex");
  const existing = await loadResults(
    output,
    mode,
    workload.length,
    routingFingerprint,
  );
  let pendingAttempt: unknown = null;
  const records: StageCRecord[] = [...existing];

  async function save() {
    await writeCheckpoint(output, {
      experiment: "stage-c-sequential",
      mode,
      budgetUsd: BUDGET_USD,
      workloadSize: workload.length,
      updatedAt: new Date().toISOString(),
      records,
      routingFingerprint,
      pendingAttempt,
    });
  }

  console.log(`Execution: ${mode}`);
  console.log(`Workload in this run: ${workload.length}`);

  for (const variant of VARIANTS.filter(
    (v) => stageCConfig().variant === "all" || stageCConfig().variant === v,
  )) {
    const system = variant === "baseline" ? "baseline" : "orchestra";
    const adapter = new IntegratedEvaluationAdapter(system, (request) =>
      (system === "baseline" ? runBaseline : runOrchestra)(request, {
        onPlanned: async (policy, reservedCostUsd) => {
          pendingAttempt = {
            scenarioId: request.scenarioId,
            requestId: request.id,
            stateBefore: request.organizationState,
            policy,
            reservedCostUsd,
            plannedAt: new Date().toISOString(),
          };
          await save();
        },
      }),
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
      `${variant}: resuming from ${previous.length}/${workload.length}`,
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
              result.policy = policyForPlan(request, plan);
              const model =
                plan.preview?.selected?.model.id ??
                activePool().models[1].alias;
              const snapshot = profiles.map((p) => ({
                model: p.id,
                quality: p.quality[item.task],
              }));
              result.policy.qualitySnapshot = snapshot;
              result.policy.predictionTiming = plan.preview
                ? "before-generation"
                : "pre-generation-snapshot-post-gateway-selection";
              result.policy.predictedQuality =
                plan.kind === "call"
                  ? snapshot.find((p) => p.model === model)!.quality
                  : null;
              result.generation.selectedModel =
                plan.kind === "call" ? model : null;
              const priced = activePool().models.find(
                (m) => m.alias === model,
              )!;
              Object.assign(result.generation, {
                outcome: "completed",
                providerContacted: false,
                attempts: 0,
                outputTokenCap: EVAL_OUTPUT_TOKEN_CAP,
                costBasis: "estimated",
                reservedCostUsd:
                  plan.kind === "call" ? plan.reservedCostUsd : 0,
                costUsd: estimatedRequestCost(priced, 100, 50),
                requestedModel:
                  plan.kind === "call" ? plan.requestedModel : null,
              });
              if (plan.kind === "reject")
                Object.assign(result.generation, {
                  success: false,
                  response: null,
                  costUsd: 0,
                  costBasis: "none",
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
      if (result.generation.outcome === "rejected") {
        console.log(
          `Policy rejection: ${request.id}. ${result.policy?.reason ?? result.generation.error}`,
        );
      } else if (!result.generation.success) {
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
      pendingAttempt = null;
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
