import type { EvaluationResult } from "./pipeline";

export interface SystemComparison {
  system: string;
  requests: number;
  completed: number;
  rejected: number;
  failed: number;
  completionRate: number;
  rejectionRate: number;
  totalCostUsd: number;
  budgetViolations: number;
}

export interface ComparisonReport {
  mode: string;
  requests: number;
  completed: number;
  rejected: number;
  failed: number;
  completionRate: number;
  rejectionRate: number;
  quality: null;
  qualityNote: string;
  totalCostUsd: number;
  estimatedCostRequests: number;
  unresolvedCostRequests: number;
  budgetViolations: number;
  savingsClaimAllowed: false;
  savingsNote: string;
  isolatesRoutingQuality: false;
  policyNote: string;
  bySystem: SystemComparison[];
}

function outcomeOf(
  result: EvaluationResult,
): "completed" | "rejected" | "failed" {
  if (result.generation.outcome) return result.generation.outcome;
  return result.generation.success ? "completed" : "failed";
}

function rate(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

function budgetViolation(result: EvaluationResult): boolean {
  const cost = result.generation.costUsd;
  const remaining =
    result.stateBefore.budgetUsd - result.stateBefore.spentUsd;
  const costExceeds =
    cost !== null && Number.isFinite(cost) && cost > remaining + 1e-9;
  const afterExceeds =
    result.stateAfter !== null &&
    result.stateAfter.spentUsd > result.stateAfter.budgetUsd + 1e-9;
  return costExceeds || afterExceeds;
}

export function summarizeComparison(
  results: EvaluationResult[],
  mode: string,
): ComparisonReport {
  const systems = ["baseline", "orchestra"];
  const bySystem = systems.map((system) => {
    const rows = results.filter((result) => result.system === system);
    const completed = rows.filter((row) => outcomeOf(row) === "completed").length;
    const rejected = rows.filter((row) => outcomeOf(row) === "rejected").length;
    const failed = rows.length - completed - rejected;
    const knownCosts = rows
      .map((row) => row.generation.costUsd)
      .filter((cost): cost is number => cost !== null && Number.isFinite(cost));
    return {
      system,
      requests: rows.length,
      completed,
      rejected,
      failed,
      completionRate: rate(completed, rows.length),
      rejectionRate: rate(rejected, rows.length),
      totalCostUsd: knownCosts.reduce((sum, cost) => sum + cost, 0),
      budgetViolations: rows.filter(budgetViolation).length,
    };
  });
  const completed = bySystem.reduce((sum, row) => sum + row.completed, 0);
  const rejected = bySystem.reduce((sum, row) => sum + row.rejected, 0);
  const failed = bySystem.reduce((sum, row) => sum + row.failed, 0);
  return {
    mode,
    requests: results.length,
    completed,
    rejected,
    failed,
    completionRate: rate(completed, results.length),
    rejectionRate: rate(rejected, results.length),
    quality: null,
    qualityNote:
      "This file does not contain judged quality. Mock text and uncalibrated routing estimates are not quality measurements.",
    totalCostUsd: bySystem.reduce((sum, row) => sum + row.totalCostUsd, 0),
    estimatedCostRequests: results.filter(
      (result) => result.generation.costBasis === "estimated",
    ).length,
    unresolvedCostRequests: results.filter(
      (result) =>
        result.generation.costBasis === "unresolved" ||
        result.generation.costUsd === null,
    ).length,
    budgetViolations: bySystem.reduce(
      (sum, row) => sum + row.budgetViolations,
      0,
    ),
    savingsClaimAllowed: false,
    savingsNote:
      mode === "mock"
        ? "Mock runs do not measure provider spend. Do not claim savings from these results."
        : "This comparison reports actual, estimated, or locked unresolved cost. It does not convert a cost gap into a savings claim.",
    isolatesRoutingQuality: false,
    policyNote:
      "This compares Orchestra's budget policy with LiteLLM smart-router over the same configured model pool. The baseline cannot restrict the gateway to Orchestra's eligible models. It does not isolate routing quality.",
    bySystem,
  };
}

export function formatComparison(report: ComparisonReport): string {
  return [
    `Mode: ${report.mode}`,
    `Completion rate: ${(report.completionRate * 100).toFixed(1)}% (${report.completed}/${report.requests})`,
    `Rejection rate: ${(report.rejectionRate * 100).toFixed(1)}% (${report.rejected}/${report.requests})`,
    `Failures: ${report.failed}`,
    `Quality: unavailable. ${report.qualityNote}`,
    `Total known cost: $${report.totalCostUsd.toFixed(6)} (${report.estimatedCostRequests} estimated, ${report.unresolvedCostRequests} unresolved reservations)`,
    `Budget violations: ${report.budgetViolations}`,
    report.policyNote,
    report.savingsNote,
  ].join("\n");
}
