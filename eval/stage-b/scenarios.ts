
import { BENCHMARK_PROMPTS } from "../../lib/benchmark";
import type {
  EvaluationRequest,
  OrganizationState,
  TaskImportance,
} from "../shared/pipeline";

export const STAGE_B_BUDGET_STATES = [0.10, 0.50, 0.92] as const;

export const STAGE_B_BUDGET_USD = 10;

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

export function buildStageBScenarios(): EvaluationRequest[] {
  const prompts = BENCHMARK_PROMPTS.filter(
    (item) => item.split === "evaluation",
  );

  const scenarios: EvaluationRequest[] = [];

  for (const budgetUsedFraction of STAGE_B_BUDGET_STATES) {
    for (const prompt of prompts) {
      const state: OrganizationState = {
        budgetUsd: STAGE_B_BUDGET_USD,
        spentUsd: STAGE_B_BUDGET_USD * budgetUsedFraction,
        budgetUsedFraction,
        taskImportance: getTaskImportance(prompt.task),
        qualityFloor: 0.75,
      };

      scenarios.push({
        id: prompt.id,
        prompt: prompt.prompt,
        task: prompt.task,
        rubric: prompt.rubric,
        scenarioId: `${prompt.id}-budget-${Math.round(
          budgetUsedFraction * 100,
        )}`,
        organizationState: state,
      });
    }
  }

  return scenarios;
}
