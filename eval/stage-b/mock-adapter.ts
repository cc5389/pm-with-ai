
import type {
    EvaluationAdapter,
    EvaluationRequest,
    EvaluationResult,
    EvaluationSystem,
  } from "../shared/pipeline";
  
  export class MockEvaluationAdapter implements EvaluationAdapter {
    readonly name: EvaluationSystem;
  
    constructor(name: EvaluationSystem) {
      this.name = name;
    }
  
    async execute(request: EvaluationRequest): Promise<EvaluationResult> {
      const state = request.organizationState;
  
      return {
        system: this.name,
        scenarioId: request.scenarioId,
        requestId: request.id,
        generation: {
          router: "litellm",
          requestId: request.id,
          success: true,
          selectedModel: "gpt-4.1-mini-2025-04-14",
          response: "Mock response for evaluation testing.",
          latencyMs: 100,
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.001,
          error: null,
        },
        policy: this.name === "orchestra"
          ? {
              applied: true,
              allowedModels: ["gpt-4.1-mini-2025-04-14"],
              reason: "Mock policy decision",
            }
          : null,
        stateBefore: { ...state },
        stateAfter: null,
      };
    }
  }
  