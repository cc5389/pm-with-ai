import { classifyTask } from "./classification";
import type {
  BudgetContext,
  CompanyPolicyRules,
  Importance,
  Policy,
  PolicyCalculation,
  RequestInput,
  Settings,
  Weights,
} from "./types";

export const DEFAULT_COMPANY_POLICY: Readonly<CompanyPolicyRules> = {
  lowBalanceThreshold: 0.2,
  costPressureStrength: 2,
  mediumMultiplier: 1.5,
  highMultiplier: 2,
};
export const resolveCompanyPolicy = (
  settings: Pick<Settings, "companyPolicy">,
): CompanyPolicyRules => ({
  ...DEFAULT_COMPANY_POLICY,
  ...settings.companyPolicy,
});
export const importanceMultiplier = (
  importance: Importance,
  rules: CompanyPolicyRules,
) =>
  importance === "low"
    ? 1
    : importance === "medium"
      ? rules.mediumMultiplier
      : rules.highMultiplier;
const clip = (value: number) => Math.min(1, Math.max(0, value));
const positive = (value: number) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;
function normalize(weights: Weights): Weights {
  const total = weights.quality + weights.cost + weights.latency;
  return total > 0
    ? {
        quality: weights.quality / total,
        cost: weights.cost / total,
        latency: weights.latency / total,
      }
    : { quality: 1, cost: 0, latency: 0 };
}

/** Agent1 only: deterministic policy math, without routing, inference, or accounting writes.
 * coldStartProjectedSpend is supplied by the caller, in USD for the full month.
 * Inputs should be validated at the API boundary; spent already includes opening spend.
 */
export function derivePolicy(
  input: RequestInput,
  settings: Settings,
  context: BudgetContext,
  coldStartProjectedSpend: number,
): Omit<Policy, "allowedModels"> & { calculation: PolicyCalculation } {
  if (input.importanceMode === "inferred") {
    input = { ...input, importance: classifyTask(input.prompt).importance };
  }
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(settings.simulatedDate)
      ? `${settings.simulatedDate}T12:00:00.000Z`
      : settings.simulatedDate,
  );
  if (!Number.isFinite(date.getTime()))
    throw new Error("The simulated date must be a valid ISO date.");
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const daysInMonth = (end - start) / 86400000;
  const elapsedDays = Math.min(
    daysInMonth,
    Math.max(0, (date.getTime() - start) / 86400000),
  );
  const daysLeft = Math.max(0, daysInMonth - elapsedDays);
  const rules = resolveCompanyPolicy(settings);
  const monthlyBudget = positive(settings.monthlyBudget);
  const spent = positive(context.spent),
    reserved = positive(context.reserved);
  const remaining = Math.max(monthlyBudget - spent - reserved, 0);
  const completed = positive(context.completedRequests);
  const coldStart = spent === 0 && completed === 0;
  const projectedSpend = coldStart
    ? positive(coldStartProjectedSpend)
    : spent + (spent / Math.max(elapsedDays, 1)) * daysLeft;
  const configuredRemaining =
    (positive(settings.monthlyRequests) * daysLeft) / daysInMonth;
  const observedRemaining =
    completed >= 20 ? (completed / Math.max(elapsedDays, 1)) * daysLeft : null;
  const expectedRemainingRequests = Math.max(
    configuredRemaining,
    observedRemaining ?? 0,
  );
  const projectionPressure =
    monthlyBudget > 0 ? clip(projectedSpend / monthlyBudget - 1) : 1;
  const lowBalancePressure =
    monthlyBudget > 0
      ? clip(1 - remaining / (rules.lowBalanceThreshold * monthlyBudget))
      : 1;
  const pressure = Math.max(projectionPressure, lowBalancePressure);
  const user = settings.users.find((u) => u.id === input.userId);
  const userRemaining =
    user?.budget == null
      ? null
      : Math.max(
          0,
          positive(user.budget) -
            positive(context.userSpent) -
            positive(context.userReserved),
        );
  const baseAllowance = remaining / Math.max(expectedRemainingRequests, 1);
  const baseUserAllowance =
    userRemaining === null
      ? null
      : userRemaining /
        Math.max(
          expectedRemainingRequests / Math.max(settings.users.length, 1),
          1,
        );
  const baseWeights = {
    quality: positive(input.weights.quality),
    cost: positive(input.weights.cost),
    latency: positive(input.weights.latency),
  };
  function forImportance(level: Importance) {
    const multiplier = importanceMultiplier(level, rules);
    const adjustedWeights = {
      quality: baseWeights.quality * multiplier,
      cost: baseWeights.cost + rules.costPressureStrength * pressure,
      latency: baseWeights.latency,
    };
    const teamAllowance = baseAllowance * multiplier;
    const userAllowance =
      baseUserAllowance === null ? null : baseUserAllowance * multiplier;
    const allowanceLimits = [
      { name: "Company funds remaining", amount: remaining },
      { name: "Team request allowance", amount: teamAllowance },
      ...(input.maxRequestCost === null
        ? []
        : [
            {
              name: "Explicit request cap",
              amount: positive(input.maxRequestCost),
            },
          ]),
      ...(userRemaining === null
        ? []
        : [{ name: "User funds remaining", amount: userRemaining }]),
      ...(userAllowance === null
        ? []
        : [{ name: "User request allowance", amount: userAllowance }]),
    ];
    const allowance = Math.min(...allowanceLimits.map((limit) => limit.amount));
    const bindingLimits = allowanceLimits
      .filter((limit) => Math.abs(limit.amount - allowance) <= 1e-12)
      .map((limit) => limit.name);
    return {
      importance: level,
      multiplier,
      adjustedWeights,
      weights: normalize(adjustedWeights),
      teamAllowance,
      userAllowance,
      allowanceLimits,
      allowance,
      bindingLimits,
    };
  }
  const current = forImportance(input.importance);
  const importanceComparison = (["low", "medium", "high"] as const).map(
    (level) => {
      const result = forImportance(level);
      return {
        importance: level,
        multiplier: result.multiplier,
        allowance: result.allowance,
        weights: result.weights,
        bindingLimits: result.bindingLimits,
      };
    },
  );
  return {
    version: "1.1",
    task: input.task,
    importance: input.importance,
    weights: current.weights,
    qualityFloor: input.qualityFloor,
    latencyTarget: input.latencyTarget,
    strictLatency: input.strictLatency,
    maxCostPerRequest: current.allowance,
    budget: {
      monthlyBudget,
      spent,
      reserved,
      remaining,
      utilization: monthlyBudget > 0 ? spent / monthlyBudget : 0,
      projectedSpend,
      elapsedDays,
      daysInMonth,
      expectedRemainingRequests,
      pressure,
      requestAllowance: current.allowance,
      userRemaining,
    },
    calculation: {
      rules,
      multiplier: current.multiplier,
      baseWeights,
      adjustedWeights: current.adjustedWeights,
      daysLeft,
      completedRequests: completed,
      coldStart,
      configuredRemaining,
      observedRemaining,
      projectionPressure,
      lowBalancePressure,
      baseAllowance,
      teamAllowance: current.teamAllowance,
      userAllowance: current.userAllowance,
      allowanceLimits: current.allowanceLimits,
      bindingLimits: current.bindingLimits,
      importanceComparison,
    },
    reasons: [
      `Budget pressure is ${(pressure * 100).toFixed(1)}%; weights are normalized after adapting to importance and pressure.`,
      `Allowance shares $${remaining.toFixed(2)} across approximately ${Math.ceil(expectedRemainingRequests)} remaining requests, with a ${current.multiplier.toFixed(1)}× importance factor.`,
    ],
    assumptions: [
      "Costs reserve the full output estimate; quality and latency thresholds apply to estimates, not guarantees.",
      coldStart
        ? "Cold-start projection uses a supplied full-month estimate; it is not an observed traffic forecast."
        : "Projection extrapolates spend to date, including opening spend; reservations reduce remaining funds.",
      completed >= 20
        ? "Remaining volume is the larger of configured prorated volume and observed completions per elapsed day."
        : "Fewer than 20 observed completions: remaining volume uses configured monthly volume prorated over the UTC calendar month.",
      "Optional user budgets assume equal future request volume across team members and use the same importance multiplier.",
      "Importance changes allowance and quality preference, never the quality floor. Marking every request High can consume funds earlier.",
      "Calendar-only dates use noon UTC. Zero or exhausted company/user budgets reject requests, including free local runs.",
    ],
  };
}
