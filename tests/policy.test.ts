import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePolicy, DEFAULT_COMPANY_POLICY } from "../lib/policy";
import { buildPreview } from "../lib/engine";
import { DEFAULT_INPUT, DEFAULT_SETTINGS, MODELS } from "../lib/catalog";
import { companyPolicySchema, settingsSchema } from "../lib/validation";
import {
  db,
  getSettings,
  saveSettings,
  history,
  budgetContext,
} from "../lib/db";
import { previewRequest, runRequest } from "../lib/service";
import { randomUUID } from "node:crypto";
import type { BudgetContext, RequestInput, Settings } from "../lib/types";

process.env.ORCHESTRA_DB_PATH = ":memory:";
const context: BudgetContext = {
  spent: 20,
  reserved: 0,
  completedRequests: 0,
  userSpent: 0,
  userReserved: 0,
};
const settings: Settings = {
  ...DEFAULT_SETTINGS,
  monthlyBudget: 100,
  monthlyRequests: 3100,
  simulatedDate: "2026-10-16T00:00:00Z",
};
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const calculate = (
  input: Partial<RequestInput> = {},
  state: Partial<BudgetContext> = {},
  config: Partial<Settings> = {},
) =>
  derivePolicy(
    { ...DEFAULT_INPUT, ...input },
    { ...settings, ...config },
    { ...context, ...state },
    40,
  );

test("Agent1 works without models and records a worked calculation for each importance", () => {
  const policy = calculate();
  assert.equal(policy.version, "1.1");
  assert.equal(policy.budget.remaining, 80);
  assert.equal(policy.budget.expectedRemainingRequests, 1600);
  close(policy.maxCostPerRequest, 0.075);
  close(policy.weights.quality, 6 / 7);
  assert.deepEqual(policy.calculation.bindingLimits, [
    "Team request allowance",
  ]);
  assert.equal("allowedModels" in policy, false);
  for (const row of policy.calculation.importanceComparison) {
    const independent = calculate({ importance: row.importance });
    assert.equal(row.allowance, independent.maxCostPerRequest);
    assert.deepEqual(row.weights, independent.weights);
    assert.equal(independent.qualityFloor, DEFAULT_INPUT.qualityFloor);
  }
});

test("pressure settings change independently, including threshold boundaries", () => {
  const lowBalance = calculate(
    {},
    { spent: 90 },
    { simulatedDate: "2026-10-31" },
  );
  close(lowBalance.calculation.lowBalancePressure, 0.5);
  assert.equal(lowBalance.calculation.projectionPressure, 0);
  const tuned = calculate(
    {},
    { spent: 90 },
    {
      simulatedDate: "2026-10-31",
      companyPolicy: {
        ...DEFAULT_COMPANY_POLICY,
        lowBalanceThreshold: 0.5,
        costPressureStrength: 0,
      },
    },
  );
  close(tuned.calculation.lowBalancePressure, 0.8);
  assert.deepEqual(tuned.weights, calculate().weights);
  assert.equal(
    calculate({}, { spent: 80 }, { simulatedDate: "2026-10-31" }).calculation
      .lowBalancePressure,
    0,
  );
  assert.equal(calculate({}, { spent: 100 }).budget.pressure, 1);
  assert.equal(
    calculate({}, { spent: 90 }, { simulatedDate: "2026-10-02" }).calculation
      .projectionPressure,
    1,
  );
});

test("hard caps bind across importance and trace all ties", () => {
  const capped = calculate({ maxRequestCost: 0.01 });
  assert.ok(
    capped.calculation.importanceComparison.every(
      (row) => row.allowance === 0.01,
    ),
  );
  assert.deepEqual(capped.calculation.bindingLimits, ["Explicit request cap"]);
  assert.deepEqual(
    calculate({ importance: "high", maxRequestCost: 0.1 }).calculation
      .bindingLimits,
    ["Team request allowance", "Explicit request cap"],
  );
  const userLimited = calculate(
    { userId: "maya" },
    { userSpent: 119, userReserved: 0.5 },
  );
  close(userLimited.budget.userRemaining!, 0.5);
  close(userLimited.maxCostPerRequest, (0.5 / (1600 / 3)) * 1.5);
  assert.deepEqual(userLimited.calculation.bindingLimits, [
    "User request allowance",
  ]);
  assert.equal(calculate({}, { spent: 20, reserved: 80 }).maxCostPerRequest, 0);
  assert.equal(calculate({}, {}, { monthlyBudget: 0 }).maxCostPerRequest, 0);
});

test("multipliers preserve order and zero quality preference stays zero", () => {
  const rules = {
    ...DEFAULT_COMPANY_POLICY,
    mediumMultiplier: 2,
    highMultiplier: 3,
  };
  const policy = calculate(
    { weights: { quality: 0, cost: 1, latency: 0 } },
    {},
    { companyPolicy: rules },
  );
  assert.ok(
    policy.calculation.importanceComparison.every(
      (row) => row.weights.quality === 0,
    ),
  );
  policy.calculation.importanceComparison.forEach((row, index) =>
    close(row.allowance, [0.05, 0.1, 0.15][index]),
  );
  assert.deepEqual(
    calculate({ weights: { quality: 0, cost: 0, latency: 0 } }).weights,
    { quality: 1, cost: 0, latency: 0 },
  );
  for (const invalid of [
    { ...rules, highMultiplier: 1 },
    { ...rules, mediumMultiplier: 0 },
    { ...rules, highMultiplier: 4 },
    { ...rules, costPressureStrength: -1 },
    { ...rules, costPressureStrength: Infinity },
    { ...rules, lowBalanceThreshold: 0 },
    { ...rules, lowBalanceThreshold: 0.51 },
  ])
    assert.equal(companyPolicySchema.safeParse(invalid).success, false);
});

test("forecast traces distinguish seeded, configured and observed estimates", () => {
  assert.equal(calculate({}, { spent: 0 }).budget.projectedSpend, 40);
  assert.equal(calculate({}, { spent: 0 }).calculation.coldStart, true);
  assert.equal(
    calculate({}, { completedRequests: 19 }).calculation.observedRemaining,
    null,
  );
  close(
    calculate({}, { completedRequests: 20 }).maxCostPerRequest,
    calculate({}, { completedRequests: 19 }).maxCostPerRequest,
  );
  assert.ok(
    calculate({}, { completedRequests: 3000 }).budget
      .expectedRemainingRequests > 1600,
  );
  const leap = calculate({}, {}, { simulatedDate: "2028-02-29" });
  assert.equal(leap.budget.daysInMonth, 29);
  assert.equal(leap.calculation.daysLeft, 0.5);
});

test("default compatibility, immutable inputs, and routing composition", () => {
  const legacy = { ...settings };
  delete legacy.companyPolicy;
  const before = JSON.stringify({
    input: DEFAULT_INPUT,
    settings: legacy,
    context,
  });
  const policy = derivePolicy(DEFAULT_INPUT, legacy, context, 40);
  const preview = buildPreview(DEFAULT_INPUT, legacy, MODELS, context);
  assert.equal(preview.policy.maxCostPerRequest, policy.maxCostPerRequest);
  assert.deepEqual(preview.policy.weights, policy.weights);
  assert.equal(
    JSON.stringify({ input: DEFAULT_INPUT, settings: legacy, context }),
    before,
  );
  const validLegacy = { ...DEFAULT_SETTINGS };
  delete validLegacy.companyPolicy;
  assert.deepEqual(
    settingsSchema.parse(validLegacy).companyPolicy,
    DEFAULT_COMPANY_POLICY,
  );
});

test("saved legacy settings get defaults; draft rules do not write; history retains its snapshot", async () => {
  db().exec("DELETE FROM requests");
  const legacy = { ...DEFAULT_SETTINGS };
  delete legacy.companyPolicy;
  saveSettings(legacy);
  assert.deepEqual(getSettings().companyPolicy, DEFAULT_COMPANY_POLICY);
  const before = budgetContext(getSettings(), DEFAULT_INPUT);
  const tuned = {
    ...getSettings(),
    companyPolicy: {
      ...DEFAULT_COMPANY_POLICY,
      mediumMultiplier: 2,
      highMultiplier: 3,
    },
  };
  const draft = previewRequest(DEFAULT_INPUT, tuned);
  assert.equal(draft.policy.calculation!.multiplier, 2);
  assert.deepEqual(getSettings().companyPolicy, DEFAULT_COMPANY_POLICY);
  assert.deepEqual(budgetContext(getSettings(), DEFAULT_INPUT), before);
  assert.equal(history().length, 0);
  const record = await runRequest(DEFAULT_INPUT, randomUUID());
  saveSettings(tuned);
  assert.equal(history()[0].preview.policy.calculation!.multiplier, 1.5);
  assert.deepEqual(history()[0].preview.policy, record.preview.policy);
  assert.equal(previewRequest(DEFAULT_INPUT).policy.calculation!.multiplier, 2);
});
