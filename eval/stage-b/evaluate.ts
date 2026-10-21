
import { readFile, writeFile } from "node:fs/promises";
import { buildStageBScenarios } from "./scenarios";
import { evaluateConstraints } from "./constraints";
import { formatComparison, summarizeComparison } from "../shared/comparison";
import { executionMode, resultsPath } from "../shared/run-mode";
import type { EvaluationResult } from "../shared/pipeline";

interface SavedResults {
  mode?: string;
  results: EvaluationResult[];
}

async function main() {
  const mode = executionMode();
  const input = resultsPath("stage-b", mode);
  const output = resultsPath("stage-b", mode, undefined, "constraints");
  const raw = await readFile(input, "utf8");
  const parsed: SavedResults = JSON.parse(raw);

  if (!Array.isArray(parsed.results)) {
    throw new Error("Invalid Stage B results file.");
  }

  const scenarios = buildStageBScenarios();
  const scenarioMap = new Map(
    scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );

  const evaluations = parsed.results.map((result) => {
    const scenario = scenarioMap.get(result.scenarioId);

    if (!scenario) {
      throw new Error(`Unknown scenario: ${result.scenarioId}`);
    }

    return evaluateConstraints(scenario, result);
  });

  const comparison = summarizeComparison(
    parsed.results,
    parsed.mode ?? mode,
  );

  await writeFile(
    output,
    JSON.stringify(
      {
        experiment: "stage-b-constraints",
        mode: parsed.mode ?? mode,
        comparison,
        evaluations,
      },
      null,
      2,
    ),
  );
  console.log(formatComparison(comparison));

  console.log(`Evaluated: ${evaluations.length}`);

  console.table(
    ["baseline", "orchestra"].map((system) => {
      const rows = evaluations.filter((e) => e.system === system);

      return {
        system,
        total: rows.length,
        modelViolations: rows.filter(
          (e) => e.allowedModelCompliant === false,
        ).length,
        budgetViolations: rows.filter(
          (e) => e.budgetFeasible === false,
        ).length,
        policyMissing: rows.filter(
          (e) => e.policyApplied === false,
        ).length,
      };
    }),
  );

  console.log(`Saved to ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
