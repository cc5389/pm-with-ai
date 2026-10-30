import { classifyTask } from "./classification";
import { buildPreview } from "./engine";
import type {
  RequestInput,
  Settings,
  ModelProfile,
  BudgetContext,
} from "./types";

/** Shared by the local server and browser-only public simulation. */
export function resolvedPreview(
  input: RequestInput,
  settings: Settings,
  models: ModelProfile[],
  context: BudgetContext,
) {
  const classification =
    input.importanceMode === "inferred"
      ? classifyTask(input.prompt)
      : undefined;
  const resolved = classification
    ? {
        ...input,
        importance: classification.importance,
        importanceMode: "fixed" as const,
      }
    : input;
  const result = buildPreview(resolved, settings, models, context);
  if (classification) result.classification = classification;
  if (!result.selected) {
    const reasons = [
      ...new Set(
        result.candidates
          .filter((candidate) =>
            input.mode === "gateway"
              ? candidate.model.gateway
              : !candidate.model.gateway &&
                candidate.model.local === (input.mode === "local"),
          )
          .flatMap((candidate) => candidate.reasons),
      ),
    ];
    result.rejectionReason = `No model meets the current policy (${result.policy.importance} importance, ${Math.round(result.policy.qualityFloor * 100)}% quality floor, $${result.policy.maxCostPerRequest.toFixed(6)} request allowance). ${reasons.join(" ") || "No models are available in this execution mode."} Review the budget or request guardrails.`;
  }
  return result;
}
