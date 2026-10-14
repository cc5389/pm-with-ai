
import type {
    EvaluationRequest,
    EvaluationResult,
  } from "../shared/pipeline";
  
  export interface ConstraintEvaluation {
    scenarioId: string;
    system: string;
  
    allowedModelCompliant: boolean | null;
    budgetFeasible: boolean | null;
    policyApplied: boolean | null;
  
    violations: string[];
  }
  
  export function evaluateConstraints(
    request: EvaluationRequest,
    result: EvaluationResult,
  ): ConstraintEvaluation {
    const violations: string[] = [];
  
    const selectedModel = result.generation.selectedModel;
    const cost = result.generation.costUsd;
  
    // Baseline has no policy-specific allowed-model list.
    let allowedModelCompliant: boolean | null = null;
  
    if (result.policy?.allowedModels !== null &&
        result.policy?.allowedModels !== undefined) {
      allowedModelCompliant =
        selectedModel !== null &&
        result.policy.allowedModels.includes(selectedModel);
  
      if (!allowedModelCompliant) {
        violations.push("Selected model is not in allowedModels");
      }
    }
  
    const remainingBudget =
      request.organizationState.budgetUsd -
      request.organizationState.spentUsd;
  
    const budgetFeasible =
      result.generation.success && cost !== null
        ? cost <= remainingBudget + 1e-9
        : null;
  
    if (budgetFeasible === false) {
      violations.push("Request cost exceeds remaining budget");
    }
  
    const policyApplied =
      result.system === "orchestra"
        ? result.policy?.applied ?? false
        : null;
  
    if (policyApplied === false) {
      violations.push("Orchestra policy was not applied");
    }
  
    return {
      scenarioId: request.scenarioId,
      system: result.system,
      allowedModelCompliant,
      budgetFeasible,
      policyApplied,
      violations,
    };
  }
  