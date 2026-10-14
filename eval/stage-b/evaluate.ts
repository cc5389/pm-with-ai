
import { readFile, writeFile } from "node:fs/promises";
import { buildStageBScenarios } from "./scenarios";
import { evaluateConstraints } from "./constraints";
import type { EvaluationResult } from "../shared/pipeline";

const INPUT = "eval/results/stage-b/mock-results.json";
const OUTPUT = "eval/results/stage-b/mock-constraints.json";

interface SavedResults {
  results: EvaluationResult[];
}

async function main() {
  const raw = await readFile(INPUT, "utf8");
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

  await writeFile(
    OUTPUT,
    JSON.stringify(
      {
        experiment: "stage-b-constraints",
        mode: "mock",
        evaluations,
      },
      null,
      2,
    ),
  );

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

  console.log(`Saved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
