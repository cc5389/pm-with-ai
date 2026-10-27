import { resultsPath, type ExecutionMode } from "../shared/run-mode";
export const VARIANTS = [
  "baseline",
  "orchestra-fixed",
  "orchestra-inferred",
] as const;
export type Variant = (typeof VARIANTS)[number];
export function stageCConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const budgetUsd = Number(env.STAGE_C_BUDGET_USD ?? "0.10");
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0)
    throw new Error("STAGE_C_BUDGET_USD must be positive and finite.");
  const variant = env.STAGE_C_VARIANT ?? "all";
  if (variant !== "all" && !VARIANTS.includes(variant as Variant))
    throw new Error("Invalid STAGE_C_VARIANT");
  const runId = env.STAGE_C_RUN_ID ?? "default";
  if (!/^[a-zA-Z0-9_-]+$/.test(runId))
    throw new Error("Invalid STAGE_C_RUN_ID");
  return { budgetUsd, variant, runId };
}
export function stageCPath(
  mode: ExecutionMode,
  kind: "results" | "judgments" | "report" = "results",
) {
  const c = stageCConfig();
  return resultsPath("stage-c", mode, undefined, kind).replace(
    `-${kind}.json`,
    `-v2-budget-${c.budgetUsd}-${c.variant}-${c.runId}-${kind}.json`,
  );
}
