import type { OrganizationState, TaskImportance } from "../shared/pipeline";

export interface BudgetSnapshot {
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  budgetUsedFraction: number;
  overspent: boolean;
}

export class BudgetTracker {
  private spentUsd: number;

  constructor(
    readonly budgetUsd: number,
    initialSpentUsd = 0,
  ) {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new Error("Budget must be a positive finite number.");
    }

    if (!Number.isFinite(initialSpentUsd) || initialSpentUsd < 0) {
      throw new Error("Initial spending must be nonnegative.");
    }

    this.spentUsd = initialSpentUsd;
  }

  snapshot(): BudgetSnapshot {
    const remainingUsd = this.budgetUsd - this.spentUsd;

    return {
      budgetUsd: this.budgetUsd,
      spentUsd: this.spentUsd,
      remainingUsd,
      budgetUsedFraction: this.spentUsd / this.budgetUsd,
      overspent: remainingUsd < -1e-9,
    };
  }

  organizationState(
    taskImportance: TaskImportance,
    qualityFloor: number,
  ): OrganizationState {
    const snapshot = this.snapshot();

    return {
      budgetUsd: snapshot.budgetUsd,
      spentUsd: snapshot.spentUsd,
      budgetUsedFraction: snapshot.budgetUsedFraction,
      taskImportance,
      qualityFloor,
    };
  }

  recordCost(costUsd: number): BudgetSnapshot {
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw new Error("Cost must be a nonnegative finite number.");
    }

    this.spentUsd += costUsd;

    return this.snapshot();
  }
}
