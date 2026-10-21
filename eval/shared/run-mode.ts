import { activePool, type ModelPool } from "./model-pool";

export type ExecutionMode = "mock" | "real";

type ExecutionEnv = {
  EVAL_EXECUTION?: string;
  EVAL_LIMIT?: string;
  [key: string]: string | undefined;
};

export function executionMode(
  env: ExecutionEnv = process.env,
): ExecutionMode {
  const value = env.EVAL_EXECUTION ?? "mock";
  if (value !== "mock" && value !== "real") {
    throw new Error('EVAL_EXECUTION must be "mock" or "real".');
  }
  return value;
}

export function executionLimit(env: ExecutionEnv = process.env): number | null {
  const raw = env.EVAL_LIMIT;
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("EVAL_LIMIT must be a positive integer.");
  }
  return value;
}

export function assertPaidRunIsExplicit(
  mode: ExecutionMode,
  limit: number | null,
  pool: ModelPool = activePool(),
): void {
  // A shadow-priced local pool cannot incur provider charges.
  if (pool.shadowPriced) return;
  if (mode === "real" && limit === null) {
    throw new Error(
      "Real LiteLLM execution is opt-in. Set EVAL_LIMIT to the number of requests each system should run (use 1 for a smoke test). Refusing to start an unbounded paid run.",
    );
  }
}

/** Real runs of a non-default pool get their own files so pools never mix. */
export function resultsPath(
  stage: "stage-b" | "stage-c",
  mode: ExecutionMode,
  pool: ModelPool = activePool(),
  kind: "results" | "judgments" | "constraints" = "results",
): string {
  const label = mode === "real" && pool.id !== "openai" ? `real-${pool.id}` : mode;
  return `eval/results/${stage}/${label}-${kind}.json`;
}
