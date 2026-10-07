import { buildPreview } from "./engine";
import type {
  BenchmarkPrompt,
  BudgetContext,
  Candidate,
  EvaluationResult,
  EvaluationRow,
  ModelProfile,
  RequestInput,
  Settings,
  Task,
} from "./types";

const PROMPTS: Record<Task, [string, string][]> = {
  coding: [
    [
      "Write a Python function that returns the second distinct largest integer in a list. Explain empty and duplicate-only cases.",
      "Distinctness, boundary cases, valid Python.",
    ],
    [
      "Implement a TypeScript debounce utility with cancellation and preserved argument types.",
      "Timer reset, cancellation, type correctness.",
    ],
    [
      "Explain why a SQL LEFT JOIN can lose unmatched rows when a right-table filter is in WHERE. Correct the query.",
      "NULL semantics, corrected join filter, example.",
    ],
    [
      "Write a JavaScript function to group records by category without mutating the input.",
      "Correct grouping, immutability, missing-category handling.",
    ],
    [
      "Design unit tests for an inclusive date-range overlap function, including adjacent intervals.",
      "Overlap cases, inclusivity, disjoint ranges.",
    ],
    [
      "Write a Python function to merge overlapping closed intervals. State its complexity and cover an empty input.",
      "Correct merge, sorted output, complexity, boundaries.",
    ],
    [
      "Implement a TypeScript discriminated union for success and failure API responses and safely read its result.",
      "Sound union, narrowing, executable example.",
    ],
    [
      "Debug a binary search that loops forever when low equals mid. Explain and fix the boundary updates.",
      "Progress invariant, correct bounds, absent values.",
    ],
    [
      "Write SQL to return the top two salaries per department, including ties. Explain the ranking choice.",
      "Partitioning, tie behavior, ranking correctness.",
    ],
    [
      "Implement a bounded FIFO queue in Python that rejects overflow and handles underflow explicitly.",
      "FIFO order, capacity, errors, concise example.",
    ],
  ],
  analysis: [
    [
      "Compare a subscription and a usage-based price for a small analytics tool. Identify two risks of each.",
      "Balanced comparison, explicit risks, actionable recommendation.",
    ],
    [
      "A signup experiment has 40 conversions among 400 visitors versus 54 among 450. Analyze what is known and uncertain.",
      "Correct rates, uncertainty, no unjustified causal claim.",
    ],
    [
      "Prioritize three roadmap items with reach, effort, and uncertainty: export, onboarding, and team permissions.",
      "Explicit assumptions, consistent prioritization, uncertainty.",
    ],
    [
      "Evaluate whether a five-person startup should build or buy a customer-support tool.",
      "Costs, integration risks, decision criteria.",
    ],
    [
      "Outline a pre-mortem for launching a mobile app in a new market.",
      "Concrete failure modes, leading indicators, mitigations.",
    ],
    [
      "Compare centralized and per-team AI budgets for a 30-person company. Recommend a hybrid policy.",
      "Tradeoffs, governance, workable hybrid and assumptions.",
    ],
    [
      "Retention rose after a redesign, but the signup channel also changed. Explain plausible confounders and a better study.",
      "Confounding identified, causal caution, test design.",
    ],
    [
      "Evaluate three ways to reduce customer onboarding time without hiding necessary setup steps.",
      "Feasible alternatives, user impact, measurable success.",
    ],
    [
      "A service has a 99% success rate but tenfold peak-hour demand. Assess the risks in reporting only the daily average.",
      "Distribution and load effects, relevant metrics, mitigations.",
    ],
    [
      "Create a decision framework for entering one of two markets with sparse demand evidence and different acquisition costs.",
      "Explicit criteria, uncertainty handling, reversible experiment.",
    ],
  ],
  writing: [
    [
      "Draft a concise announcement for a dashboard redesign, emphasizing where existing reports moved.",
      "Clear change, navigation guidance, concise tone.",
    ],
    [
      "Rewrite an outage apology to acknowledge impact without promising an unverified cause or recovery time.",
      "Accountability, uncertainty, helpful next update.",
    ],
    [
      "Write a welcoming onboarding email for a collaborative note-taking tool, with one clear call to action.",
      "Friendly tone, concise value, single action.",
    ],
    [
      "Write a short product description for a reusable travel mug without unverifiable environmental claims.",
      "Concrete benefits, factual restraint, readability.",
    ],
    [
      "Draft three different headlines for a guide to organizing personal research notes.",
      "Three distinct headlines, relevance, clear language.",
    ],
    [
      "Draft a 100-word release note for a new CSV export feature, including who can use it and where to find it.",
      "Length, useful details, explicit assumptions about access.",
    ],
    [
      "Write a respectful email declining a feature request while explaining how feedback informs planning.",
      "Empathy, clear decision, no false commitment.",
    ],
    [
      "Rewrite a technical backup warning in plain language with one immediate action and one consequence.",
      "Plain language, actionable step, accurate consequence.",
    ],
    [
      "Draft an internal launch update that distinguishes completed work, known limitations, and the next milestone.",
      "Clear status distinctions, practical detail, concise style.",
    ],
    [
      "Write a brief invitation to a research interview that states duration, purpose, and voluntary participation.",
      "Required details, neutral invitation, no coercion.",
    ],
  ],
  qa: [
    [
      "What is the difference between a median and a mean? Give an example where they differ substantially.",
      "Accurate definitions and computed example.",
    ],
    [
      "Explain HTTP 404 versus HTTP 500 in two short paragraphs.",
      "Client/server distinction, accurate examples, format.",
    ],
    [
      "Why does a leap year usually have 366 days? Include the Gregorian century exception.",
      "Correct leap rule and century exception.",
    ],
    [
      "What does database normalization aim to prevent? Give one concrete example.",
      "Redundancy and anomalies, relevant example.",
    ],
    [
      "Explain the difference between authentication and authorization using a shared document.",
      "Identity versus permission, consistent example.",
    ],
    [
      "A product costs $80 and is discounted 25%, then taxed 10%. What is the final price? Show the steps.",
      "Correct order and final price of $66.",
    ],
    [
      "What is the difference between precision and recall? Illustrate with a spam filter.",
      "Correct denominators, helpful spam example.",
    ],
    [
      "Convert 2.5 hours into minutes and seconds, showing both calculations.",
      "150 minutes, 9000 seconds, calculations.",
    ],
    [
      "What distinguishes a stack from a queue? Name one appropriate use of each.",
      "LIFO and FIFO, accurate uses.",
    ],
    [
      "If all tulips are flowers and some flowers fade quickly, must some tulips fade quickly? Explain.",
      "No invalid inference, counterexample or clear logic.",
    ],
  ],
};
/** Hand-authored split: first five per task calibrate; last five are held out for evaluation. */
export const BENCHMARK_PROMPTS: BenchmarkPrompt[] = Object.entries(
  PROMPTS,
).flatMap(([task, pairs]) =>
  pairs.map(([prompt, rubric], index) => ({
    id: `${task}-${String(index + 1).padStart(2, "0")}`,
    task: task as Task,
    split: index < 5 ? ("calibration" as const) : ("evaluation" as const),
    prompt,
    rubric,
  })),
);

const quantile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p,
    lower = Math.floor(index),
    fraction = index - lower;
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * fraction;
};

/** Offline replay: no response generation, paid API calls, or measured model-quality claims. */
export function evaluate(
  settings: Settings,
  models: ModelProfile[],
  input: RequestInput,
): EvaluationResult {
  const prompts = BENCHMARK_PROMPTS.filter((p) => p.split === "evaluation");
  const rows: EvaluationRow[] = [];
  const completedIds: string[][] = [];
  for (const strategy of [
    "strongest",
    "cheapest",
    "fixed",
    "adaptive",
  ] as const) {
    const context: BudgetContext = {
      spent: settings.openingSpend,
      reserved: 0,
      userSpent: 0,
      userReserved: 0,
      completedRequests: 0,
    };
    const qualities: number[] = [],
      qualityOverTime: (number | null)[] = [],
      latencies: number[] = [],
      modelCounts: Record<string, number> = {};
    const ids: string[] = [];
    let totalCost = 0,
      passes = 0,
      satisfied = 0,
      routingMs = 0;
    for (const prompt of prompts) {
      const request: RequestInput = {
        ...input,
        prompt: prompt.prompt,
        task: prompt.task,
        mode: "simulation",
      };
      const start = performance.now();
      const original = buildPreview(request, settings, models, context);
      let selected: Candidate | null = original.selected;
      if (strategy !== "adaptive") {
        const blocked = new Set([
          ...settings.blockedModels,
          ...input.blockedModels,
        ]);
        const budget = original.policy.budget;
        const staticCap =
          input.maxRequestCost ??
          settings.monthlyBudget / Math.max(settings.monthlyRequests, 1);
        // Baselines honor all explicit hard restrictions; only the adaptive share/score changes.
        const eligible = original.candidates.filter(
          (c) =>
            !c.model.local &&
            !input.localOnly &&
            !blocked.has(c.model.id) &&
            settings.users.some((u) => u.id === input.userId) &&
            budget.monthlyBudget > 0 &&
            budget.remaining > 0 &&
            (budget.userRemaining === null || budget.userRemaining > 0) &&
            c.inputTokens + c.outputTokens <= c.model.contextWindow &&
            c.estimatedCost <= budget.remaining + 1e-12 &&
            c.estimatedCost <= (budget.userRemaining ?? Infinity) + 1e-12 &&
            c.estimatedCost <= (input.maxRequestCost ?? Infinity) + 1e-12 &&
            c.estimatedQuality >= input.qualityFloor &&
            (!input.strictLatency ||
              c.estimatedLatency <= input.latencyTarget) &&
            (strategy !== "fixed" || c.estimatedCost <= staticCap + 1e-12),
        );
        const totalWeight =
          Math.max(input.weights.quality, 0) +
          Math.max(input.weights.cost, 0) +
          Math.max(input.weights.latency, 0);
        const fixedScore = (c: Candidate) =>
          totalWeight > 0
            ? (Math.max(input.weights.quality, 0) * c.estimatedQuality -
                Math.max(input.weights.cost, 0) *
                  (staticCap > 0
                    ? Math.min(c.estimatedCost / staticCap, 1)
                    : c.estimatedCost === 0
                      ? 0
                      : 1) -
                Math.max(input.weights.latency, 0) *
                  (input.latencyTarget > 0
                    ? Math.min(c.estimatedLatency / input.latencyTarget, 2)
                    : c.estimatedLatency === 0
                      ? 0
                      : 2)) /
              totalWeight
            : c.estimatedQuality;
        eligible.sort(
          (a, b) =>
            (strategy === "strongest"
              ? b.estimatedQuality - a.estimatedQuality
              : strategy === "cheapest"
                ? a.estimatedCost - b.estimatedCost
                : fixedScore(b) - fixedScore(a)) ||
            Number(b.preferred) - Number(a.preferred) ||
            a.estimatedCost - b.estimatedCost ||
            a.model.id.localeCompare(b.model.id, "en"),
        );
        selected = eligible[0] ?? null;
      }
      routingMs += performance.now() - start;
      if (!selected) {
        qualityOverTime.push(null);
        continue;
      }
      ids.push(prompt.id);
      qualityOverTime.push(selected.estimatedQuality);
      context.spent += selected.estimatedCost;
      context.userSpent += selected.estimatedCost;
      context.completedRequests++;
      totalCost += selected.estimatedCost;
      qualities.push(selected.estimatedQuality);
      latencies.push(selected.estimatedLatency);
      if (selected.estimatedQuality >= request.qualityFloor) passes++;
      if (
        original.candidates.find((c) => c.model.id === selected.model.id)
          ?.eligible
      )
        satisfied++;
      modelCounts[selected.model.id] =
        (modelCounts[selected.model.id] ?? 0) + 1;
    }
    completedIds.push(ids);
    const completed = qualities.length;
    rows.push({
      strategy,
      submitted: prompts.length,
      completed,
      completionRate: completed / prompts.length,
      totalCost,
      averageCost: completed ? totalCost / completed : 0,
      meanQuality: completed
        ? qualities.reduce((a, b) => a + b, 0) / completed
        : null,
      qualityPassRate: completed ? passes / completed : null,
      constraintSatisfactionRate: satisfied / prompts.length,
      p50Latency: quantile(latencies, 0.5),
      p95Latency: quantile(latencies, 0.95),
      routingOverheadMs: routingMs / prompts.length,
      savings: null,
      modelCounts,
      qualityOverTime,
    });
  }
  const baseline = rows[0];
  rows.forEach((row, index) => {
    const sameWorkload =
      completedIds[index].length === completedIds[0].length &&
      completedIds[index].every(
        (id, position) => id === completedIds[0][position],
      );
    row.savings =
      baseline.totalCost > 0 && sameWorkload
        ? 1 - row.totalCost / baseline.totalCost
        : null;
  });
  return {
    mode: "simulation",
    scenario: settings.scenario,
    sampleCount: prompts.length,
    rows,
    caveat:
      "Illustrative offline simulation: quality and model latency come from fictional task profiles, not generated answers or measured model performance. Only routing overhead is timed locally. All strategies replay the same 20 held-out prompts from the same opening spend. Constraint satisfaction counts completions meeting the original adaptive policy, divided by submissions; rejections do not count as satisfied. Savings are shown only when the exact completed prompt IDs match the strongest baseline. Calibration prompts are excluded from evaluation.",
  };
}
