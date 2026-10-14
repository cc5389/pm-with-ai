
import type {
    EvaluationResult,
    EvaluationSystem,
  } from "../shared/pipeline";
  import type { WorkloadItem } from "./workload";
  import { BudgetTracker } from "./budget";
  
  export interface StageCRecord {
    sequenceIndex: number;
    result: EvaluationResult;
  }
  
  const EPSILON = 1e-8;
  
  function closeEnough(a: number, b: number): boolean {
    return Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(a - b) <= EPSILON;
  }
  
  export function restoreCheckpoint(
    system: EvaluationSystem,
    records: StageCRecord[],
    workload: WorkloadItem[],
    budgetUsd: number,
  ): BudgetTracker {
    const tracker = new BudgetTracker(budgetUsd);
  
    if (records.length > workload.length) {
      throw new Error(`${system}: checkpoint exceeds workload length`);
    }
  
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const result = record.result;
      const item = workload[i];
  
      if (record.sequenceIndex !== i) {
        throw new Error(`${system}: invalid sequence at index ${i}`);
      }
  
      if (
        result.system !== system ||
        result.requestId !== item.id ||
        result.scenarioId !== `stage-c-${system}-${i + 1}`
      ) {
        throw new Error(`${system}: request identity mismatch at ${i}`);
      }
  
      const before = result.stateBefore;
      const expectedBefore = tracker.organizationState(
        item.taskImportance,
        item.qualityFloor,
      );
  
      if (
        !closeEnough(before.budgetUsd, expectedBefore.budgetUsd) ||
        !closeEnough(before.spentUsd, expectedBefore.spentUsd) ||
        !closeEnough(
          before.budgetUsedFraction,
          expectedBefore.budgetUsedFraction,
        ) ||
        before.taskImportance !== expectedBefore.taskImportance ||
        !closeEnough(before.qualityFloor, expectedBefore.qualityFloor)
      ) {
        throw new Error(`${system}: invalid stateBefore at ${i}`);
      }
  
      const cost = result.generation.costUsd;
  
      if (
        cost === null ||
        !Number.isFinite(cost) ||
        cost < 0
      ) {
        throw new Error(`${system}: invalid generation cost at ${i}`);
      }
  
      const expectedAfter = tracker.recordCost(cost);
      const after = result.stateAfter;
  
      if (
        after === null ||
        !closeEnough(after.budgetUsd, expectedAfter.budgetUsd) ||
        !closeEnough(after.spentUsd, expectedAfter.spentUsd) ||
        !closeEnough(
          after.budgetUsedFraction,
          expectedAfter.budgetUsedFraction,
        ) ||
        after.taskImportance !== expectedBefore.taskImportance ||
        !closeEnough(after.qualityFloor, expectedBefore.qualityFloor)
      ) {
        throw new Error(`${system}: invalid stateAfter at ${i}`);
      }
    }
  
    return tracker;
  }
  