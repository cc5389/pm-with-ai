import { BENCHMARK_PROMPTS } from "../../lib/benchmark";
import type { TaskImportance } from "../shared/pipeline";
import type { RouterRequest } from "../stage-a/adapters/base";

export interface WorkloadItem extends RouterRequest {
  sequenceIndex: number;
  taskImportance: TaskImportance;
  qualityFloor: number;
}

export const STAGE_C_WORKLOAD_SIZE = 200;

/** Frozen legacy labels for the fixed-label control only. Inferred runs classify prompts. */
function getTaskImportance(task: string): TaskImportance {
  switch (task) {
    case "coding":
    case "analysis":
      return "high";
    case "writing":
      return "medium";
    default:
      return "low";
  }
}

export function buildStageCWorkload(
  size = STAGE_C_WORKLOAD_SIZE,
): WorkloadItem[] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error("Workload size must be a positive integer.");
  }

  const prompts = BENCHMARK_PROMPTS.filter(
    (item) => item.split === "evaluation",
  );

  if (prompts.length === 0) {
    throw new Error("No evaluation prompts found.");
  }

  const workload: WorkloadItem[] = [];

  for (let i = 0; i < size; i++) {
    const prompt = prompts[i % prompts.length];

    workload.push({
      id: `stage-c-${String(i + 1).padStart(4, "0")}`,
      prompt: prompt.prompt,
      task: prompt.task,
      rubric: prompt.rubric,
      sequenceIndex: i,
      taskImportance: getTaskImportance(prompt.task),
      qualityFloor: 0.75,
    });
  }

  return workload;
}
