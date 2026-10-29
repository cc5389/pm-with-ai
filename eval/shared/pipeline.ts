import type { RouterRequest, RouterResult } from "../stage-a/adapters/base";

export type EvaluationSystem = "baseline" | "orchestra";

export type TaskImportance = "low" | "medium" | "high";

export interface OrganizationState {
  budgetUsd: number;
  spentUsd: number;
  budgetUsedFraction: number;
  taskImportance: TaskImportance;
  qualityFloor: number;
}

export interface EvaluationRequest extends RouterRequest {
  scenarioId: string;
  importanceMode?: "fixed" | "inferred";
  organizationState: OrganizationState;
}

export interface EvaluationResult {
  taskCategory?: string;
  system: EvaluationSystem;
  scenarioId: string;
  requestId: string;

  // Reuse the standardized Stage A response.
  generation: RouterResult;

  // Policy information supplied by the integrated pipeline.
  policy: {
    predictedQuality?: number | null;
    requestedModel?: string | null;
    /** Frozen before transport; baseline selection becomes known only after LiteLLM responds. */
    qualitySnapshot?: { model: string; quality: number }[];
    predictionTiming?:
      "before-generation" | "pre-generation-snapshot-post-gateway-selection";
    requestAllowanceUsd?: number;
    candidates?: {
      model: string;
      estimatedCost: number;
      estimatedQuality: number;
      eligible: boolean;
      reasons: string[];
    }[];
    classification?: import("../../lib/classification").TaskClassification;
    applied: boolean;
    allowedModels: string[] | null;
    reason: string | null;
  } | null;

  // Organization state at the time of the request.
  stateBefore: OrganizationState;
  stateAfter: OrganizationState | null;
}

export interface EvaluationAdapter {
  readonly name: EvaluationSystem;

  execute(request: EvaluationRequest): Promise<EvaluationResult>;
}
