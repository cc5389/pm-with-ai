import test from "node:test";
import assert from "node:assert/strict";
import { buildPreview, qualityScore, suggestTask } from "../lib/engine";
import {
  DEFAULT_INPUT,
  DEFAULT_SETTINGS,
  MODELS,
  SCENARIOS,
} from "../lib/catalog";
import { BENCHMARK_PROMPTS, evaluate } from "../lib/benchmark";
import type { BudgetContext, RequestInput, Settings } from "../lib/types";

const context: BudgetContext = {
  spent: 100,
  reserved: 0,
  userSpent: 0,
  userReserved: 0,
  completedRequests: 0,
};
const preview = (
  input: Partial<RequestInput> = {},
  settings: Partial<Settings> = {},
  budget: Partial<BudgetContext> = {},
) =>
  buildPreview(
    { ...DEFAULT_INPUT, ...input },
    { ...DEFAULT_SETTINGS, ...settings },
    MODELS,
    { ...context, ...budget },
  );
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("default policy is deterministic, normalized, and selects an eligible model", () => {
  const a = preview(),
    b = preview();
  assert.deepEqual(a, b);
  close(
    Object.values(a.policy.weights).reduce((sum, x) => sum + x, 0),
    1,
  );
  assert.equal(a.selected?.model.id, "atlas-pro");
  assert.ok(a.selected?.eligible);
  assert.ok(a.policy.allowedModels.includes(a.selected!.model.id));
});
test("default scenario moves to cheaper models under late-month pressure", () => {
  const early = preview(),
    late = preview({}, { simulatedDate: SCENARIOS.tight.date }, { spent: 920 });
  close(late.policy.budget.pressure, 0.6);
  assert.ok(late.selected!.estimatedCost < early.selected!.estimatedCost);
  assert.equal(late.selected!.model.id, "spark-mini");
  assert.ok(late.policy.weights.cost > early.policy.weights.cost);
});
test("projection and depletion independently contribute budget pressure", () => {
  const projected = preview({}, {}, { spent: 500 });
  assert.equal(projected.policy.budget.pressure, 1);
  close(projected.policy.budget.projectedSpend, 500 + (500 / 3.5) * 27.5);
  assert.equal(
    preview({}, { simulatedDate: "2026-10-28" }, { spent: 920 }).policy.budget
      .pressure,
    0.6,
  );
});
test("opening spend is not counted twice and reservations reduce remaining funds", () => {
  const p = preview({}, { openingSpend: 500 }, { spent: 100, reserved: 25 });
  assert.equal(p.policy.budget.spent, 100);
  assert.equal(p.policy.budget.remaining, 875);
  close(p.policy.budget.utilization, 0.1);
});
test("cold start uses a labeled seeded projection instead of zero", () => {
  const p = preview({}, {}, { spent: 0, completedRequests: 0 });
  assert.ok(p.policy.budget.projectedSpend > 0);
  assert.ok(p.policy.assumptions.some((x) => x.startsWith("Cold-start")));
});
test("calendar calculations handle leap years, UTC noon, and year rollover", () => {
  const leap = preview({}, { simulatedDate: "2028-02-29" });
  assert.equal(leap.policy.budget.daysInMonth, 29);
  assert.equal(leap.policy.budget.elapsedDays, 28.5);
  assert.equal(
    preview({}, { simulatedDate: "2027-02-28" }).policy.budget.daysInMonth,
    28,
  );
  assert.equal(
    preview({}, { simulatedDate: "2026-12-31" }).policy.budget.daysInMonth,
    31,
  );
  assert.equal(
    preview({}, { simulatedDate: "2027-01-01T00:00:00Z" }).policy.budget
      .elapsedDays,
    0,
  );
  assert.equal(
    preview({}, { simulatedDate: "2026-12-31T23:00:00-02:00" }).policy.budget
      .elapsedDays,
    1 / 24,
  );
  assert.throws(
    () => preview({}, { simulatedDate: "not-a-date" }),
    /valid ISO/,
  );
});
test("observed volume can raise forecasts but cannot cause an allowance cliff at 20 completions", () => {
  close(
    preview({}, {}, { completedRequests: 19 }).policy.budget
      .expectedRemainingRequests,
    (10000 * 27.5) / 31,
  );
  close(
    preview({}, {}, { completedRequests: 20 }).policy.budget
      .expectedRemainingRequests,
    (10000 * 27.5) / 31,
  );
  close(
    preview({}, {}, { completedRequests: 20 }).policy.maxCostPerRequest,
    preview({}, {}, { completedRequests: 19 }).policy.maxCostPerRequest,
  );
  close(
    preview({}, {}, { completedRequests: 2000 }).policy.budget
      .expectedRemainingRequests,
    (2000 / 3.5) * 27.5,
  );
});
test("zero volume, zero weights and midnight avoid invalid arithmetic", () => {
  const p = preview(
    { weights: { quality: 0, cost: 0, latency: 0 }, latencyTarget: 0 },
    { monthlyRequests: 0, simulatedDate: "2026-10-01T00:00:00Z" },
    { spent: 0 },
  );
  assert.equal(p.policy.maxCostPerRequest, 1000);
  assert.deepEqual(p.policy.weights, { quality: 1, cost: 0, latency: 0 });
  for (const value of Object.values(p.policy.budget))
    if (typeof value === "number") assert.ok(Number.isFinite(value));
  for (const c of p.candidates)
    if (c.score !== null) assert.ok(Number.isFinite(c.score));
});
test("zero and exhausted budgets reject instead of dividing by zero", () => {
  for (const p of [
    preview({}, { monthlyBudget: 0 }),
    preview({}, {}, { spent: 1000 }),
    preview({}, {}, { spent: 900, reserved: 100 }),
  ]) {
    assert.equal(p.selected, null);
    assert.equal(p.policy.maxCostPerRequest, 0);
    assert.ok(Number.isFinite(p.policy.budget.pressure));
  }
});
test("team and request blocklists remain hard despite model preference", () => {
  const p = preview(
    { blockedModels: ["nova-balanced"], preferredModels: ["atlas-pro"] },
    { blockedModels: ["atlas-pro"] },
  );
  assert.notEqual(p.selected?.model.id, "atlas-pro");
  for (const id of ["atlas-pro", "nova-balanced"])
    assert.equal(p.candidates.find((c) => c.model.id === id)?.eligible, false);
});
test("quality floor is never relaxed to obtain an answer", () => {
  assert.equal(preview({ qualityFloor: 1 }).selected, null);
  const p = preview(
    { qualityFloor: 0.9 },
    { simulatedDate: "2026-10-28" },
    { spent: 990 },
  );
  assert.equal(p.selected, null);
});
test("explicit cost cap is hard and preferences cannot override it", () => {
  const p = preview({ maxRequestCost: 0.005, preferredModels: ["atlas-pro"] });
  assert.equal(p.selected?.model.id, "spark-mini");
  assert.ok(p.selected!.estimatedCost <= 0.005);
  assert.equal(preview({ maxRequestCost: 0 }).selected, null);
});
test("user budget uses equal expected workload and includes pending reservations", () => {
  const p = preview(
    { userId: "maya" },
    {},
    { userSpent: 100, userReserved: 5 },
  );
  assert.equal(p.policy.budget.userRemaining, 15);
  close(p.policy.maxCostPerRequest, (15 / ((10000 * 27.5) / 31 / 3)) * 1.5);
  assert.equal(
    preview({ userId: "maya" }, {}, { userSpent: 120 }).selected,
    null,
  );
  assert.equal(preview({ userId: "unknown" }).selected, null);
});
test("importance raises quality weight and allowance without exceeding remaining money", () => {
  const low = preview({ importance: "low" }),
    high = preview({ importance: "high" });
  assert.ok(high.policy.weights.quality > low.policy.weights.quality);
  close(high.policy.maxCostPerRequest, low.policy.maxCostPerRequest * 2);
  assert.ok(high.policy.maxCostPerRequest <= high.policy.budget.remaining);
  assert.equal(
    preview({ importance: "high", maxRequestCost: 0.01 }).policy
      .maxCostPerRequest,
    0.01,
  );
});
test("latency is soft by default and hard when explicitly strict", () => {
  assert.ok(preview({ latencyTarget: 0.1 }).selected);
  assert.equal(
    preview({ latencyTarget: 0.1, strictLatency: true }).selected,
    null,
  );
});
test("context capacity and privacy constraints reject incompatible candidates", () => {
  assert.equal(preview({ outputTokens: 200000 }).selected, null);
  assert.equal(preview({ localOnly: true }).selected, null);
  assert.equal(preview({ mode: "local" }).selected, null);
});
test("a free uncalibrated local model is available only at an explicit zero quality floor", () => {
  const local = {
    ...MODELS[0],
    id: "local",
    local: true,
    inputPrice: 0,
    outputPrice: 0,
    quality: { coding: 0, analysis: 0, writing: 0, qa: 0 },
  };
  const run = (qualityFloor: number) =>
    buildPreview(
      { ...DEFAULT_INPUT, mode: "local", qualityFloor, maxRequestCost: 0 },
      DEFAULT_SETTINGS,
      [local],
      context,
    );
  assert.equal(run(0).selected?.model.id, "local");
  assert.equal(run(0.1).selected, null);
});
test("preferences break exact score ties but never outrank a better score", () => {
  const clones = [
    { ...MODELS[1], id: "a" },
    { ...MODELS[1], id: "b" },
  ];
  assert.equal(
    buildPreview(
      { ...DEFAULT_INPUT, preferredModels: ["b"] },
      DEFAULT_SETTINGS,
      clones,
      context,
    ).selected?.model.id,
    "b",
  );
  assert.equal(
    preview({ preferredModels: ["spark-mini"] }).selected?.model.id,
    "atlas-pro",
  );
});
test("human rubric rescales one through five to zero through one", () => {
  assert.equal(
    qualityScore({ correctness: 1, completeness: 1, instructionFollowing: 1 }),
    0,
  );
  assert.equal(
    qualityScore({ correctness: 4, completeness: 4, instructionFollowing: 4 }),
    0.75,
  );
  assert.equal(
    qualityScore({ correctness: 5, completeness: 5, instructionFollowing: 5 }),
    1,
  );
  assert.throws(() =>
    qualityScore({
      correctness: NaN,
      completeness: 4,
      instructionFollowing: 3,
    }),
  );
  assert.throws(() =>
    qualityScore({ correctness: 0, completeness: 4, instructionFollowing: 3 }),
  );
});
test("task suggestion remains a deterministic editable heuristic", () => {
  assert.equal(suggestTask("Implement a Python function"), "coding");
  assert.equal(suggestTask("Compare options and risks"), "analysis");
  assert.equal(suggestTask("Draft an email"), "writing");
  assert.equal(suggestTask("What is a prime number?"), "qa");
});
test("benchmark has 40 unique hand-authored prompts and balanced held-out splits", () => {
  assert.equal(BENCHMARK_PROMPTS.length, 40);
  assert.equal(new Set(BENCHMARK_PROMPTS.map((p) => p.prompt)).size, 40);
  for (const task of ["coding", "analysis", "writing", "qa"])
    for (const split of ["calibration", "evaluation"])
      assert.equal(
        BENCHMARK_PROMPTS.filter((p) => p.task === task && p.split === split)
          .length,
        5,
      );
});
test("benchmark replays all strategies with bounded simulated metrics", () => {
  const result = evaluate(
    {
      ...DEFAULT_SETTINGS,
      scenario: "tight",
      simulatedDate: SCENARIOS.tight.date,
      openingSpend: 920,
    },
    MODELS,
    DEFAULT_INPUT,
  );
  assert.equal(result.sampleCount, 20);
  assert.deepEqual(
    result.rows.map((r) => r.strategy),
    ["strongest", "cheapest", "fixed", "adaptive"],
  );
  for (const row of result.rows) {
    assert.equal(row.submitted, 20);
    assert.equal(row.completed, 20);
    assert.ok(row.totalCost <= 80);
    assert.ok(
      row.constraintSatisfactionRate >= 0 &&
        row.constraintSatisfactionRate <= 1,
    );
    assert.equal(row.qualityPassRate, 1);
    assert.ok(row.p50Latency! <= row.p95Latency!);
    assert.ok(row.routingOverheadMs >= 0);
  }
  assert.ok(result.rows[3].totalCost < result.rows[0].totalCost);
  assert.equal(result.rows[3].constraintSatisfactionRate, 1);
  assert.match(result.caveat, /not generated answers or measured/);
});
test("empty benchmark results remain explicit nulls instead of fabricated quality", () => {
  const result = evaluate(
    { ...DEFAULT_SETTINGS, monthlyBudget: 0, openingSpend: 0 },
    MODELS,
    DEFAULT_INPUT,
  );
  for (const row of result.rows) {
    assert.equal(row.completed, 0);
    assert.equal(row.meanQuality, null);
    assert.equal(row.p50Latency, null);
    assert.equal(row.qualityPassRate, null);
    assert.equal(row.savings, null);
    assert.equal(row.totalCost, 0);
    assert.deepEqual(row.qualityOverTime, Array(20).fill(null));
  }
});
