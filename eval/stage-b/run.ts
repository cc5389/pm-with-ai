
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildStageBScenarios } from "./scenarios";
import { MockEvaluationAdapter } from "./mock-adapter";
import type {
  EvaluationAdapter,
  EvaluationResult,
} from "../shared/pipeline";

const OUTPUT_DIR = "eval/results/stage-b";
const OUTPUT = `${OUTPUT_DIR}/mock-results.json`;

interface SavedResults {
  results: EvaluationResult[];
}

async function loadResults(): Promise<EvaluationResult[]> {
  try {
    const raw = await readFile(OUTPUT, "utf8");
    const parsed: SavedResults = JSON.parse(raw);
    if (!Array.isArray(parsed.results)) {
      throw new Error("Invalid results file");
    }
    return parsed.results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const scenarios = buildStageBScenarios();

  // Replace with real adapters after team integration.
  const adapters: EvaluationAdapter[] = [
    new MockEvaluationAdapter("baseline"),
    new MockEvaluationAdapter("orchestra"),
  ];

  const validKeys = new Set(
    scenarios.flatMap((scenario) =>
      adapters.map((adapter) => `${scenario.scenarioId}:${adapter.name}`),
    ),
  );

  const existing = await loadResults();
  const results = existing.filter((result) =>
    validKeys.has(`${result.scenarioId}:${result.system}`),
  );

  const completed = new Set(
    results.map((result) => `${result.scenarioId}:${result.system}`),
  );

  async function save() {
    await writeFile(
      OUTPUT,
      JSON.stringify(
        {
          experiment: "stage-b-single-request",
          mode: "mock",
          updatedAt: new Date().toISOString(),
          scenarios,
          results,
        },
        null,
        2,
      ),
    );
  }

  await save();

  console.log(`Scenarios: ${scenarios.length}`);
  console.log(`Existing results: ${results.length}`);
  console.log(
    `Remaining executions: ${scenarios.length * adapters.length - completed.size}`,
  );

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

      results.push(result);
      completed.add(key);

      await save();
    }
  }

  console.log(`Completed: ${results.length}`);
  console.log(`Saved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
