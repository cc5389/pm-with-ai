import { BudgetTracker } from "../stage-c/budget";
import type { OrganizationState } from "./pipeline";

export interface SettledCost {
  costUsd: number;
  costBasis: "actual" | "estimated" | "none" | "unresolved";
}

/**
 * A known provider cost is kept, including when the returned model is rejected.
 * If the provider may have accepted the request and no cost came back, the
 * original reservation stays locked and is labeled unresolved.
 */
export function settleProviderCost(input: {
  reservedCostUsd: number;
  providerContacted: boolean;
  costUsd: number | null;
  costBasis: "actual" | "estimated" | "none" | "unknown";
}): SettledCost {
  if (!input.providerContacted) {
    return { costUsd: 0, costBasis: "none" };
  }
  if (
    input.costUsd !== null &&
    Number.isFinite(input.costUsd) &&
    input.costUsd >= 0 &&
    (input.costBasis === "actual" || input.costBasis === "estimated")
  ) {
    return { costUsd: input.costUsd, costBasis: input.costBasis };
  }
  if (!Number.isFinite(input.reservedCostUsd) || input.reservedCostUsd < 0) {
    throw new Error(
      "Cannot lock an unresolved provider attempt without a nonnegative reservation.",
    );
  }
  return { costUsd: input.reservedCostUsd, costBasis: "unresolved" };
}

/**
 * A second attempt is another full reservation. Refuse it when the provider
 * may already have charged, or when two reservations would exceed the budget.
 */
export function allowProviderRetry(options: {
  attempt: number;
  providerContacted: boolean;
  connectionError: boolean;
  remainingUsd: number;
  reservedUsd: number;
}): boolean {
  if (options.attempt !== 1) return false;
  if (options.providerContacted || !options.connectionError) return false;
  if (
    !Number.isFinite(options.remainingUsd) ||
    !Number.isFinite(options.reservedUsd) ||
    options.reservedUsd < 0
  ) {
    return false;
  }
  return options.reservedUsd * 2 <= options.remainingUsd + 1e-12;
}

/** The only budget mutation for one experiment request. Call it once. */
export function applyExperimentCost(
  tracker: BudgetTracker,
  cost: number | null,
) {
  if (cost === null || !Number.isFinite(cost) || cost < 0) {
    throw new Error(
      "Refusing to update the budget without one known nonnegative cost.",
    );
  }
  return tracker.recordCost(cost);
}

/** Stage B scenarios start from their own saved state and record one cost. */
export function accountIndependent(
  state: OrganizationState,
  cost: number | null,
): OrganizationState {
  const tracker = new BudgetTracker(state.budgetUsd, state.spentUsd);
  const after = applyExperimentCost(tracker, cost);
  return {
    ...state,
    spentUsd: after.spentUsd,
    budgetUsedFraction: after.budgetUsedFraction,
  };
}

export function unresolvedCostMessage(label: string): string {
  return (
    `Missing cost for ${label}. ` +
    "The attempt was saved and will not be retried automatically. " +
    "No reservation was available to lock, so the budget was not changed. " +
    "Mock output was not substituted. " +
    "Reconcile the gateway bill before continuing."
  );
}
