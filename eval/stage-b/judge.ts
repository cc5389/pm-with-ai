
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { QualityJudgment } from "../shared/judge";
import type {
  EvaluationResult,
  EvaluationRequest,
  EvaluationSystem,
} from "../shared/pipeline";
import { resultsPath } from "../shared/run-mode";
import { buildStageBScenarios } from "./scenarios";

const MODE =
  process.env.EVAL_MODE === "real" || process.env.EVAL_EXECUTION === "real"
    ? "real"
    : "mock";

const OUTPUT_DIR = "eval/results/stage-b";
const INPUT = resultsPath("stage-b", MODE);
const OUTPUT = resultsPath("stage-b", MODE, undefined, "judgments");

interface StageBJudgment extends QualityJudgment {
  scenarioId: string;
  system: EvaluationSystem;
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function main() {
  if (MODE === "mock") {
    throw new Error(
      "Mock responses must not be judged as real quality evidence. " +
      "Run this script with EVAL_MODE=real after integration.",
    );
  }
  const { judgeResponse } = await import("../shared/judge");
  await mkdir(OUTPUT_DIR, { recursive: true });

  const saved = await loadJson<{ results: EvaluationResult[] }>(INPUT);

  if (!saved || !Array.isArray(saved.results)) {
    throw new Error(`No valid results found at ${INPUT}`);
  }

  const scenarios = buildStageBScenarios();
  const scenarioMap = new Map<string, EvaluationRequest>(
    scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );

  const previous = await loadJson<{ judgments: StageBJudgment[] }>(OUTPUT);
  const judgments = previous?.judgments ?? [];

  const completed = new Set(
    judgments.map((j) => `${j.scenarioId}:${j.system}`),
  );

  console.log(`Generation results: ${saved.results.length}`);
  console.log(`Existing judgments: ${judgments.length}`);

  for (const result of saved.results) {
    const key = `${result.scenarioId}:${result.system}`;

    if (completed.has(key)) {
      console.log(`Skipping ${key}`);
      continue;
    }

    const scenario = scenarioMap.get(result.scenarioId);

    if (!scenario) {
      throw new Error(`Unknown scenario: ${result.scenarioId}`);
    }

    console.log(`Judging ${key}...`);

    const judgment = await judgeResponse(
      scenario,
      result.generation,
      scenario.organizationState.qualityFloor,
    );

    judgments.push({
      ...judgment,
      scenarioId: result.scenarioId,
      system: result.system,
    });

    completed.add(key);

    await writeFile(
      OUTPUT,
      JSON.stringify(
        {
          experiment: "stage-b-quality",
          mode: MODE,
          updatedAt: new Date().toISOString(),
          judgments,
        },
        null,
        2,
      ),
    );
  }

  console.log(`Completed judgments: ${judgments.length}`);
  console.log(`Saved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
