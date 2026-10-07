export type RouterName = "litellm" | "notdiamond";

export type TaskType = "coding" | "analysis" | "writing" | "qa";

/**
 * The exact same request is provided to every baseline router.
 */
export interface RouterRequest {
  id: string;
  prompt: string;
  task: TaskType;
  rubric: string;
}

/**
 * Standardized result returned by every router.
 *
 * Stage A compares routers, so router-specific API responses should
 * be converted into this common representation.
 */
export interface RouterResult {
  router: RouterName;
  requestId: string;

  success: boolean;

  // Routing decision
  selectedModel: string | null;
  provider?: string | null;

  // Actual generated response
  response: string | null;

  // Measured execution information
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;

  // Useful for diagnosing failures
  error: string | null;
}

/**
 * Every baseline router must implement this interface.
 */
export interface RouterAdapter {
  readonly name: RouterName;

  route(request: RouterRequest): Promise<RouterResult>;
}
