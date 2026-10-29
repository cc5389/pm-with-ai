import { readCheckpoint, writeCheckpoint } from "./shared/checkpoint-io";
import type { EvaluationResult, EvaluationSystem } from "./shared/pipeline";
import { executionMode, resultsPath } from "./shared/run-mode";

/**
 * Stage B/C metrics for the team report:
 *   1. Monthly budget compliance, 1-1. exhaustion timing (Stage C)
 *   2. Quality preservation over time (Stage C, needs judgments)
 *   3. Model selection by budget state (Stage B and C)
 *   4. Efficiency: cost per passing answer and budget use (Stage C)
 * Costs are whatever the pool charges; for Ollama they are shadow prices.
 */

interface Judged {
  scenarioId: string;
  system: EvaluationSystem;
  overallScore: number;
  passed: boolean;
}

const SYSTEMS: EvaluationSystem[] = ["baseline", "orchestra"];
const STATE_BUCKETS = [
  { label: "<50% used", max: 0.5 },
  { label: "50–80% used", max: 0.8 },
  { label: "80–90% used", max: 0.9 },
  { label: "≥90% used", max: Infinity },
];
const QUARTERS = 4;

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const round = (value: number | null, digits = 3) =>
  value === null ? null : Number(value.toFixed(digits));

/** Stage A-era and mock results carry only `success`. */
function outcomeOf(result: EvaluationResult) {
  return (
    result.generation.outcome ??
    (result.generation.success ? "completed" : "failed")
  );
}

function modelOf(result: EvaluationResult): string {
  if (outcomeOf(result) === "rejected") return "rejected";
  if (!result.generation.success) return "failed";
  return result.generation.selectedModel ?? "unknown";
}

function distribution(results: EvaluationResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const model = modelOf(result);
    counts[model] = (counts[model] ?? 0) + 1;
  }
  return counts;
}

function bucketOf(fraction: number): string {
  return STATE_BUCKETS.find((b) => fraction < b.max)!.label;
}

async function main() {
  const mode = executionMode();
  const stageC = await readCheckpoint<{
    budgetUsd: number;
    records: { sequenceIndex: number; result: EvaluationResult }[];
  }>(resultsPath("stage-c", mode));
  const stageB = await readCheckpoint<{ results: EvaluationResult[] }>(
    resultsPath("stage-b", mode),
  );
  const judgedC = await readCheckpoint<{ judgments: Judged[] }>(
    resultsPath("stage-c", mode, undefined, "judgments"),
  );
  if (!stageC) throw new Error(`No Stage C results for mode ${mode}.`);
  const scoreOf = new Map(
    (judgedC?.judgments ?? []).map((j) => [`${j.scenarioId}:${j.system}`, j]),
  );

  const report: Record<string, unknown> = {
    mode,
    generatedAt: new Date().toISOString(),
    costNote:
      "Costs are the pool's charges. For the Ollama pool these are shadow prices; nothing was billed.",
    qualityAvailable: scoreOf.size > 0,
  };

  const stageCSystems = SYSTEMS.map((system) => {
    const records = stageC.records
      .filter((r) => r.result.system === system)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    const results = records.map((r) => r.result);
    const judgment = (r: EvaluationResult) =>
      scoreOf.get(`${r.scenarioId}:${r.system}`) ?? null;
    const budget = stageC.budgetUsd;
    const last = results.at(-1)?.stateAfter ?? results.at(-1)?.stateBefore;
    const spent = last?.spentUsd ?? 0;
    const firstRejection = records.find(
      (r) => outcomeOf(r.result) === "rejected",
    );

    // 2. Quality by position in the month. Rejected or failed requests score 0.
    const size = Math.ceil(records.length / QUARTERS);
    const quarters = Array.from({ length: QUARTERS }, (_, q) => {
      const slice = results.slice(q * size, (q + 1) * size);
      const judged = slice.map(judgment).filter((j): j is Judged => j !== null);
      return {
        requests: `${q * size + 1}–${Math.min((q + 1) * size, results.length)}`,
        meanQuality: round(mean(judged.map((j) => j.overallScore))),
        passRate: judged.length
          ? round(judged.filter((j) => j.passed).length / judged.length)
          : null,
        models: distribution(slice),
      };
    });

    // 3. Model choice by budget state before each request.
    const byState = Object.fromEntries(
      STATE_BUCKETS.map((b) => [b.label, {} as Record<string, number>]),
    );
    for (const r of results) {
      const counts = byState[bucketOf(r.stateBefore.budgetUsedFraction)];
      const model = modelOf(r);
      counts[model] = (counts[model] ?? 0) + 1;
    }

    const passing = results.filter((r) => judgment(r)?.passed).length;
    return {
      system,
      requests: results.length,
      // 1. Budget compliance
      budgetUsd: budget,
      spentUsd: round(spent, 6),
      finalUtilization: round(spent / budget),
      withinBudget: spent <= budget + 1e-9,
      overspendingRequests: results.filter(
        (r) => (r.stateAfter?.spentUsd ?? 0) > budget + 1e-9,
      ).length,
      completed: results.filter((r) => outcomeOf(r) === "completed").length,
      rejected: results.filter((r) => outcomeOf(r) === "rejected").length,
      failed: results.filter((r) => outcomeOf(r) === "failed").length,
      // 1-1. Exhaustion timing
      firstRejectedRequest: firstRejection
        ? firstRejection.sequenceIndex + 1
        : null,
      utilizationAtFirstRejection: firstRejection
        ? round(firstRejection.result.stateBefore.budgetUsedFraction)
        : null,
      // 2. Quality over time
      qualityByQuarter: quarters,
      // 3. Adaptive routing
      modelsByBudgetState: byState,
      modelsOverall: distribution(results),
      // 4. Efficiency
      passingAnswers: scoreOf.size ? passing : null,
      costPerPassingAnswerUsd:
        scoreOf.size && passing ? round(spent / passing, 6) : null,
      unusedBudgetUsd: round(Math.max(0, budget - spent), 6),
    };
  });
  report.stageC = stageCSystems;

  if (stageB) {
    // Stage B fixes the budget state, so selection by state is read directly.
    report.stageB = SYSTEMS.map((system) => {
      const states: Record<string, Record<string, number>> = {};
      for (const r of stageB.results.filter((x) => x.system === system)) {
        const label = `${Math.round(r.stateBefore.budgetUsedFraction * 100)}% used`;
        states[label] ??= {};
        const model = modelOf(r);
        states[label][model] = (states[label][model] ?? 0) + 1;
      }
      return { system, modelsByBudgetState: states };
    });
  }

  const output = resultsPath("stage-c", mode, undefined, "report");
  await writeCheckpoint(output, report);

  console.log(`Mode: ${mode}. ${report.costNote as string}\n`);
  console.log("1. Budget compliance and 1-1. exhaustion timing (Stage C)");
  console.table(
    stageCSystems.map((s) => ({
      system: s.system,
      spent: s.spentUsd,
      budget: s.budgetUsd,
      used: s.finalUtilization,
      withinBudget: s.withinBudget,
      completed: s.completed,
      rejected: s.rejected,
      firstRejected: s.firstRejectedRequest ?? "none",
    })),
  );
  console.log("2. Quality over time (Stage C, mean judged score per quarter)");
  console.table(
    stageCSystems.flatMap((s) =>
      s.qualityByQuarter.map((q) => ({
        system: s.system,
        requests: q.requests,
        meanQuality: q.meanQuality ?? "not judged",
        passRate: q.passRate ?? "not judged",
      })),
    ),
  );
  console.log("3. Model selection by budget state");
  for (const s of stageCSystems) {
    console.log(`Stage C ${s.system}:`, JSON.stringify(s.modelsByBudgetState));
  }
  for (const s of (report.stageB as { system: string; modelsByBudgetState: unknown }[]) ?? []) {
    console.log(`Stage B ${s.system}:`, JSON.stringify(s.modelsByBudgetState));
  }
  console.log("\n4. Efficiency (Stage C)");
  console.table(
    stageCSystems.map((s) => ({
      system: s.system,
      passingAnswers: s.passingAnswers ?? "not judged",
      costPerPassingAnswer: s.costPerPassingAnswerUsd ?? "not judged",
      unusedBudget: s.unusedBudgetUsd,
    })),
  );
  console.log(`\nSaved ${output}`);
  if (mode === "mock") {
    console.log("Mock results test the report only. Do not cite them.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
