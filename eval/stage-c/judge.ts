import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readCheckpoint, writeCheckpoint } from "../shared/checkpoint-io";
import type { QualityJudgment } from "../shared/judge";
import type { EvaluationResult, EvaluationSystem } from "../shared/pipeline";
import { resultsPath } from "../shared/run-mode";
import { buildStageCWorkload } from "./workload";

const MODE =
  process.env.EVAL_MODE === "real" || process.env.EVAL_EXECUTION === "real"
    ? "real"
    : "mock";

const INPUT = resultsPath("stage-c", MODE);
const OUTPUT = resultsPath("stage-c", MODE, undefined, "judgments");

interface StageCJudgment extends QualityJudgment {
  sequenceIndex: number;
  scenarioId: string;
  system: EvaluationSystem;
  selectedModel: string | null;
  /** True when an identical prompt and response was already judged. */
  reused: boolean;
}

interface SavedResults {
  records: { sequenceIndex: number; result: EvaluationResult }[];
}

/** The workload repeats 20 prompts; identical answers get the same judgment. */
function answerKey(prompt: string, response: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify([prompt, response]))
    .digest("hex");
}

async function main() {
  if (MODE === "mock") {
    throw new Error(
      "Mock responses must not be judged as real quality evidence. " +
        "Run this script with EVAL_MODE=real after a real Stage C run.",
    );
  }
  const { judgeResponse } = await import("../shared/judge");
  await mkdir("eval/results/stage-c", { recursive: true });

  const saved = await readCheckpoint<SavedResults>(INPUT);
  if (!saved || !Array.isArray(saved.records)) {
    throw new Error(`No valid results found at ${INPUT}`);
  }

  const workload = buildStageCWorkload();
  const previous = await readCheckpoint<{ judgments: StageCJudgment[] }>(
    OUTPUT,
  );
  const judgments = previous?.judgments ?? [];
  const completed = new Set(judgments.map((j) => j.scenarioId));
  const cache = new Map<string, QualityJudgment>();
  for (const judgment of judgments) {
    const item = workload[judgment.sequenceIndex];
    const record = saved.records.find(
      (r) => r.result.scenarioId === judgment.scenarioId,
    );
    if (item && record && !judgment.reused) {
      cache.set(
        answerKey(item.prompt, record.result.generation.response),
        judgment,
      );
    }
  }

  console.log(`Generation records: ${saved.records.length}`);
  console.log(`Existing judgments: ${judgments.length}`);

  for (const { sequenceIndex, result } of saved.records) {
    if (completed.has(result.scenarioId)) continue;
    const item = workload[sequenceIndex];
    if (!item || item.id !== result.requestId) {
      throw new Error(`Unknown workload item: ${result.scenarioId}`);
    }
    const key = answerKey(item.prompt, result.generation.response);
    const cached = result.generation.success ? cache.get(key) : undefined;
    const judgment =
      cached ??
      (await judgeResponse(item, result.generation, item.qualityFloor));
    if (!cached && result.generation.success) cache.set(key, judgment);

    judgments.push({
      ...judgment,
      requestId: item.id,
      router: result.generation.router,
      sequenceIndex,
      scenarioId: result.scenarioId,
      system: result.system,
      selectedModel: result.generation.selectedModel,
      reused: cached !== undefined,
    });
    completed.add(result.scenarioId);
    console.log(
      `${result.scenarioId}: ${judgment.overallScore.toFixed(2)}${cached ? " (reused)" : ""}`,
    );

    await writeCheckpoint(OUTPUT, {
      experiment: "stage-c-quality",
      mode: MODE,
      updatedAt: new Date().toISOString(),
      judgments,
    });
  }

  console.log(`Completed judgments: ${judgments.length}`);
  console.log(`Saved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
