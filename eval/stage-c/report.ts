import type { EvaluationResult } from "../shared/pipeline";
export interface ReportRecord {
  variant: string;
  sequenceIndex: number;
  result: EvaluationResult;
}
export interface Observation {
  scenarioId: string;
  overallScore: number;
  passed: boolean;
}
/** Missing judgments stay missing. Rates use judged successful responses only. */
export function summarizeStageC(
  records: ReportRecord[],
  judgments: Observation[],
) {
  const observed = new Map(judgments.map((j) => [j.scenarioId, j]));
  const groups: Record<
    string,
    {
      requests: number;
      successfulGenerations: number;
      unresolvedCosts: number;
      rejected: number;
      failed: number;
      judged: number;
      passed: number;
      violations: number;
      predicted: number[];
      scores: number[];
    }
  > = {};
  const trajectories: Record<string, unknown> = {};
  for (const variant of new Set(records.map((r) => r.variant))) {
    const rows = records
      .filter((r) => r.variant === variant)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    let last: string | null = null,
      switches = 0;
    const modelCounts: Record<string, number> = {};
    for (const { result } of rows) {
      const model = result.generation.selectedModel;
      if (model) {
        modelCounts[model] = (modelCounts[model] ?? 0) + 1;
        if (last && last !== model) switches++;
        last = model;
      }
    }
    trajectories[variant] = {
      modelCounts,
      modelSwitches: switches,
      firstBudgetRejection:
        rows.find(
          (r) =>
            r.result.generation.outcome === "rejected" &&
            /budget|allowance|reserve/i.test(r.result.policy?.reason ?? ""),
        )?.sequenceIndex ?? null,
      cumulativeSpend: rows.map((r) => ({
        sequenceIndex: r.sequenceIndex,
        model: r.result.generation.selectedModel,
        spendUsd: r.result.stateAfter?.spentUsd,
        utilization: r.result.stateAfter?.budgetUsedFraction,
      })),
    };
  }
  for (const { variant, result } of records) {
    const j = observed.get(result.scenarioId);
    const utilization = result.stateBefore.budgetUsedFraction;
    const category =
      (result as EvaluationResult & { taskCategory?: string }).taskCategory ??
      "unknown";
    for (const dimension of [
      "all",
      `model:${result.generation.selectedModel ?? "none"}`,
      `importance:${result.stateBefore.taskImportance}`,
      `category:${category}`,
      `utilization:${utilization < 0.25 ? "0-25%" : utilization < 0.5 ? "25-50%" : utilization < 0.75 ? "50-75%" : utilization < 1 ? "75-100%" : "100%+"}`,
    ]) {
      const g = (groups[`${variant}/${dimension}`] ??= {
        requests: 0,
        successfulGenerations: 0,
        unresolvedCosts: 0,
        rejected: 0,
        failed: 0,
        judged: 0,
        passed: 0,
        violations: 0,
        predicted: [],
        scores: [],
      });
      g.requests++;
      g.successfulGenerations += Number(result.generation.success);
      g.unresolvedCosts += Number(
        result.generation.costBasis === "unresolved" ||
          result.generation.costUsd === null,
      );
      if (result.generation.outcome === "rejected") g.rejected++;
      else if (!result.generation.success) g.failed++;
      else if (j) {
        g.judged++;
        g.passed += Number(j.passed);
        g.violations += Number(
          j.overallScore < result.stateBefore.qualityFloor,
        );
        const p = result.policy?.predictedQuality;
        if (p != null) {
          g.predicted.push(p);
          g.scores.push(j.overallScore);
        }
      }
    }
  }
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return {
    note: "Mock runs contain no observed quality evidence. Quality rates use judged successful responses; paired means exclude unavailable predictions. Judge costs are outside routing budgets.",
    trajectories,
    groups: Object.fromEntries(
      Object.entries(groups).map(([key, g]) => [
        key,
        {
          ...g,
          predicted: undefined,
          scores: undefined,
          providerFailures: g.failed,
          policyRejections: g.rejected,
          generationSuccessRate: g.successfulGenerations / g.requests,
          judgmentCoverage: g.successfulGenerations
            ? g.judged / g.successfulGenerations
            : null,
          // Missing judgments must not turn an incomplete study into a final quality-service rate.
          overallSuccessfulServiceRate:
            g.judged === g.successfulGenerations ? g.passed / g.requests : null,
          observedPassRate: g.judged ? g.passed / g.judged : null,
          qualityFloorViolationRate: g.judged ? g.violations / g.judged : null,
          pairedCount: g.predicted.length,
          meanPredictedQuality: mean(g.predicted),
          meanObservedQuality: mean(g.scores),
        },
      ]),
    ),
  };
}
