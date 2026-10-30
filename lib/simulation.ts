import type { RequestInput, Candidate } from "./types";

/** Simulation never contacts a model or incurs an API charge. */
export function simulate(input: RequestInput, selected: Candidate) {
  return {
    simulatedCost: selected.estimatedCost,
    simulatedLatency: selected.estimatedLatency,
    inputTokens: selected.inputTokens,
    outputTokens: selected.outputTokens,
    response: `SIMULATED EXECUTION — no language model was called.\n\n${selected.model.name} was selected for your ${input.task} request.\n\nRequest: ${input.prompt}\n\nThis placeholder demonstrates the routing workflow; it is not an answer to your prompt. The simulation assumes ${selected.outputTokens} output tokens, ${selected.estimatedLatency.toFixed(1)} seconds, and an illustrative quality score of ${(selected.estimatedQuality * 100).toFixed(0)}%.\n\nThe simulated ledger was updated by $${selected.estimatedCost.toFixed(6)}. Actual API charges: $0. Configure local inference to generate a real answer without a paid API.`,
  };
}
