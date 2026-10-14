
import type {
    EvaluationAdapter,
    EvaluationRequest,
    EvaluationResult,
    EvaluationSystem,
  } from "./pipeline";
  
  export type PipelineExecution = Omit<
    EvaluationResult,
    "system" | "scenarioId" | "requestId" | "stateBefore" | "stateAfter"
  >;
  
  export type PipelineFunction = (
    request: EvaluationRequest,
  ) => Promise<PipelineExecution>;
  
  export class IntegratedEvaluationAdapter
    implements EvaluationAdapter
  {
    readonly name: EvaluationSystem;
  
    constructor(
      name: EvaluationSystem,
      private readonly pipeline: PipelineFunction,
    ) {
      this.name = name;
    }
  
    async execute(
      request: EvaluationRequest,
    ): Promise<EvaluationResult> {
      const output = await this.pipeline(request);
  
      if (output.generation.requestId !== request.id) {
        throw new Error(
          `Pipeline request ID mismatch: ${request.id}`,
        );
      }
  
      if (output.generation.router !== "litellm") {
        throw new Error(
          "Stage B/C must use LiteLLM for both systems.",
        );
      }
  
      if (
        output.generation.costUsd !== null &&
        (
          !Number.isFinite(output.generation.costUsd) ||
          output.generation.costUsd < 0
        )
      ) {
        throw new Error("Invalid generation cost.");
      }
  
      if (
        !Number.isFinite(output.generation.latencyMs) ||
        output.generation.latencyMs < 0
      ) {
        throw new Error("Invalid generation latency.");
      }
  
      return {
        system: this.name,
        scenarioId: request.scenarioId,
        requestId: request.id,
        generation: output.generation,
        policy: output.policy,
        stateBefore: { ...request.organizationState },
  
        // The evaluation runner calculates actual spending.
        stateAfter: null,
      };
    }
  }
  