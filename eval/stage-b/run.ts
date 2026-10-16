import { mkdir } from "node:fs/promises";
import { buildStageBScenarios } from "./scenarios";
import { MockEvaluationAdapter } from "./mock-adapter";
import { readCheckpoint, writeCheckpoint } from "../shared/checkpoint-io";
import { IntegratedEvaluationAdapter } from "../shared/integrated-adapter";
import {
  accountIndependent,
  unresolvedCostMessage,
} from "../shared/accounting";
import { runBaseline, runOrchestra } from "../shared/pipelines";
import {
  assertPaidRunIsExplicit,
  executionLimit,
  executionMode,
  resultsPath,
} from "../shared/run-mode";
import type { EvaluationAdapter, EvaluationResult } from "../shared/pipeline";

interface SavedResults {
  results: EvaluationResult[];
}

async function loadResults(path: string): Promise<EvaluationResult[]> {
  const parsed = await readCheckpoint<SavedResults>(path);
  if (parsed === null) return [];
  if (!Array.isArray(parsed.results)) {
    throw new Error("Invalid results file");
  }
  return parsed.results;
}

async function main() {
  const mode = executionMode();
  const limit = executionLimit();
  assertPaidRunIsExplicit(mode, limit);

  const output = resultsPath("stage-b", mode);
  await mkdir("eval/results/stage-b", { recursive: true });

  const allScenarios = buildStageBScenarios();
  const scenarios = limit === null ? allScenarios : allScenarios.slice(0, limit);
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

  const validKeys = new Set(
    allScenarios.flatMap((scenario) =>
      adapters.map((adapter) => `${scenario.scenarioId}:${adapter.name}`),
    ),
  );
  const existing = await loadResults(output);
  const unresolved = existing.find((result) => result.generation.costUsd === null);
  if (unresolved) {
    throw new Error(
      unresolvedCostMessage(`${unresolved.scenarioId}:${unresolved.system}`),
    );
  }

  const results = existing.filter((result) =>
    validKeys.has(`${result.scenarioId}:${result.system}`),
  );
  const completed = new Set(
    results.map((result) => `${result.scenarioId}:${result.system}`),
  );

  async function save() {
    await writeCheckpoint(output, {
      experiment: "stage-b-single-request",
      mode,
      updatedAt: new Date().toISOString(),
      scenarios: allScenarios,
      results,
    });
  }

  await save();
  console.log(`Execution: ${mode}`);
  console.log(`Scenarios in this run: ${scenarios.length}`);
  console.log(`Existing results: ${results.length}`);

  for (const scenario of scenarios) {
    for (const adapter of adapters) {
      const key = `${scenario.scenarioId}:${adapter.name}`;
      if (completed.has(key)) {
        console.log(`Skipping ${key}`);
        continue;
      }
      console.log(`Running ${key}...`);
      const result = await adapter.execute(scenario);
      if (
        result.scenarioId !== scenario.scenarioId ||
        result.system !== adapter.name
      ) {
        throw new Error(`Adapter returned mismatched result: ${key}`);
      }
      result.stateBefore = { ...scenario.organizationState };
      if (result.generation.costUsd === null) {
        result.stateAfter = { ...scenario.organizationState };
        results.push(result);
        completed.add(key);
        await save();
        throw new Error(unresolvedCostMessage(key));
      }
      result.stateAfter = accountIndependent(
        scenario.organizationState,
        result.generation.costUsd,
      );
      results.push(result);
      completed.add(key);
      await save();
    }
  }

  console.log(`Completed: ${results.length}`);
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
